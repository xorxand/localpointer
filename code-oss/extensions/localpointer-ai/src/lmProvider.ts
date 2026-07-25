/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OllamaClient } from './ollama';
import { getConfig, resolveRequestModel } from './config';
import { AUTO_MODEL_ID, isAutoModelId } from './autoRouter';

export class LocalPointerLmProvider implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	private readonly registration: vscode.Disposable;

	constructor() {
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this.emitter.event,
			provideLanguageModelChatInformation: async (_options, _token) => {
				const ollama = new OllamaClient(getConfig().ollamaUrl);
				let names: string[] = [];
				try {
					names = await ollama.listModels();
				} catch {
					return [autoModelInfo()];
				}
				const models: vscode.LanguageModelChatInformation[] = [
					autoModelInfo(),
					...names.map((name) => ({
						id: name,
						name,
						family: 'ollama',
						version: 'local',
						maxInputTokens: 32768,
						maxOutputTokens: 4096,
						tooltip: `Local Ollama model: ${name}`,
						detail: 'local · Ollama',
						capabilities: {
							toolCalling: true,
						},
						isBYOK: true,
						isUserSelectable: true,
						isDefault: false,
					} as vscode.LanguageModelChatInformation)),
				];
				// Mark Auto as default when no pinned model, else first concrete model.
				const pinned = getConfig().model.trim();
				if (!pinned || isAutoModelId(pinned)) {
					(models[0] as { isDefault?: boolean }).isDefault = true;
				} else {
					const hit = models.find(m => m.id === pinned);
					if (hit) {
						(hit as { isDefault?: boolean }).isDefault = true;
					} else if (models[1]) {
						(models[1] as { isDefault?: boolean }).isDefault = true;
					}
				}
				return models;
			},
			provideLanguageModelChatResponse: async (model, messages, _options, progress, token) => {
				const ollama = new OllamaClient(getConfig().ollamaUrl);
				const ollamaMessages = messages.map(m => ({
					role: messageRole(m),
					content: messageText(m),
				}));
				const userPrompt = ollamaMessages.filter(m => m.role === 'user').map(m => m.content).join('\n');
				const resolved = await resolveRequestModel(ollama, {
					configured: isAutoModelId(model.id) ? AUTO_MODEL_ID : model.id,
					prompt: userPrompt,
					signal: abortToSignal(token),
				});
				const controller = new AbortController();
				const sub = token.onCancellationRequested(() => controller.abort());
				try {
					if (resolved.routedFromAuto) {
						progress.report(new vscode.LanguageModelTextPart(
							`_Auto → ${resolved.model}` +
							(resolved.complexity ? ` (${resolved.complexity})` : '') +
							`_\n\n`
						));
					}
					await ollama.streamChat(
						resolved.model,
						ollamaMessages,
						tokenStr => progress.report(new vscode.LanguageModelTextPart(tokenStr)),
						controller.signal,
					);
				} finally {
					sub.dispose();
				}
			},
			provideTokenCount: async (_model, text, _token) => {
				const content = typeof text === 'string' ? text : messageText(text);
				return Math.max(1, Math.ceil(content.length / 4));
			},
		};
		this.registration = vscode.lm.registerLanguageModelChatProvider('localpointer', provider);
	}

	refresh(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.registration.dispose();
		this.emitter.dispose();
	}
}

function autoModelInfo(): vscode.LanguageModelChatInformation {
	return {
		id: AUTO_MODEL_ID,
		name: 'Auto',
		family: 'localpointer-auto',
		version: 'local',
		maxInputTokens: 32768,
		maxOutputTokens: 4096,
		tooltip: 'Cursor-like Auto: classify the request, then pick a local Ollama model',
		detail: 'routes per request · Ollama',
		capabilities: {
			toolCalling: true,
		},
		isBYOK: true,
		isUserSelectable: true,
		isDefault: true,
	} as vscode.LanguageModelChatInformation;
}

function abortToSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}

function messageRole(message: vscode.LanguageModelChatRequestMessage): 'system' | 'user' | 'assistant' {
	switch (message.role) {
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

function messageText(message: vscode.LanguageModelChatRequestMessage | string): string {
	if (typeof message === 'string') {
		return message;
	}
	return message.content
		.map(part => {
			if (part instanceof vscode.LanguageModelTextPart) {
				return part.value;
			}
			return '';
		})
		.join('');
}

export async function pickModelQuickPick(ollama: OllamaClient): Promise<string | undefined> {
	const models = await ollama.listModels();
	if (models.length === 0) {
		vscode.window.showWarningMessage('No Ollama models found. Pull one with `ollama pull`.');
		return undefined;
	}
	const current = getConfig().model;
	const items = [
		{ label: 'Auto', description: 'Route each request (cost / balance / intelligence)', model: '' },
		...models.map(m => ({ label: m, description: 'Ollama', model: m })),
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: 'Select LocalPointer model',
		placeHolder: current || 'Auto',
	});
	if (!picked) {
		return undefined;
	}
	await vscode.workspace.getConfiguration('localpointer').update('model', picked.model, vscode.ConfigurationTarget.Global);
	return picked.model || AUTO_MODEL_ID;
}

export async function getActiveModel(ollama: OllamaClient): Promise<string> {
	const resolved = await resolveRequestModel(ollama);
	return resolved.model;
}
