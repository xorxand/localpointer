/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OllamaClient } from './ollama';
import { getConfig, getLastTransparency } from './config';
import { pickModelQuickPick } from './lmProvider';

export class StatusBarService implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly interval: NodeJS.Timeout;
	private ollama: OllamaClient;

	constructor(ollama: OllamaClient) {
		this.ollama = ollama;
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this.item.command = 'localpointer.selectModel';
		this.item.tooltip = 'LocalPointer model (click to change)';
		this.item.show();
		void this.refresh();
		this.interval = setInterval(() => void this.refresh(), 15000);
	}

	async refresh(): Promise<void> {
		this.ollama = new OllamaClient(getConfig().ollamaUrl);
		const cfg = getConfig();
		const model = cfg.model || 'auto';
		const healthy = await this.ollama.health();
		const icon = healthy ? '$(pass)' : '$(warning)';
		this.item.text = `${icon} $(hubot) ${model}`;
		this.item.backgroundColor = healthy
			? undefined
			: new vscode.ThemeColor('statusBarItem.warningBackground');
	}

	async selectModel(): Promise<void> {
		const picked = await pickModelQuickPick(this.ollama);
		if (picked) {
			await this.refresh();
		}
	}

	dispose(): void {
		clearInterval(this.interval);
		this.item.dispose();
	}
}

export async function showWhyPanel(): Promise<void> {
	const info = getLastTransparency();
	const doc = await vscode.workspace.openTextDocument({
		content: info ? JSON.stringify(info, null, 2) : 'No transparency data yet. Send a chat or completion request first.',
		language: 'json',
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}
