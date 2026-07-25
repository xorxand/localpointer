/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

export interface OllamaModel {
	name: string;
	model: string;
	size?: number;
	digest?: string;
	modified_at?: string;
}

export interface OllamaMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface OllamaChatStats {
	total_duration?: number;
	load_duration?: number;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface OllamaTagsResponse {
	models: OllamaModel[];
}

interface OllamaChatChunk {
	model?: string;
	message?: { role?: string; content?: string };
	done?: boolean;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_count?: number;
	eval_count?: number;
}

export class OllamaClient {
	constructor(private readonly baseUrl: string) { }

	getBaseUrl(): string {
		return this.baseUrl;
	}

	async health(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
			return resp.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		const resp = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
		if (!resp.ok) {
			throw new Error(`Ollama tags failed: ${resp.status}`);
		}
		const data = (await resp.json()) as OllamaTagsResponse;
		return (data.models ?? []).map(m => m.name || m.model).filter(Boolean);
	}

	async chat(model: string, messages: OllamaMessage[]): Promise<string> {
		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, messages, stream: false }),
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Ollama chat failed (${resp.status}): ${body}`);
		}
		const chunk = (await resp.json()) as OllamaChatChunk;
		return chunk.message?.content ?? '';
	}

	async streamChat(
		model: string,
		messages: OllamaMessage[],
		onToken: (token: string) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<{ content: string; stats: OllamaChatStats }> {
		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, messages, stream: true }),
			signal,
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Ollama stream failed (${resp.status}): ${body}`);
		}
		if (!resp.body) {
			throw new Error('Ollama stream returned no body');
		}

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let full = '';
		const stats: OllamaChatStats = {};

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				let chunk: OllamaChatChunk;
				try {
					chunk = JSON.parse(trimmed) as OllamaChatChunk;
				} catch {
					continue;
				}
				const token = chunk.message?.content ?? '';
				if (token) {
					full += token;
					await onToken(token);
				}
				if (chunk.done) {
					stats.total_duration = chunk.total_duration;
					stats.load_duration = chunk.load_duration;
					stats.prompt_eval_count = chunk.prompt_eval_count;
					stats.eval_count = chunk.eval_count;
				}
			}
		}

		return { content: full, stats };
	}

	async complete(model: string, prefix: string, suffix: string, languageId: string): Promise<string> {
		try {
			const fim = await this.generateFim(model, prefix, suffix);
			if (fim.trim()) {
				return fim;
			}
		} catch {
			// fall through to chat completion
		}

		const messages: OllamaMessage[] = [
			{
				role: 'system',
				content: 'You are a code completion engine. Return only the text that should be inserted at the cursor. No markdown fences, no explanation.',
			},
			{
				role: 'user',
				content: `Language: ${languageId || 'plaintext'}\n\nCode before cursor:\n${prefix}\n\nCode after cursor:\n${suffix}\n\nCompletion:`,
			},
		];
		const result = await this.chat(model, messages);
		return stripCodeFences(result);
	}

	private async generateFim(model: string, prefix: string, suffix: string): Promise<string> {
		const resp = await fetch(`${this.baseUrl}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				prompt: prefix,
				suffix,
				stream: false,
				raw: true,
				options: { stop: ['\n\n'] },
			}),
		});
		if (!resp.ok) {
			throw new Error(`Ollama generate failed: ${resp.status}`);
		}
		const data = (await resp.json()) as { response?: string };
		return data.response ?? '';
	}
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fence = /^```[\w]*\n([\s\S]*?)\n```$/;
	const m = fence.exec(trimmed);
	return m ? m[1] : trimmed;
}
