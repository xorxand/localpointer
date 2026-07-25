/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { getConfig, getLastTransparency, resolveModelName, setLastTransparency, workspaceFolderPath } from './config';
import { DaemonSSEEvent } from './daemon';

interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'localpointer.chatView';

	private view: vscode.WebviewView | undefined;
	private conversationId: number | undefined;
	private readonly messages: ChatMessage[] = [];
	private agentMode = true;
	private showWhy = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly daemonManager: DaemonManager,
		private readonly ollama: OllamaClient,
	) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async msg => {
			switch (msg.type) {
				case 'ready':
					await this.postInit();
					break;
				case 'send':
					await this.handleSend(String(msg.text ?? ''));
					break;
				case 'selectModel':
					await this.selectModel(String(msg.model ?? ''));
					break;
				case 'toggleAgent':
					this.agentMode = !!msg.enabled;
					break;
				case 'toggleWhy':
					this.showWhy = !!msg.enabled;
					this.postWhy();
					break;
				case 'approve':
					await this.handleApprove(String(msg.id ?? ''), msg.allow === true);
					break;
			}
		});
	}

	focus(): void {
		if (this.view) {
			this.view.show?.(true);
		} else {
			void vscode.commands.executeCommand('localpointer.chatView.focus');
		}
	}

	private async postInit(): Promise<void> {
		const models = await this.safeListModels();
		const model = await resolveModelName(() => Promise.resolve(models)).catch(() => '');
		this.postMessage({
			type: 'init',
			models,
			model,
			agentMode: this.agentMode,
			showWhy: this.showWhy,
			messages: this.messages,
		});
		this.postWhy();
	}

	private async handleSend(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || !this.view) {
			return;
		}
		this.messages.push({ role: 'user', content: prompt });
		this.postMessage({ type: 'messages', messages: this.messages });
		this.postMessage({ type: 'streaming', active: true });

		const cfg = getConfig();
		let model = cfg.model;
		let assistant = '';
		let stats: Record<string, unknown> | undefined;
		let trace: unknown[] | undefined;

		try {
			model = await resolveModelName(() => this.ollama.listModels(), cfg.model);
			if (this.agentMode) {
				const result = await this.agentChat(prompt, model, cfg.autoApprove);
				assistant = result.content;
				stats = result.stats;
				trace = result.trace;
				this.conversationId = result.conversationId ?? this.conversationId;
			} else {
				const result = await this.ollama.streamChat(
					model,
					[...this.messages.slice(0, -1), { role: 'user', content: prompt }],
					token => {
						assistant += token;
						this.postMessage({ type: 'streamToken', token });
					},
				);
				assistant = result.content;
				stats = result.stats as Record<string, unknown>;
			}
		} catch (err) {
			assistant = `Error: ${String(err)}`;
		}

		this.messages.push({ role: 'assistant', content: assistant });
		setLastTransparency({ model, stats, trace, source: 'chatView' });
		this.postMessage({ type: 'messages', messages: this.messages });
		this.postMessage({ type: 'streaming', active: false });
		this.postWhy();
	}

	private async agentChat(
		prompt: string,
		model: string,
		autoApprove: boolean,
	): Promise<{ content: string; stats?: Record<string, unknown>; trace?: unknown[]; conversationId?: number }> {
		const daemon = await this.daemonManager.ensureRunning();
		const wsPath = workspaceFolderPath();
		if (!(await daemon.health()).ok || !wsPath) {
			const result = await this.ollama.streamChat(model, [{ role: 'user', content: prompt }], token => {
				this.postMessage({ type: 'streamToken', token });
			});
			return { content: result.content, stats: result.stats as Record<string, unknown> };
		}

		const workspaceId = await daemon.ensureWorkspace(wsPath);
		let content = '';
		let stats: Record<string, unknown> | undefined;
		let trace: unknown[] | undefined;
		let conversationId: number | undefined;

		await daemon.chat({
			workspace_id: workspaceId,
			conversation_id: this.conversationId,
			message: prompt,
			model,
			auto_approve: autoApprove,
		}, async (event: DaemonSSEEvent) => {
			if (event.conversation_id) {
				conversationId = event.conversation_id;
			}
			if (event.token) {
				content += event.token;
				this.postMessage({ type: 'streamToken', token: event.token });
			}
			if (event.stats) {
				stats = event.stats;
			}
			if (event.trace) {
				trace = event.trace;
			}
			if (event.status === 'approval_required' && event.id && event.tool) {
				if (autoApprove) {
					await daemon.approve(event.id, 'allow');
				} else {
					this.postMessage({
						type: 'approval',
						id: event.id,
						tool: event.tool,
						args: event.args ?? {},
					});
					const choice = await vscode.window.showWarningMessage(
						`Allow tool "${event.tool}"?`,
						'Allow',
						'Deny',
					);
					await daemon.approve(event.id, choice === 'Allow' ? 'allow' : 'deny');
				}
			}
			if (event.error) {
				throw new Error(event.error);
			}
		});

		return { content, stats, trace, conversationId };
	}

	private async handleApprove(id: string, allow: boolean): Promise<void> {
		const daemon = await this.daemonManager.ensureRunning();
		await daemon.approve(id, allow ? 'allow' : 'deny');
	}

	private async selectModel(model: string): Promise<void> {
		await vscode.workspace.getConfiguration('localpointer').update('model', model, vscode.ConfigurationTarget.Global);
		this.postMessage({ type: 'model', model });
	}

	private async safeListModels(): Promise<string[]> {
		try {
			const daemon = await this.daemonManager.ensureRunning();
			if ((await daemon.health()).ok) {
				return await daemon.models();
			}
		} catch {
			// ignore
		}
		try {
			return await this.ollama.listModels();
		} catch {
			return [];
		}
	}

	private postWhy(): void {
		if (!this.showWhy) {
			this.postMessage({ type: 'why', info: undefined });
			return;
		}
		this.postMessage({ type: 'why', info: getLastTransparency() });
	}

	private postMessage(payload: unknown): void {
		void this.view?.webview.postMessage(payload);
	}

	private getHtml(): string {
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
:root {
  color-scheme: dark;
  --bg: var(--vscode-editor-background, #1e1e1e);
  --fg: var(--vscode-editor-foreground, #d4d4d4);
  --muted: var(--vscode-descriptionForeground, #9da5b4);
  --border: var(--vscode-panel-border, #3c3c3c);
  --input-bg: var(--vscode-input-background, #3c3c3c);
  --input-fg: var(--vscode-input-foreground, #cccccc);
  --btn-bg: var(--vscode-button-background, #0e639c);
  --btn-fg: var(--vscode-button-foreground, #ffffff);
  --accent: var(--vscode-focusBorder, #007fd4);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  background: var(--bg);
  color: var(--fg);
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.toolbar, .controls, .input-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.toolbar label, .controls label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
select, textarea, button {
  font: inherit;
}
select {
  flex: 1;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
}
.messages {
  flex: 1;
  overflow: auto;
  padding: 8px;
}
.msg {
  margin-bottom: 12px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user { border-color: var(--accent); }
.msg.assistant { background: rgba(255,255,255,0.03); }
.role {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 4px;
}
.why-panel {
  max-height: 140px;
  overflow: auto;
  padding: 8px;
  border-top: 1px solid var(--border);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  color: var(--muted);
  display: none;
}
.why-panel.visible { display: block; }
.input-row {
  border-top: 1px solid var(--border);
  border-bottom: none;
}
textarea {
  flex: 1;
  min-height: 64px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
}
button {
  background: var(--btn-bg);
  color: var(--btn-fg);
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }
.status { padding: 0 8px 8px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<div class="toolbar">
  <label>Model</label>
  <select id="model"></select>
</div>
<div class="controls">
  <label><input type="checkbox" id="agent" checked /> Agent</label>
  <label><input type="checkbox" id="why" /> Why / stats</label>
</div>
<div class="messages" id="messages"></div>
<div class="why-panel" id="whyPanel"></div>
<div class="status" id="status"></div>
<div class="input-row">
  <textarea id="input" placeholder="Ask LocalPointer…"></textarea>
  <button id="send">Send</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const modelEl = document.getElementById('model');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const agentEl = document.getElementById('agent');
const whyEl = document.getElementById('why');
const whyPanel = document.getElementById('whyPanel');
const statusEl = document.getElementById('status');
let streaming = false;
let streamBuf = '';

function renderMessages(msgs) {
  messagesEl.innerHTML = '';
  for (const m of msgs) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role;
    div.innerHTML = '<div class="role">' + m.role + '</div>' + escapeHtml(m.content);
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setStreaming(active) {
  streaming = active;
  sendBtn.disabled = active;
  statusEl.textContent = active ? 'Generating…' : '';
  if (active) {
    streamBuf = '';
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.id = 'stream';
    div.innerHTML = '<div class="role">assistant</div><span id="streamBody"></span>';
    messagesEl.appendChild(div);
  } else {
    const stream = document.getElementById('stream');
    if (stream) stream.removeAttribute('id');
  }
}

sendBtn.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  inputEl.value = '';
  vscode.postMessage({ type: 'send', text });
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendBtn.click();
  }
});

modelEl.addEventListener('change', () => {
  vscode.postMessage({ type: 'selectModel', model: modelEl.value });
});

agentEl.addEventListener('change', () => {
  vscode.postMessage({ type: 'toggleAgent', enabled: agentEl.checked });
});

whyEl.addEventListener('change', () => {
  whyPanel.classList.toggle('visible', whyEl.checked);
  vscode.postMessage({ type: 'toggleWhy', enabled: whyEl.checked });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      modelEl.innerHTML = (msg.models || []).map(m => '<option value="' + m + '">' + m + '</option>').join('');
      if (msg.model) modelEl.value = msg.model;
      agentEl.checked = !!msg.agentMode;
      whyEl.checked = !!msg.showWhy;
      whyPanel.classList.toggle('visible', !!msg.showWhy);
      renderMessages(msg.messages || []);
      break;
    case 'messages':
      renderMessages(msg.messages || []);
      break;
    case 'streaming':
      setStreaming(!!msg.active);
      break;
    case 'streamToken':
      streamBuf += msg.token || '';
      const body = document.getElementById('streamBody');
      if (body) body.textContent = streamBuf;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case 'model':
      if (msg.model) modelEl.value = msg.model;
      break;
    case 'why':
      whyPanel.textContent = msg.info ? JSON.stringify(msg.info, null, 2) : '';
      break;
    case 'approval':
      statusEl.textContent = 'Approval required for ' + (msg.tool || 'tool') + '…';
      break;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
