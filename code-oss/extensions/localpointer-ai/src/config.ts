/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface LocalPointerConfig {
	daemonUrl: string;
	ollamaUrl: string;
	model: string;
	completionsEnabled: boolean;
	completionsDebounceMs: number;
	autoApprove: boolean;
	daemonPath: string;
}

export function getConfig(): LocalPointerConfig {
	const cfg = vscode.workspace.getConfiguration('localpointer');
	return {
		daemonUrl: cfg.get<string>('daemonUrl', 'http://127.0.0.1:9477').replace(/\/+$/, ''),
		ollamaUrl: cfg.get<string>('ollamaUrl', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
		model: cfg.get<string>('model', ''),
		completionsEnabled: cfg.get<boolean>('completions.enabled', true),
		completionsDebounceMs: cfg.get<number>('completions.debounceMs', 400),
		autoApprove: cfg.get<boolean>('autoApprove', false),
		daemonPath: cfg.get<string>('daemonPath', ''),
	};
}

export interface TransparencyInfo {
	model?: string;
	stats?: Record<string, unknown>;
	trace?: unknown[];
	source?: string;
	timestamp?: string;
}

let lastTransparency: TransparencyInfo | undefined;

export function setLastTransparency(info: TransparencyInfo): void {
	lastTransparency = { ...info, timestamp: new Date().toISOString() };
}

export function getLastTransparency(): TransparencyInfo | undefined {
	return lastTransparency;
}

export async function resolveModelName(
	ollamaListModels: () => Promise<string[]>,
	configured?: string,
): Promise<string> {
	const model = (configured ?? getConfig().model).trim();
	if (model) {
		return model;
	}
	const models = await ollamaListModels();
	if (models.length === 0) {
		throw new Error('No local Ollama models available. Start Ollama and pull a model.');
	}
	const preferred = ['qwen2.5-coder', 'qwen2.5', 'codellama', 'deepseek-coder', 'llama3.1', 'llama3.2'];
	for (const prefix of preferred) {
		const hit = models.find(m => m.startsWith(prefix));
		if (hit) {
			return hit;
		}
	}
	return models[0];
}

export function activeEditorContext(): { activeFile: string; selection: string; languageId: string } {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return { activeFile: '', selection: '', languageId: '' };
	}
	const doc = editor.document;
	const sel = editor.selection.isEmpty
		? ''
		: doc.getText(editor.selection);
	return {
		activeFile: vscode.workspace.asRelativePath(doc.uri),
		selection: sel,
		languageId: doc.languageId,
	};
}

export function workspaceFolderPath(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder?.uri.fsPath ?? '';
}
