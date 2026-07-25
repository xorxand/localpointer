/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { getConfig, setLastTransparency } from './config';
import { getActiveModel } from './lmProvider';

export class CompletionsService implements vscode.Disposable {
	private readonly provider: vscode.Disposable;
	private debounceTimer: NodeJS.Timeout | undefined;
	private lastRequestId = 0;

	constructor(
		private readonly daemonManager: DaemonManager,
		private readonly ollama: OllamaClient,
	) {
		this.provider = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			{
				provideInlineCompletionItems: async (document, position, context, token) => {
					const cfg = getConfig();
					if (!cfg.completionsEnabled) {
						return undefined;
					}
					if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && context.selectedCompletionInfo) {
						return undefined;
					}

					const requestId = ++this.lastRequestId;
					await this.debounce(cfg.completionsDebounceMs);
					if (token.isCancellationRequested || requestId !== this.lastRequestId) {
						return undefined;
					}

					const prefix = document.getText(new vscode.Range(0, 0, position.line, position.character));
					const suffix = document.getText(new vscode.Range(position.line, position.character, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length));
					if (prefix.trim().length < 2) {
						return undefined;
					}

					let completion = '';
					const model = await getActiveModel(this.ollama).catch(() => '');
					if (!model) {
						return undefined;
					}

					try {
						const daemon = await this.daemonManager.ensureRunning();
						if ((await daemon.health()).ok) {
							completion = await daemon.complete({
								model,
								prefix,
								suffix,
								language: document.languageId,
							});
							setLastTransparency({ model, source: 'completions-daemon' });
						}
					} catch {
						completion = await this.ollama.complete(model, prefix, suffix, document.languageId);
						setLastTransparency({ model, source: 'completions-ollama' });
					}

					if (token.isCancellationRequested || !completion.trim()) {
						return undefined;
					}

					const item = new vscode.InlineCompletionItem(
						completion,
						new vscode.Range(position, position),
					);
					return [item];
				},
			},
		);
	}

	private debounce(ms: number): Promise<void> {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		return new Promise(resolve => {
			this.debounceTimer = setTimeout(resolve, ms);
		});
	}

	dispose(): void {
		this.provider.dispose();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
	}
}

export async function toggleCompletions(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('localpointer');
	const enabled = cfg.get<boolean>('completions.enabled', true);
	await cfg.update('completions.enabled', !enabled, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`LocalPointer completions ${!enabled ? 'enabled' : 'disabled'}.`);
}
