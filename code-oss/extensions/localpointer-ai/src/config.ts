/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AutoOptimizeMode, isAutoModelId, parseAutoModeFromModelId, routeAutoModel } from './autoRouter';
import { OllamaClient } from './ollama';

export interface LocalPointerConfig {
	daemonUrl: string;
	ollamaUrl: string;
	model: string;
	completionsEnabled: boolean;
	completionsDebounceMs: number;
	autoApprove: boolean;
	daemonPath: string;
	autoMode: AutoOptimizeMode;
}

export function getConfig(): LocalPointerConfig {
	const cfg = vscode.workspace.getConfiguration('localpointer');
	const autoModeRaw = cfg.get<string>('auto.mode', 'balance');
	const autoMode: AutoOptimizeMode =
		autoModeRaw === 'cost' || autoModeRaw === 'intelligence' ? autoModeRaw : 'balance';
	return {
		daemonUrl: cfg.get<string>('daemonUrl', 'http://127.0.0.1:9477').replace(/\/+$/, ''),
		ollamaUrl: cfg.get<string>('ollamaUrl', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
		model: cfg.get<string>('model', ''),
		completionsEnabled: cfg.get<boolean>('completions.enabled', true),
		completionsDebounceMs: cfg.get<number>('completions.debounceMs', 400),
		autoApprove: cfg.get<boolean>('autoApprove', false),
		daemonPath: cfg.get<string>('daemonPath', ''),
		autoMode,
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
	if (model && !isAutoModelId(model)) {
		return model;
	}
	const models = await ollamaListModels();
	if (models.length === 0) {
		throw new Error('No local Ollama models available. Start Ollama and pull a model.');
	}
	const preferred = ['qwen3.5:9b', 'qwen2.5:7b', 'qwen3.5:4b', 'qwen2.5:14b', 'llama3.1:8b', 'qwen2.5:3b', 'qwen3.5', 'qwen2.5', 'llama3.1', 'llama3.2'];
	for (const prefix of preferred) {
		const hit = models.find(m => m === prefix || m.startsWith(prefix));
		if (hit) {
			return hit;
		}
	}
	return models[0];
}

/**
 * Resolve the concrete Ollama model for a request. Empty / Auto uses Cursor-like routing.
 */
export async function resolveRequestModel(
	ollama: OllamaClient,
	options?: {
		configured?: string;
		prompt?: string;
		signal?: AbortSignal;
	},
): Promise<{ model: string; routedFromAuto: boolean; complexity?: string; reason?: string }> {
	const cfg = getConfig();
	const configured = (options?.configured ?? cfg.model).trim();
	if (configured && !isAutoModelId(configured)) {
		return { model: configured, routedFromAuto: false };
	}

	const mode = parseAutoModeFromModelId(configured, cfg.autoMode);
	const prompt = options?.prompt?.trim() || 'general coding help';
	try {
		const routed = await routeAutoModel(ollama, prompt, mode, options?.signal);
		return {
			model: routed.model,
			routedFromAuto: true,
			complexity: routed.complexity,
			reason: routed.reason,
		};
	} catch {
		const fallback = await resolveModelName(() => ollama.listModels(), '');
		return { model: fallback, routedFromAuto: true, reason: 'fallback' };
	}
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
