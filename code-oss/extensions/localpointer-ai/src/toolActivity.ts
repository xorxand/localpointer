/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import { DaemonSSEEvent } from './daemon';

export interface ToolActivityEntry {
	/** One plaintext chunk to append to the collapsible tool log. */
	text: string;
	/** Short label for the collapsed summary, e.g. "read_file". */
	tool?: string;
	/** Running total of tool calls observed in this request. */
	toolCount: number;
}

/**
 * Formats daemon SSE tool events into a readable activity log for a
 * collapsed-by-default chat section.
 */
export class ToolActivityCollector {
	private toolCount = 0;
	private readonly activityEntries: string[] = [];

	get count(): number {
		return this.toolCount;
	}

	get entries(): readonly string[] {
		return this.activityEntries;
	}

	addNote(text: string): ToolActivityEntry {
		const activity = {
			text: `${text.replace(/\n+$/, '')}\n\n`,
			toolCount: this.toolCount,
		};
		this.activityEntries.push(activity.text);
		return activity;
	}

	summaryLabel(): string {
		if (this.toolCount <= 0) {
			return 'Activity';
		}
		return this.toolCount === 1 ? 'Activity · 1 tool call' : `Activity · ${this.toolCount} tool calls`;
	}

	/**
	 * Returns an activity entry when the event is tool-related, otherwise undefined.
	 */
	consume(event: DaemonSSEEvent): ToolActivityEntry | undefined {
		let activity: ToolActivityEntry | undefined;
		switch (event.status) {
			case 'plan': {
				const steps = Array.isArray(event.steps)
					? event.steps.map((step, index) => `${index + 1}. ${String(step)}`).join('\n')
					: '';
				activity = {
					text: steps ? `Plan\n${steps}\n\n` : 'Plan created\n\n',
					toolCount: this.toolCount,
				};
				break;
			}
			case 'tool_call': {
				this.toolCount++;
				const args = formatArgs(event.args);
				const lines = [`→ ${event.tool ?? 'tool'}`];
				if (args) {
					lines.push(args);
				}
				lines.push('');
				activity = { text: lines.join('\n'), tool: event.tool, toolCount: this.toolCount };
				break;
			}
			case 'approved': {
				const how = event.auto ? 'auto-approved' : 'allowed';
				activity = {
					text: `  (${how})\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
				break;
			}
			case 'tool_result': {
				const preview = formatResultPreview(event);
				activity = {
					text: preview ? `← ${preview}\n\n` : `← (empty result)\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
				break;
			}
			case 'tool_error': {
				const err = event.error ?? 'unknown error';
				activity = {
					text: `← error: ${err}\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
				break;
			}
			case 'tool_denied':
				activity = {
					text: `  (denied)\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
				break;
			case 'file_changed':
				activity = {
					text: `Changed ${event.path ?? 'workspace file'}\n\n`,
					toolCount: this.toolCount,
				};
				break;
			default:
				return undefined;
		}
		this.activityEntries.push(activity.text);
		return activity;
	}
}

function formatArgs(args: Record<string, unknown> | undefined): string | undefined {
	if (!args || Object.keys(args).length === 0) {
		return undefined;
	}
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

function formatResultPreview(event: DaemonSSEEvent): string | undefined {
	const content = typeof event.content === 'string' ? event.content : undefined;
	if (content && content.trim()) {
		return content.trimEnd();
	}
	if (event.data !== undefined) {
		try {
			return JSON.stringify(event.data, null, 2);
		} catch {
			return String(event.data);
		}
	}
	return undefined;
}
