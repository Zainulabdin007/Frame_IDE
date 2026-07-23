/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IFrameRagChunk, IFrameRagQuery, IFrameRagResult } from '../common/models.js';

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'be', 'this', 'that',
	'with', 'from', 'as', 'by', 'at', 'it', 'into', 'about', 'how', 'what', 'when', 'where', 'why',
	'fix', 'please', 'can', 'could', 'should', 'would', 'me', 'my', 'your', 'our', 'code', 'file',
]);

/**
 * Fully local lexical ranking — no embeddings, no network.
 */
export function rankChunks(query: IFrameRagQuery, chunks: readonly IFrameRagChunk[]): IFrameRagResult {
	const tokens = tokenize(query.text);
	const selectionTokens = query.selectionText ? tokenize(query.selectionText) : [];
	const activePath = query.activeUri ? normalizePath(query.activeUri.path) : undefined;

	const scored = chunks.map(chunk => {
		const score = scoreChunk(chunk, tokens, selectionTokens, activePath);
		return { chunk, score };
	}).filter(s => s.score > 0);

	scored.sort((a, b) => b.score - a.score);

	const limit = query.limit ?? 12;
	let maxChars = query.maxChars ?? 24_000;
	const selected: IFrameRagChunk[] = [];
	for (const item of scored) {
		if (selected.length >= limit) {
			break;
		}
		if (item.chunk.text.length > maxChars && selected.length > 0) {
			continue;
		}
		maxChars -= item.chunk.text.length;
		selected.push({ ...item.chunk, score: item.score });
	}

	const fileScores = new Map<string, number>();
	for (const c of selected) {
		const path = c.relativePath ?? c.uri.path;
		fileScores.set(path, Math.max(fileScores.get(path) ?? 0, c.score ?? 0));
	}
	const files = [...fileScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([path]) => path);

	return {
		query: query.text,
		chunks: selected,
		files,
	};
}

function scoreChunk(
	chunk: IFrameRagChunk,
	tokens: string[],
	selectionTokens: string[],
	activePath: string | undefined,
): number {
	if (!tokens.length && !selectionTokens.length && !activePath) {
		return 0;
	}

	const path = (chunk.relativePath ?? chunk.uri.path).toLowerCase();
	const base = path.split(/[/\\]/).pop() ?? path;
	const symbol = (chunk.symbolName ?? '').toLowerCase();
	const body = chunk.text.toLowerCase();
	const haystack = `${path} ${base} ${symbol} ${body}`;

	let score = 0;
	for (const token of tokens) {
		if (base.includes(token)) {
			score += 8;
		}
		if (path.includes(token)) {
			score += 4;
		}
		if (symbol.includes(token)) {
			score += 10;
		}
		const occurrences = countOccurrences(haystack, token);
		score += Math.min(occurrences, 12);
	}

	for (const token of selectionTokens) {
		if (body.includes(token)) {
			score += 3;
		}
	}

	if (activePath) {
		const chunkPath = normalizePath(chunk.uri.path);
		if (chunkPath === activePath) {
			score += 15;
		} else if (chunkPath.includes(activePath.split(/[/\\]/).pop() ?? '')) {
			score += 4;
		}
	}

	// Prefer structured chunks slightly
	if (chunk.kind === 'function' || chunk.kind === 'class') {
		score += 2;
	}

	return score;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.map(t => t.trim())
		.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count++;
		idx += needle.length;
		if (count >= 20) {
			break;
		}
	}
	return count;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').toLowerCase();
}

/** Convenience for tests / debugging: unique file basenames from a result. */
export function uniqueFileNames(result: IFrameRagResult): string[] {
	const names = new Set<string>();
	for (const path of result.files ?? []) {
		names.add(path.split(/[/\\]/).pop() ?? path);
	}
	return [...names];
}
