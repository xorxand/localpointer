/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { getConfig, resolveRequestModel, setLastTransparency, workspaceFolderPath } from './config';
import { DaemonSSEEvent } from './daemon';
import { ToolActivityCollector } from './toolActivity';
import { AUTO_MODEL_ID, isAutoModelId } from './autoRouter';

interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	thinking?: string;
	activity?: {
		summary: string;
		entries: string[];
	};
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'localpointer.chatView';

	private view: vscode.WebviewView | undefined;
	private conversationId: number | undefined;
	private readonly messages: ChatMessage[] = [];
	/** Model selected for this chat panel (not necessarily the global setting). */
	private selectedModel = '';
	/** Mirrors Ask / Allow all control (synced with localpointer.autoApprove). */
	private autoApproveTools = false;
	private sending = false;
	private sendGen = 0;
	private abort: AbortController | undefined;
	private messageSub: vscode.Disposable | undefined;
	/** Resolvers waiting on inline Allow/Deny for daemon tool approvals. */
	private readonly pendingApprovals = new Map<string, (result: { allow: boolean; runAll: boolean }) => void>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly daemonManager: DaemonManager,
		_ollama: OllamaClient,
	) {
		void _ollama;
	}

	private ollama(): OllamaClient {
		return new OllamaClient(getConfig().ollamaUrl);
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		// Remount / re-show must not leave a stuck "sending" lock from a prior view.
		this.abortInFlight('Chat panel reloaded');
		this.sending = false;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		this.messageSub?.dispose();
		this.messageSub = webviewView.webview.onDidReceiveMessage(async msg => {
			try {
				switch (msg?.type) {
					case 'ready':
					case 'refreshModels':
						await this.postInit();
						break;
					case 'send':
						await this.handleSend(String(msg.text ?? ''), msg.model ? String(msg.model) : undefined);
						break;
					case 'selectModel':
						this.selectModel(String(msg.model ?? ''));
						break;
					case 'setApprovalMode': {
						const allowAll = String(msg.mode ?? '') === 'allowAll';
						this.autoApproveTools = allowAll;
						void vscode.workspace.getConfiguration('localpointer').update(
							'autoApprove',
							allowAll,
							vscode.ConfigurationTarget.Global,
						);
						this.postStatus(allowAll ? 'Tools: Run everything on' : 'Tools: Ask before each tool');
						break;
					}
					case 'approve': {
						const id = String(msg.id ?? '');
						const allow = msg.allow === true;
						const runAll = msg.runAll === true;
						const resolve = this.pendingApprovals.get(id);
						if (resolve) {
							this.pendingApprovals.delete(id);
							resolve({ allow, runAll });
						}
						break;
					}
					case 'clear':
						this.rejectPendingApprovals();
						this.abortInFlight();
						this.messages.length = 0;
						this.conversationId = undefined;
						this.postMessage({ type: 'messages', messages: [] });
						this.postStatus('Chat cleared');
						break;
				}
			} catch (err) {
				this.postStatus(`Error: ${String(err)}`);
				this.postMessage({ type: 'streaming', active: false });
				this.postMessage({ type: 'sendRejected', reason: String(err) });
				this.sending = false;
			}
		});

		webviewView.onDidDispose(() => {
			this.messageSub?.dispose();
			this.messageSub = undefined;
			if (this.view === webviewView) {
				this.view = undefined;
			}
			this.abortInFlight();
		});
	}

	focus(): void {
		if (this.view) {
			this.view.show?.(true);
		} else {
			void vscode.commands.executeCommand('localpointer.chatView.focus');
		}
	}

	private abortInFlight(status?: string): void {
		this.sendGen++;
		this.rejectPendingApprovals();
		if (this.abort) {
			this.abort.abort();
			this.abort = undefined;
		}
		this.sending = false;
		this.postMessage({ type: 'streaming', active: false });
		if (status) {
			this.postMessage({ type: 'reset', text: status });
		}
	}

	private rejectPendingApprovals(): void {
		for (const [id, resolve] of this.pendingApprovals) {
			resolve({ allow: false, runAll: false });
			this.pendingApprovals.delete(id);
		}
	}

	private waitForInlineApproval(id: string): Promise<{ allow: boolean; runAll: boolean }> {
		return new Promise(resolve => {
			this.pendingApprovals.set(id, resolve);
		});
	}

	private async postInit(): Promise<void> {
		const ollama = this.ollama();
		const ollamaOk = await ollama.health();
		let models: string[] = [];
		let error = '';
		try {
			models = await this.safeListModels();
		} catch (err) {
			error = String(err);
		}

		const localModelCount = models.length;
		models = [AUTO_MODEL_ID, ...models.filter(model => !isAutoModelId(model))];
		if (!this.selectedModel || !models.includes(this.selectedModel)) {
			const configured = getConfig().model.trim();
			this.selectedModel = configured && models.includes(configured) ? configured : AUTO_MODEL_ID;
		}

		this.autoApproveTools = getConfig().autoApprove;

		this.postMessage({
			type: 'init',
			models,
			model: this.selectedModel,
			approvalMode: this.autoApproveTools ? 'allowAll' : 'ask',
			messages: this.messages,
			ollamaOk,
			ollamaUrl: getConfig().ollamaUrl,
			error,
		});
		if (!ollamaOk) {
			this.postStatus(`Ollama unreachable at ${getConfig().ollamaUrl}`);
		} else if (localModelCount === 0) {
			this.postStatus('No models found. Run: ollama pull qwen2.5:7b');
		} else {
			this.postStatus(`Ready · ${localModelCount} local model(s)`);
		}
	}

	private async handleSend(text: string, modelFromUi?: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt) {
			this.postMessage({ type: 'sendRejected', reason: 'Empty message' });
			return;
		}
		if (!this.view) {
			this.postMessage({ type: 'sendRejected', reason: 'Chat panel is not ready — reopen LocalPointer Chat' });
			return;
		}
		if (this.sending) {
			this.postMessage({ type: 'sendRejected', reason: 'Already generating a reply — wait or Clear to cancel' });
			return;
		}

		if (modelFromUi?.trim()) {
			this.selectedModel = modelFromUi.trim();
		}

		if (!this.selectedModel) {
			await this.postInit();
			if (!this.selectedModel) {
				this.postMessage({ type: 'sendRejected', reason: 'Pick a model first (or pull one with ollama).' });
				return;
			}
		}

		const gen = this.sendGen;
		this.sending = true;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		this.postMessage({ type: 'sendAccepted' });

		this.messages.push({ role: 'user', content: prompt });
		this.postMessage({ type: 'messages', messages: this.messages });
		this.postMessage({ type: 'streaming', active: true, model: this.selectedModel });
		this.postStatus(`Talking to ${this.selectedModel}…`);

		let model = this.selectedModel;
		let assistant = '';
		let assistantThinking = '';
		let stats: Record<string, unknown> | undefined;
		let trace: unknown[] | undefined;
		let assistantActivity: { summary: string; entries: string[] } | undefined;

		try {
			const ollamaOk = await this.ollama().health();
			if (!ollamaOk) {
				throw new Error(`Ollama is not reachable at ${getConfig().ollamaUrl}`);
			}
			if (signal.aborted || gen !== this.sendGen) {
				throw new Error('Cancelled');
			}

			const resolved = await resolveRequestModel(this.ollama(), {
				configured: this.selectedModel,
				prompt,
				signal,
			});
			model = resolved.model;
			if (resolved.routedFromAuto) {
				const note = `Auto selected ${model}${resolved.complexity ? ` for a ${resolved.complexity} request` : ''}.`;
				assistantThinking += `${note}\n\n`;
				this.postMessage({ type: 'thinkingToken', token: `${note}\n\n` });
				this.postMessage({ type: 'resolvedModel', model });
				this.postStatus(`Auto selected ${model}`);
			}

			if (workspaceFolderPath()) {
				const result = await this.agentChat(prompt, model);
				assistant = result.content;
				assistantThinking += result.thinking ?? '';
				stats = result.stats;
				trace = result.trace;
				this.conversationId = result.conversationId ?? this.conversationId;
				if (result.activity?.entries.length) {
					assistantActivity = result.activity;
				}
			} else {
				const history = this.messages
					.filter(m => m.role === 'user' || m.role === 'assistant')
					.slice(0, -1)
					.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
				const result = await this.ollama().streamChat(
					model,
					[
						{
							role: 'system',
							content: 'You are LocalPointer, a coding assistant running entirely on the user\'s local Ollama models. Be concise and helpful.',
						},
						...history,
						{ role: 'user', content: prompt },
					],
					token => {
						if (gen !== this.sendGen) {
							return;
						}
						assistant += token;
						this.postMessage({ type: 'streamToken', token });
					},
					signal,
					token => {
						if (gen !== this.sendGen) {
							return;
						}
						assistantThinking += token;
						this.postMessage({ type: 'thinkingToken', token });
					},
				);
				assistant = result.content || assistant;
				stats = {
					prompt_tokens: result.stats.prompt_eval_count,
					completion_tokens: result.stats.eval_count,
					total_ms: result.stats.total_duration ? Math.round(result.stats.total_duration / 1e6) : undefined,
					load_ms: result.stats.load_duration ? Math.round(result.stats.load_duration / 1e6) : undefined,
				};
			}

			if (!assistant.trim()) {
				assistant = '(empty response from model)';
			}
		} catch (err) {
			const msg = String(err);
			assistant = signal.aborted || gen !== this.sendGen ? '(cancelled)' : `Error: ${msg}`;
			if (gen === this.sendGen) {
				this.postStatus(assistant);
			}
		}

		// Cleared / remounted while in flight — do not clobber the new panel state.
		if (gen !== this.sendGen) {
			this.abort = undefined;
			this.sending = false;
			return;
		}

		this.messages.push({
			role: 'assistant',
			content: assistant,
			thinking: assistantThinking.trim() || undefined,
			activity: assistantActivity,
		});
		setLastTransparency({ model, stats, trace, source: 'chatView' });
		this.postMessage({ type: 'messages', messages: this.messages });
		this.postMessage({ type: 'streaming', active: false });
		if (!assistant.startsWith('Error:') && assistant !== '(cancelled)') {
			this.postStatus(`Done · ${model}`);
		}
		this.abort = undefined;
		this.sending = false;
	}

	private async agentChat(
		prompt: string,
		model: string,
	): Promise<{
		content: string;
		stats?: Record<string, unknown>;
		trace?: unknown[];
		conversationId?: number;
		thinking?: string;
		activity?: { summary: string; entries: string[] };
	}> {
		const daemon = await this.daemonManager.ensureRunning();
		const wsPath = workspaceFolderPath();
		const healthy = (await daemon.health()).ok;

		// No workspace or daemon → plain Ollama chat (still local).
		if (!healthy || !wsPath) {
			this.postStatus(!wsPath
				? 'No folder open — using direct Ollama (no tools)'
				: 'Daemon unavailable — using direct Ollama');
			const history = this.messages
				.filter(m => m.role === 'user' || m.role === 'assistant')
				.slice(0, -1)
				.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
			const result = await this.ollama().streamChat(
				model,
				[...history, { role: 'user', content: prompt }],
				token => this.postMessage({ type: 'streamToken', token }),
				this.abort?.signal,
				token => this.postMessage({ type: 'thinkingToken', token }),
			);
			return {
				content: result.content,
				thinking: result.thinking,
				stats: result.stats as Record<string, unknown>,
			};
		}

		const workspaceId = await daemon.ensureWorkspace(wsPath);
		let content = '';
		let stats: Record<string, unknown> | undefined;
		let trace: unknown[] | undefined;
		let conversationId: number | undefined;
		let thinking = '';
		const tools = new ToolActivityCollector();

		await daemon.chat({
			workspace_id: workspaceId,
			conversation_id: this.conversationId,
			message: prompt,
			model,
			auto_approve: this.autoApproveTools,
		}, async (event: DaemonSSEEvent) => {
			if (event.conversation_id) {
				conversationId = event.conversation_id;
			}
			if (event.token) {
				content += event.token;
				this.postMessage({ type: 'streamToken', token: event.token });
			}
			if (event.thinking) {
				thinking += event.thinking;
				this.postMessage({ type: 'thinkingToken', token: event.thinking });
			}
			if (event.stats) {
				stats = event.stats;
			}
			if (event.trace) {
				trace = event.trace;
			}
			const activity = tools.consume(event);
			if (activity) {
				this.postMessage({
					type: 'toolActivity',
					text: activity.text,
					summary: tools.summaryLabel(),
					toolCount: tools.count,
				});
			}
			if (event.status === 'approval_required' && event.id && event.tool) {
				if (this.autoApproveTools) {
					await daemon.approve(event.id, 'allow');
				} else {
					this.postMessage({
						type: 'approval',
						id: event.id,
						tool: event.tool,
						args: event.args ?? {},
					});
					const choice = await this.waitForInlineApproval(event.id);
					this.postMessage({ type: 'approvalResolved', id: event.id });
					if (choice.runAll) {
						this.autoApproveTools = true;
						void vscode.workspace.getConfiguration('localpointer').update(
							'autoApprove',
							true,
							vscode.ConfigurationTarget.Global,
						);
						this.postMessage({ type: 'approvalMode', mode: 'allowAll' });
						this.postStatus('Tools: Run everything on');
						const modeActivity = tools.addNote('Run everything enabled — further tools will not ask');
						this.postMessage({
							type: 'toolActivity',
							text: modeActivity.text,
							summary: tools.summaryLabel(),
							toolCount: tools.count,
						});
					}
					await daemon.approve(event.id, choice.allow || choice.runAll ? 'allow' : 'deny');
				}
			}
			if (event.error && !isToolStatus(event.status)) {
				throw new Error(event.error);
			}
		});

		return {
			content,
			thinking,
			stats,
			trace,
			conversationId,
			activity: {
				summary: tools.summaryLabel(),
				entries: [...tools.entries],
			},
		};
	}

	private selectModel(model: string): void {
		const name = model.trim();
		if (!name) {
			return;
		}
		this.selectedModel = name;
		// Persist as the user's default for new panels / other features.
		void vscode.workspace.getConfiguration('localpointer').update('model', name, vscode.ConfigurationTarget.Global);
		this.postMessage({ type: 'model', model: name });
		this.postStatus(`Model: ${name}`);
	}

	private async safeListModels(): Promise<string[]> {
		// Prefer Ollama directly — authoritative source of installed models.
		try {
			const models = await this.ollama().listModels();
			if (models.length > 0) {
				return models;
			}
		} catch {
			// fall through
		}
		try {
			const daemon = await this.daemonManager.ensureRunning();
			if ((await daemon.health()).ok) {
				return await daemon.models();
			}
		} catch {
			// ignore
		}
		return [];
	}

	private postStatus(text: string): void {
		this.postMessage({ type: 'status', text });
	}

	private postMessage(payload: unknown): void {
		void this.view?.webview.postMessage(payload);
	}

	private getHtml(_webview: vscode.Webview): string {
		// Inline media so submit handlers always load (no CSP / asWebviewUri failures).
		const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const css = this.readMedia(mediaRoot, 'chat.css');
		const js = this.readMedia(mediaRoot, 'chat.js');
		const csp = [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"script-src 'unsafe-inline'",
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
${css}
</style>
</head>
<body>
<div class="toolbar">
  <label for="model">Model</label>
  <select id="model" aria-label="Ollama model"></select>
  <button type="button" class="secondary" id="refresh" title="Reload models from Ollama">Refresh</button>
</div>
<div class="controls">
  <label class="approval-mode" id="approvalModeWrap">
    Tool execution
    <select id="runEverything" aria-label="Tool execution mode">
      <option value="ask">Ask each time</option>
      <option value="allowAll">Run everything</option>
    </select>
  </label>
  <button type="button" class="secondary" id="clear">Clear</button>
</div>
<div class="messages" id="messages"><div class="empty">Loading models from Ollama\u2026</div></div>
<div class="status" id="status"></div>
<div class="working-banner" id="workingBanner" aria-live="polite">
  <div class="spinner" aria-hidden="true"></div>
  <div class="label" id="workingLabel">Model is working\u2026</div>
  <div class="elapsed" id="workingElapsed">0s</div>
</div>
<div class="input-row" id="inputRow">
  <div class="composer">
    <textarea id="input" placeholder="Ask LocalPointer\u2026" rows="3"></textarea>
    <div class="hint" id="hint">Enter to send \u00b7 Ctrl+Enter or Shift+Enter for newline</div>
  </div>
  <div class="actions">
    <button type="button" id="send">Send</button>
  </div>
</div>
<script>
${js}
</script>
</body>
</html>`;
	}

	private readMedia(mediaRoot: vscode.Uri, fileName: string): string {
		return fs.readFileSync(path.join(mediaRoot.fsPath, fileName), 'utf8');
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
