/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { getConfig } from './config';
import { LocalPointerLmProvider } from './lmProvider';
import { ChatParticipantService, AgentEditService } from './chatParticipant';
import { ChatViewProvider } from './chatView';
import { InlineEditService } from './inlineEdit';
import { CompletionsService, toggleCompletions } from './completions';
import { StatusBarService, showWhyPanel } from './statusBar';

let daemonManager: DaemonManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const ollama = new OllamaClient(getConfig().ollamaUrl);
	daemonManager = new DaemonManager(context);
	context.subscriptions.push(daemonManager);

	void daemonManager.ensureRunning().catch(err => {
		console.warn('[localpointer-ai] daemon startup:', err);
	});

	const lmProvider = new LocalPointerLmProvider();
	context.subscriptions.push(lmProvider);

	const chatView = new ChatViewProvider(context, daemonManager, ollama);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView),
	);

	const chatParticipant = new ChatParticipantService(daemonManager, ollama);
	chatParticipant.register();
	context.subscriptions.push(chatParticipant);

	const inlineEdit = new InlineEditService(daemonManager, ollama);
	context.subscriptions.push(inlineEdit);

	const completions = new CompletionsService(daemonManager, ollama);
	context.subscriptions.push(completions);

	const statusBar = new StatusBarService(ollama);
	context.subscriptions.push(statusBar);

	const agentEdit = new AgentEditService(daemonManager, ollama);

	context.subscriptions.push(
		vscode.commands.registerCommand('localpointer.openChat', () => chatView.focus()),
		vscode.commands.registerCommand('localpointer.inlineEdit', () => inlineEdit.run()),
		vscode.commands.registerCommand('localpointer.agentEdit', () => agentEdit.run()),
		vscode.commands.registerCommand('localpointer.toggleCompletions', () => toggleCompletions()),
		vscode.commands.registerCommand('localpointer.selectModel', () => statusBar.selectModel()),
		vscode.commands.registerCommand('localpointer.showWhy', () => showWhyPanel()),
		vscode.commands.registerCommand('localpointer.applyLastEdit', () => inlineEdit.applyLastEdit()),
		vscode.commands.registerCommand('localpointer.rejectLastEdit', () => inlineEdit.rejectLastEdit()),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('localpointer')) {
				lmProvider.refresh();
				void statusBar.refresh();
			}
		}),
	);
}

export function deactivate(): void {
	daemonManager?.dispose();
	daemonManager = undefined;
}
