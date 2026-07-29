/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { activeEditorContext, getConfig, resolveRequestModel, setLastTransparency, workspaceFolderPath } from './config';
import { getActiveModel } from './lmProvider';
import { DaemonSSEEvent } from './daemon';
import { ToolActivityCollector } from './toolActivity';

const TOOL_THINKING_ID = 'localpointer-tools';
const MODEL_THINKING_ID = 'localpointer-thinking';

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
			let model = '';
			try {
				const resolved = await resolveRequestModel(this.ollama, {
					configured: request.model.id || cfg.model,
					prompt: request.prompt,
				});
				model = resolved.model;
				if (resolved.routedFromAuto) {
					stream.markdown(`_LocalPointer Auto → **${model}**` +
						(resolved.complexity ? ` · ${resolved.complexity}` : '') +
						`_\n\n`);
				} else {
					stream.markdown(`_LocalPointer · ${model}_\n\n`);
				}
			} catch (err) {
				stream.markdown(`**Error:** ${String(err)}`);
				return;
			}

			if (!model) {
				stream.markdown('**Error:** No Ollama models found. Run `ollama pull qwen2.5:7b` (or similar), then retry.');
				return;
			}

			const controller = new AbortController();
			const sub = token.onCancellationRequested(() => controller.abort());
			let full = '';
			let stats: Record<string, unknown> | undefined;
			let trace: unknown[] | undefined;
			const tools = new ToolActivityCollector();

			try {
				const approvalState = { autoApprove: shouldAutoApproveTools(request, cfg.autoApprove) };
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
						auto_approve: approvalState.autoApprove,
					}, async (event: DaemonSSEEvent) => {
						await handleDaemonEvent(event, stream, daemon, approvalState, tools);
						if (event.token) {
							full += event.token;
						}
						if (event.stats) {
							stats = event.stats;
						}
						if (event.trace) {
							trace = event.trace;
						}
						if (event.error && !isToolStatus(event.status)) {
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

		try {
			const ext = vscode.extensions.getExtension('localpointer.localpointer-ai');
			if (ext) {
				this.participant.iconPath = vscode.Uri.joinPath(ext.extensionUri, 'media', 'icon.svg');
			}
		} catch {
			// optional icon
		}
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
		}, signal, token => {
			stream.thinkingProgress({
				id: MODEL_THINKING_ID,
				text: token,
				metadata: { title: 'Thinking' },
			});
		});
	}

	dispose(): void {
		this.participant?.dispose();
	}
}

function isToolStatus(status: string | undefined): boolean {
	return status === 'tool_call'
		|| status === 'tool_result'
		|| status === 'tool_error'
		|| status === 'tool_denied'
		|| status === 'approved'
		|| status === 'approval_required'
		|| status === 'file_changed';
}

/** Map chat input permission picker (Ask / Allow all) to daemon auto_approve. */
function shouldAutoApproveTools(request: vscode.ChatRequest, configAutoApprove: boolean): boolean {
	const level = request.permissionLevel;
	if (level === 'autoApprove' || level === 'autopilot') {
		return true;
	}
	if (level === 'default' || level === 'assisted') {
		return false;
	}
	return configAutoApprove;
}

function toolApprovalDecision(answers: Record<string, unknown> | undefined): 'allow' | 'deny' | 'runAll' {
	const raw = answers?.decision;
	let value: unknown = raw;
	if (raw && typeof raw === 'object' && 'selectedValue' in raw) {
		value = (raw as { selectedValue?: unknown }).selectedValue;
	}
	if (value === 'allow') {
		return 'allow';
	}
	if (value === 'runAll') {
		return 'runAll';
	}
	return 'deny';
}

async function enableRunEverythingMode(): Promise<void> {
	await vscode.workspace.getConfiguration('localpointer').update('autoApprove', true, vscode.ConfigurationTarget.Global);
	try {
		await vscode.commands.executeCommand('workbench.action.chat.openPermissionPicker', true);
	} catch {
		// Toggle may be unavailable outside the panel chat surface.
	}
}

function emitToolActivity(stream: vscode.ChatResponseStream, tools: ToolActivityCollector, event: DaemonSSEEvent): void {
	const entry = tools.consume(event);
	if (!entry) {
		return;
	}
	stream.thinkingProgress({
		id: TOOL_THINKING_ID,
		text: entry.text,
		metadata: { title: tools.summaryLabel() },
	});
}

async function handleDaemonEvent(
	event: DaemonSSEEvent,
	stream: vscode.ChatResponseStream,
	daemon: import('./daemon').DaemonClient,
	approvalState: { autoApprove: boolean },
	tools: ToolActivityCollector,
): Promise<void> {
	if (event.token) {
		stream.markdown(event.token);
	}
	if (event.thinking) {
		stream.thinkingProgress({
			id: MODEL_THINKING_ID,
			text: event.thinking,
			metadata: { title: 'Thinking' },
		});
	}

	emitToolActivity(stream, tools, event);

	if (event.status === 'approval_required' && event.id && event.tool) {
		if (approvalState.autoApprove) {
			await daemon.approve(event.id, 'allow');
			return;
		}
		const argsPreview = event.args
			? new vscode.MarkdownString(`\`\`\`json\n${JSON.stringify(event.args, null, 2)}\n\`\`\``)
			: undefined;
		const answers = await stream.questionCarousel([
			new vscode.ChatQuestion(
				'decision',
				vscode.ChatQuestionType.SingleSelect,
				`Allow tool \`${event.tool}\`?`,
				{
					message: argsPreview,
					options: [
						{ id: 'allow', label: 'Allow', value: 'allow' },
						{ id: 'deny', label: 'Deny', value: 'deny' },
						{ id: 'runAll', label: 'Run all', value: 'runAll' },
					],
					defaultValue: 'allow',
					allowFreeformInput: false,
				},
			),
		], false);
		const decision = toolApprovalDecision(answers);
		if (decision === 'runAll') {
			approvalState.autoApprove = true;
			await enableRunEverythingMode();
			await daemon.approve(event.id, 'allow');
			stream.thinkingProgress({
				id: TOOL_THINKING_ID,
				text: `*Run everything on — further tools will not ask*\n\n`,
				metadata: { title: tools.summaryLabel() },
			});
			return;
		}
		await daemon.approve(event.id, decision);
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
	const full = editor.selection.isEmpty
		? new vscode.Range(0, 0, editor.document.lineCount, 0)
		: editor.selection;
	await editor.edit(b => b.replace(full, text));
}

function stripFences(text: string): string {
	return text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
}
