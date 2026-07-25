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

	get count(): number {
		return this.toolCount;
	}

	summaryLabel(): string {
		if (this.toolCount <= 0) {
			return 'Tools';
		}
		return this.toolCount === 1 ? '1 tool' : `${this.toolCount} tools`;
	}

	/**
	 * Returns an activity entry when the event is tool-related, otherwise undefined.
	 */
	consume(event: DaemonSSEEvent): ToolActivityEntry | undefined {
		switch (event.status) {
			case 'tool_call': {
				this.toolCount++;
				const args = formatArgs(event.args);
				const lines = [`→ ${event.tool ?? 'tool'}`];
				if (args) {
					lines.push(args);
				}
				lines.push('');
				return { text: lines.join('\n'), tool: event.tool, toolCount: this.toolCount };
			}
			case 'approved': {
				const how = event.auto ? 'auto-approved' : 'allowed';
				return {
					text: `  (${how})\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
			}
			case 'tool_result': {
				const preview = formatResultPreview(event);
				return {
					text: preview ? `← ${preview}\n\n` : `← (empty result)\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
			}
			case 'tool_error': {
				const err = event.error ?? 'unknown error';
				return {
					text: `← error: ${err}\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
			}
			case 'tool_denied':
				return {
					text: `  (denied)\n\n`,
					tool: event.tool,
					toolCount: this.toolCount,
				};
			default:
				return undefined;
		}
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
