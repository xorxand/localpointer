/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { activeEditorContext, getConfig, resolveModelName, setLastTransparency, workspaceFolderPath } from './config';
import { getActiveModel } from './lmProvider';
import { DaemonSSEEvent } from './daemon';

export class ChatParticipantService implements vscode.Disposable {
	private participant: vscode.ChatParticipant | undefined;

	constructor(
		private readonly daemonManager: DaemonManager,
		private readonly ollama: OllamaClient,
	) { }

	register(): void {
		this.participant = vscode.chat.createChatParticipant('localpointer.agent', async (request, _context, stream, token) => {
			const cfg = getConfig();
			const editorCtx = activeEditorContext();
			const wsPath = workspaceFolderPath();
			let model = cfg.model;
			try {
				model = await resolveModelName(() => this.ollama.listModels(), cfg.model);
			} catch (err) {
				stream.markdown(`**Error:** ${String(err)}`);
				return;
			}

			const controller = new AbortController();
			const sub = token.onCancellationRequested(() => controller.abort());
			let full = '';
			let stats: Record<string, unknown> | undefined;
			let trace: unknown[] | undefined;

			try {
				const daemon = await this.daemonManager.ensureRunning();
				const health = await daemon.health();
				if (health.ok && wsPath) {
					const workspaceId = await daemon.ensureWorkspace(wsPath);
					await daemon.chat({
						workspace_id: workspaceId,
						message: request.prompt,
						model,
						active_file: editorCtx.activeFile,
						selection: editorCtx.selection,
						auto_approve: cfg.autoApprove,
					}, async (event: DaemonSSEEvent) => {
						await handleDaemonEvent(event, stream, daemon, cfg.autoApprove);
						if (event.token) {
							full += event.token;
						}
						if (event.stats) {
							stats = event.stats;
						}
						if (event.trace) {
							trace = event.trace;
						}
						if (event.error) {
							throw new Error(event.error);
						}
					}, controller.signal);
				} else {
					await this.streamOllamaFallback(request.prompt, model, stream, controller.signal, chunk => {
						full += chunk;
					});
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					await this.streamOllamaFallback(request.prompt, model, stream, controller.signal, chunk => {
						full += chunk;
					});
					if (!full) {
						stream.markdown(`**Error:** ${String(err)}`);
					}
				}
			} finally {
				sub.dispose();
				setLastTransparency({
					model,
					stats,
					trace,
					source: 'chatParticipant',
				});
			}

			return { metadata: { model, stats, trace } };
		});
	}

	private async streamOllamaFallback(
		prompt: string,
		model: string,
		stream: vscode.ChatResponseStream,
		signal: AbortSignal,
		onToken: (t: string) => void,
	): Promise<void> {
		await this.ollama.streamChat(model, [{ role: 'user', content: prompt }], async token => {
			onToken(token);
			stream.markdown(token);
		}, signal);
	}

	dispose(): void {
		this.participant?.dispose();
	}
}

async function handleDaemonEvent(
	event: DaemonSSEEvent,
	stream: vscode.ChatResponseStream,
	daemon: import('./daemon').DaemonClient,
	autoApprove: boolean,
): Promise<void> {
	if (event.token) {
		stream.markdown(event.token);
	}
	if (event.status === 'approval_required' && event.id && event.tool) {
		if (autoApprove) {
			await daemon.approve(event.id, 'allow');
			stream.markdown(`\n\n*Auto-approved tool: ${event.tool}*\n`);
			return;
		}
		const argsPreview = event.args ? `\n\`\`\`json\n${JSON.stringify(event.args, null, 2)}\n\`\`\`` : '';
		const choice = await vscode.window.showWarningMessage(
			`Allow agent tool "${event.tool}"?`,
			{ modal: true, detail: argsPreview },
			'Allow',
			'Deny',
		);
		await daemon.approve(event.id, choice === 'Allow' ? 'allow' : 'deny');
		stream.markdown(`\n\n*Tool ${event.tool}: ${choice === 'Allow' ? 'allowed' : 'denied'}*\n`);
	}
	if (event.trace && event.done) {
		stream.markdown(`\n\n---\n**Trace:** ${event.trace.length} step(s)\n`);
	}
}

export class AgentEditService {
	constructor(
		private readonly daemonManager: DaemonManager,
		private readonly ollama: OllamaClient,
	) { }

	async run(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open a file to use agent edit.');
			return;
		}
		const instruction = await vscode.window.showInputBox({
			title: 'Agent edit instruction',
			placeHolder: 'Describe the change for the whole file or selection…',
		});
		if (!instruction) {
			return;
		}
		const doc = editor.document;
		const selection = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
		const model = await getActiveModel(this.ollama);
		const prompt = `Edit the following ${editor.selection.isEmpty ? 'file' : 'selection'} according to this instruction: ${instruction}\n\n\`\`\`${doc.languageId}\n${selection}\n\`\`\`\n\nReturn only the edited code.`;

		try {
			const daemon = await this.daemonManager.ensureRunning();
			if ((await daemon.health()).ok) {
				const wsPath = workspaceFolderPath();
				const wsId = wsPath ? await daemon.ensureWorkspace(wsPath) : undefined;
				const result = await daemon.inlineEdit({
					workspace_id: wsId,
					model,
					instruction,
					file_path: vscode.workspace.asRelativePath(doc.uri),
					language: doc.languageId,
					selection,
				});
				await applyTextEdit(editor, result.text);
				setLastTransparency({ model: result.model ?? model, stats: result.stats, source: 'agentEdit' });
				return;
			}
		} catch {
			// fallback below
		}

		const edited = await this.ollama.chat(model, [
			{ role: 'system', content: 'Return only edited code without markdown fences.' },
			{ role: 'user', content: prompt },
		]);
		await applyTextEdit(editor, stripFences(edited));
		setLastTransparency({ model, source: 'agentEdit-ollama' });
	}
}

async function applyTextEdit(editor: vscode.TextEditor, text: string): Promise<void> {
	const range = editor.selection.isEmpty
		? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length))
		: editor.selection;
	const ok = await editor.edit(builder => builder.replace(range, text));
	if (!ok) {
		vscode.window.showErrorMessage('Failed to apply agent edit.');
	}
}

function stripFences(text: string): string {
	const trimmed = text.trim();
	const m = /^```[\w]*\n([\s\S]*?)\n```$/.exec(trimmed);
	return m ? m[1] : trimmed;
}
