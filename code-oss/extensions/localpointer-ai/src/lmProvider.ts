/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OllamaClient } from './ollama';
import { getConfig, resolveModelName } from './config';

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
					return [];
				}
				return names.map((name) => ({
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
				} satisfies vscode.LanguageModelChatInformation));
			},
			provideLanguageModelChatResponse: async (model, messages, _options, progress, token) => {
				const ollama = new OllamaClient(getConfig().ollamaUrl);
				const ollamaMessages = messages.map(m => ({
					role: messageRole(m),
					content: messageText(m),
				}));
				const controller = new AbortController();
				const sub = token.onCancellationRequested(() => controller.abort());
				try {
					await ollama.streamChat(
						model.id,
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
	const picked = await vscode.window.showQuickPick(models, {
		title: 'Select LocalPointer model',
		placeHolder: current || 'Auto',
	});
	if (!picked) {
		return undefined;
	}
	await vscode.workspace.getConfiguration('localpointer').update('model', picked, vscode.ConfigurationTarget.Global);
	return picked;
}

export async function getActiveModel(ollama: OllamaClient): Promise<string> {
	return resolveModelName(() => ollama.listModels());
}
