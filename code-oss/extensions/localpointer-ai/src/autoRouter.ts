/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — Cursor-like Auto model routing over local Ollama models
 *
 *  Cursor Router classifies each request by task type/complexity, then routes to a
 *  cheaper or stronger model. We mirror that locally: a small Ollama model classifies,
 *  then we pick from the installed pool based on Optimize For mode (cost/balance/intelligence).
 *--------------------------------------------------------------------------------------------*/

import { OllamaClient } from './ollama';

export type AutoOptimizeMode = 'cost' | 'balance' | 'intelligence';

export interface AutoRouteResult {
	model: string;
	complexity: 'simple' | 'moderate' | 'complex';
	reason: string;
	classifierModel?: string;
}

/** Virtual model id shown in the native picker for Auto routing. */
export const AUTO_MODEL_ID = 'auto';

export function isAutoModelId(id: string | undefined): boolean {
	if (!id) {
		return true;
	}
	const t = id.trim().toLowerCase();
	return t === '' || t === 'auto' || t === 'localpointer-auto' || t.startsWith('auto:');
}

export function parseAutoModeFromModelId(id: string | undefined, fallback: AutoOptimizeMode): AutoOptimizeMode {
	if (!id) {
		return fallback;
	}
	const m = id.trim().toLowerCase().match(/^auto:(cost|balance|intelligence)$/);
	return (m?.[1] as AutoOptimizeMode | undefined) ?? fallback;
}

interface RankedModel {
	name: string;
	/** Rough capability score from name heuristics (higher = stronger). */
	score: number;
	/** Rough cost/size score (lower = cheaper/faster). */
	cost: number;
}

/**
 * Heuristic ranking of Ollama model names by size tags and known families.
 * Not perfect, but good enough to split "cheap" vs "frontier" locally.
 */
export function rankModels(names: string[]): RankedModel[] {
	return names.map(name => {
		const lower = name.toLowerCase();
		let params = 7;
		const paramMatch = lower.match(/:(\d+(?:\.\d+)?)[bB]/) || lower.match(/(\d+(?:\.\d+)?)[bB]/);
		if (paramMatch) {
			params = parseFloat(paramMatch[1]);
		} else if (lower.includes('0.8b') || lower.includes('0.5b')) {
			params = 0.8;
		} else if (lower.includes('mini') || lower.includes('tiny')) {
			params = 1.5;
		} else if (lower.includes('large') || lower.includes('70b')) {
			params = 70;
		}

		let familyBonus = 0;
		if (lower.includes('deepseek-r1') || lower.includes('r1')) {
			familyBonus = 8;
		} else if (lower.includes('qwen3')) {
			familyBonus = 4;
		} else if (lower.includes('qwen2.5')) {
			familyBonus = 3;
		} else if (lower.includes('llama3.1') || lower.includes('llama3.2')) {
			familyBonus = 2;
		}

		const visionPenalty = lower.includes('vision') || lower.includes('llava') ? -5 : 0;
		const score = params + familyBonus + visionPenalty;
		const cost = params + (familyBonus > 5 ? 2 : 0);
		return { name, score, cost };
	}).sort((a, b) => a.score - b.score);
}

function pickByMode(ranked: RankedModel[], complexity: AutoRouteResult['complexity'], mode: AutoOptimizeMode): RankedModel {
	if (ranked.length === 0) {
		throw new Error('No Ollama models available for Auto routing');
	}
	const byCost = [...ranked].sort((a, b) => a.cost - b.cost || a.score - b.score);
	const byScore = [...ranked].sort((a, b) => b.score - a.score || a.cost - b.cost);

	const cheap = byCost[0];
	const mid = byScore[Math.floor((byScore.length - 1) / 2)] ?? byScore[0];
	const strong = byScore[0];

	if (mode === 'cost') {
		if (complexity === 'complex') {
			return mid;
		}
		return cheap;
	}
	if (mode === 'intelligence') {
		if (complexity === 'simple') {
			return mid;
		}
		return strong;
	}
	// balance
	if (complexity === 'simple') {
		return cheap;
	}
	if (complexity === 'complex') {
		return strong;
	}
	return mid;
}

function heuristicComplexity(prompt: string): AutoRouteResult['complexity'] {
	const text = prompt.trim();
	const len = text.length;
	const lower = text.toLowerCase();
	const complexHints = [
		'refactor', 'architect', 'migrate', 'debug', 'race condition', 'deadlock',
		'multi-file', 'entire codebase', 'design pattern', 'implement', 'write a',
		'from scratch', 'security', 'performance', 'optimize', 'test suite',
	];
	const simpleHints = [
		'what is', 'explain', 'rename', 'typo', 'comment', 'docstring',
		'summarize', 'translate', 'format', 'one line', 'quick',
	];

	let score = 0;
	if (len > 1200) {
		score += 2;
	} else if (len > 400) {
		score += 1;
	}
	for (const h of complexHints) {
		if (lower.includes(h)) {
			score += 1;
		}
	}
	for (const h of simpleHints) {
		if (lower.includes(h)) {
			score -= 1;
		}
	}
	if ((text.match(/```/g) || []).length >= 2) {
		score += 1;
	}
	if (score <= 0) {
		return 'simple';
	}
	if (score >= 3) {
		return 'complex';
	}
	return 'moderate';
}

function parseComplexity(raw: string): AutoRouteResult['complexity'] | undefined {
	const t = raw.trim().toLowerCase();
	if (t.includes('complex')) {
		return 'complex';
	}
	if (t.includes('moderate') || t.includes('medium')) {
		return 'moderate';
	}
	if (t.includes('simple') || t.includes('easy') || t.includes('trivial')) {
		return 'simple';
	}
	return undefined;
}

async function classifyWithModel(
	ollama: OllamaClient,
	classifierModel: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<AutoRouteResult['complexity'] | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	const onOuterAbort = () => controller.abort();
	signal?.addEventListener('abort', onOuterAbort);
	try {
		const reply = await ollama.chat(classifierModel, [
			{
				role: 'system',
				content: 'Classify the coding request. Reply with exactly one word and nothing else: simple OR moderate OR complex.',
			},
			{
				role: 'user',
				content: prompt.slice(0, 1500),
			},
		], controller.signal);
		if (controller.signal.aborted) {
			return undefined;
		}
		// Strip common reasoning wrappers before parsing.
		const cleaned = reply
			.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
			.replace(/```[\s\S]*?```/g, ' ')
			.trim();
		return parseComplexity(cleaned) ?? parseComplexity(reply);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onOuterAbort);
	}
}

function pickClassifierModel(ranked: RankedModel[]): string | undefined {
	const byCost = [...ranked].sort((a, b) => a.cost - b.cost);
	// Prefer tiny non-reasoning instruct models for classification.
	const preferred = byCost.find(m => {
		const n = m.name.toLowerCase();
		if (n.includes('deepseek-r1') || n.includes('r1') || n.includes('vision') || n.includes('llava')) {
			return false;
		}
		return n.includes('0.8b') || n.includes('1.5b') || n.includes('1b') || n.includes('2b') || n.includes('3b');
	});
	return (preferred ?? byCost.find(m => {
		const n = m.name.toLowerCase();
		return !n.includes('deepseek-r1') && !n.includes('vision') && !n.includes('llava');
	}) ?? byCost[0])?.name;
}

/**
 * Route an Auto request to a concrete Ollama model.
 */
export async function routeAutoModel(
	ollama: OllamaClient,
	prompt: string,
	mode: AutoOptimizeMode = 'balance',
	signal?: AbortSignal,
): Promise<AutoRouteResult> {
	const names = await ollama.listModels();
	const usable = names.filter(n => {
		const l = n.toLowerCase();
		return !l.includes('embed') && !l.includes('whisper');
	});
	if (usable.length === 0) {
		throw new Error('No Ollama models available. Pull one with `ollama pull`.');
	}

	const allRanked = rankModels(usable);
	const classifierModel = pickClassifierModel(allRanked);
	let complexity = heuristicComplexity(prompt);
	let reason = 'heuristic';

	if (classifierModel && usable.length > 1) {
		const classified = await classifyWithModel(ollama, classifierModel, prompt, signal);
		if (classified) {
			complexity = classified;
			reason = `classifier:${classifierModel}`;
		}
	}

	// Sub-3B models are useful classifiers, but commonly get stuck in tool
	// loops. Keep them out of the agent pool whenever a larger model exists.
	const agentSized = allRanked.filter(model => model.cost >= 3);
	const ranked = agentSized.length > 0 ? agentSized : allRanked;
	const picked = pickByMode(ranked, complexity, mode);
	return {
		model: picked.name,
		complexity,
		reason,
		classifierModel,
	};
}
