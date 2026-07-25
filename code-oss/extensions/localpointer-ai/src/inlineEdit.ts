/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DaemonManager } from './daemonManager';
import { OllamaClient } from './ollama';
import { activeEditorContext, setLastTransparency, workspaceFolderPath } from './config';
import { getActiveModel } from './lmProvider';

interface PendingEdit {
	editor: vscode.TextEditor;
	range: vscode.Range;
	original: string;
	replacement: string;
	addedDecoration: vscode.TextEditorDecorationType;
	removedDecoration: vscode.TextEditorDecorationType;
}

export class InlineEditService implements vscode.Disposable {
	private pending: PendingEdit | undefined;

	constructor(
		private readonly daemonManager: DaemonManager,
		private readonly ollama: OllamaClient,
	) { }

	async run(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			vscode.window.showInformationMessage('Select code to edit inline (Ctrl+K).');
			return;
		}

		const instruction = await vscode.window.showInputBox({
			title: 'Edit instruction',
			placeHolder: 'Describe how to change the selection…',
		});
		if (!instruction) {
			return;
		}

		await this.clearPending();
		const doc = editor.document;
		const range = new vscode.Range(editor.selection.start, editor.selection.end);
		const selection = doc.getText(range);
		const ctx = activeEditorContext();
		const model = await getActiveModel(this.ollama);
		let replacement = '';

		try {
			const daemon = await this.daemonManager.ensureRunning();
			if ((await daemon.health()).ok) {
				const wsPath = workspaceFolderPath();
				const wsId = wsPath ? await daemon.ensureWorkspace(wsPath) : undefined;
				const prefixStartLine = Math.max(0, range.start.line - 20);
				const suffixEndLine = Math.min(doc.lineCount - 1, range.end.line + 20);
				const prefix = doc.getText(new vscode.Range(prefixStartLine, 0, range.start.line, range.start.character));
				const suffix = doc.getText(new vscode.Range(range.end.line, range.end.character, suffixEndLine, doc.lineAt(suffixEndLine).text.length));
				const result = await daemon.inlineEdit({
					workspace_id: wsId,
					model,
					instruction,
					file_path: ctx.activeFile,
					language: doc.languageId,
					selection,
					prefix,
					suffix,
				});
				replacement = result.text;
				setLastTransparency({ model: result.model ?? model, stats: result.stats, source: 'inlineEdit-daemon' });
			}
		} catch (err) {
			if (String(err).includes('daemon_inline_edit_not_found') || String(err).includes('fetch')) {
				replacement = await this.ollamaInlineEdit(model, instruction, selection, doc.languageId);
				setLastTransparency({ model, source: 'inlineEdit-ollama' });
			} else {
				vscode.window.showErrorMessage(String(err));
				return;
			}
		}

		if (!replacement || replacement === selection) {
			vscode.window.showInformationMessage('No changes suggested.');
			return;
		}

		const addedDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(0, 180, 0, 0.25)',
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		const removedDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(180, 0, 0, 0.25)',
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});

		editor.setDecorations(removedDecoration, [range]);
		const previewRange = new vscode.Range(range.start, range.start);
		editor.setDecorations(addedDecoration, [{ range: previewRange, renderOptions: { after: { contentText: replacement.slice(0, 120) + (replacement.length > 120 ? '…' : ''), color: '#9cdcfe' } } }]);

		this.pending = {
			editor,
			range,
			original: selection,
			replacement: stripFences(replacement),
			addedDecoration,
			removedDecoration,
		};
		await vscode.commands.executeCommand('setContext', 'localpointer.hasPendingEdit', true);

		const choice = await vscode.window.showInformationMessage(
			'Apply inline edit?',
			'Apply',
			'Reject',
		);
		if (choice === 'Apply') {
			await this.applyLastEdit();
		} else {
			await this.rejectLastEdit();
		}
	}

	async applyLastEdit(): Promise<void> {
		if (!this.pending) {
			return;
		}
		const { editor, range, replacement, addedDecoration, removedDecoration } = this.pending;
		const ok = await editor.edit(edit => edit.replace(range, replacement));
		if (!ok) {
			vscode.window.showErrorMessage('Failed to apply edit.');
		}
		addedDecoration.dispose();
		removedDecoration.dispose();
		this.pending = undefined;
		await vscode.commands.executeCommand('setContext', 'localpointer.hasPendingEdit', false);
	}

	async rejectLastEdit(): Promise<void> {
		if (!this.pending) {
			return;
		}
		this.pending.addedDecoration.dispose();
		this.pending.removedDecoration.dispose();
		this.pending = undefined;
		await vscode.commands.executeCommand('setContext', 'localpointer.hasPendingEdit', false);
	}

	private async clearPending(): Promise<void> {
		if (this.pending) {
			await this.rejectLastEdit();
		}
	}

	private async ollamaInlineEdit(model: string, instruction: string, selection: string, languageId: string): Promise<string> {
		return this.ollama.chat(model, [
			{
				role: 'system',
				content: 'You edit code selections. Return ONLY the replacement text for the selection. No markdown fences or explanation.',
			},
			{
				role: 'user',
				content: `Language: ${languageId}\nInstruction: ${instruction}\n\nSelection:\n${selection}`,
			},
		]);
	}

	dispose(): void {
		void this.clearPending();
	}
}

function stripFences(text: string): string {
	const trimmed = text.trim();
	const m = /^```[\w]*\n([\s\S]*?)\n```$/.exec(trimmed);
	return m ? m[1] : trimmed;
}
