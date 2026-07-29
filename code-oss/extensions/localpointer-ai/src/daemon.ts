/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

export interface DaemonWorkspace {
	id: number;
	name: string;
	path: string;
	model?: string;
	system_prompt?: string;
}

export interface DaemonChatRequest {
	workspace_id: number;
	conversation_id?: number;
	message: string;
	model?: string;
	active_file?: string;
	selection?: string;
	auto_approve?: boolean;
	plan?: boolean;
}

export interface DaemonSSEEvent {
	status?: string;
	token?: string;
	thinking?: string;
	error?: string;
	done?: boolean;
	conversation_id?: number;
	model?: string;
	stats?: Record<string, unknown>;
	trace?: unknown[];
	steps?: unknown[];
	id?: string;
	tool?: string;
	args?: Record<string, unknown>;
	/** Truncated tool result text (tool_result). */
	content?: string;
	kind?: string;
	data?: unknown;
	path?: string;
	auto?: boolean;
}

export interface DaemonInlineEditRequest {
	workspace_id?: number;
	model?: string;
	instruction: string;
	file_path?: string;
	language?: string;
	selection: string;
	prefix?: string;
	suffix?: string;
}

export interface DaemonInlineEditResponse {
	text: string;
	model?: string;
	stats?: Record<string, unknown>;
}

export interface DaemonCompleteRequest {
	model?: string;
	prefix: string;
	suffix: string;
	language?: string;
}

export class DaemonClient {
	constructor(private readonly baseUrl: string) { }

	getBaseUrl(): string {
		return this.baseUrl;
	}

	async health(): Promise<{ ok: boolean; ollama?: boolean }> {
		try {
			const resp = await fetch(`${this.baseUrl}/api/health`);
			if (!resp.ok) {
				return { ok: false };
			}
			const data = (await resp.json()) as { ok?: boolean; ollama?: boolean };
			return { ok: !!data.ok, ollama: data.ollama };
		} catch {
			return { ok: false };
		}
	}

	async models(): Promise<string[]> {
		const resp = await fetch(`${this.baseUrl}/api/models`);
		if (!resp.ok) {
			throw new Error(`Daemon models failed: ${resp.status}`);
		}
		const data = (await resp.json()) as { models?: Array<{ name?: string }> };
		return (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
	}

	async listWorkspaces(): Promise<DaemonWorkspace[]> {
		const resp = await fetch(`${this.baseUrl}/api/workspaces`);
		if (!resp.ok) {
			throw new Error(`Daemon workspaces failed: ${resp.status}`);
		}
		const data = (await resp.json()) as { workspaces?: DaemonWorkspace[] };
		return data.workspaces ?? [];
	}

	async createWorkspace(name: string, path: string, model = ''): Promise<DaemonWorkspace> {
		const resp = await fetch(`${this.baseUrl}/api/workspaces`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, path, model }),
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Create workspace failed (${resp.status}): ${body}`);
		}
		return (await resp.json()) as DaemonWorkspace;
	}

	async ensureWorkspace(path: string): Promise<number> {
		const normalized = path.replace(/\\/g, '/');
		const workspaces = await this.listWorkspaces();
		const existing = workspaces.find(w => w.path.replace(/\\/g, '/') === normalized);
		if (existing) {
			return existing.id;
		}
		const name = path.split(/[/\\]/).filter(Boolean).pop() || 'Workspace';
		const ws = await this.createWorkspace(name, path);
		return ws.id;
	}

	async approve(id: string, decision: 'allow' | 'deny' | 'edit', args?: Record<string, unknown>): Promise<void> {
		const resp = await fetch(`${this.baseUrl}/api/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, decision, args: args ?? {} }),
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Approve failed (${resp.status}): ${body}`);
		}
	}

	async chat(
		req: DaemonChatRequest,
		onEvent: (event: DaemonSSEEvent) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(req),
			signal,
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Daemon chat failed (${resp.status}): ${body}`);
		}
		await parseSSE(resp, onEvent);
	}

	async complete(req: DaemonCompleteRequest): Promise<string> {
		const resp = await fetch(`${this.baseUrl}/api/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(req),
		});
		if (resp.status === 404) {
			throw new Error('daemon_complete_not_found');
		}
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Daemon complete failed (${resp.status}): ${body}`);
		}
		const data = (await resp.json()) as { text?: string; completion?: string };
		return data.text ?? data.completion ?? '';
	}

	async inlineEdit(req: DaemonInlineEditRequest): Promise<DaemonInlineEditResponse> {
		const resp = await fetch(`${this.baseUrl}/api/inline-edit`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(req),
		});
		if (resp.status === 404) {
			throw new Error('daemon_inline_edit_not_found');
		}
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Daemon inline edit failed (${resp.status}): ${body}`);
		}
		return (await resp.json()) as DaemonInlineEditResponse;
	}
}

async function parseSSE(
	resp: Response,
	onEvent: (event: DaemonSSEEvent) => void | Promise<void>,
): Promise<void> {
	if (!resp.body) {
		throw new Error('SSE response has no body');
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';

		for (const part of parts) {
			for (const line of part.split('\n')) {
				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (!payload) {
					continue;
				}
				try {
					const event = JSON.parse(payload) as DaemonSSEEvent;
					await onEvent(event);
				} catch {
					// ignore malformed SSE chunks
				}
			}
		}
	}
}
