/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { FrameRagChunkKind, IFrameRagChunk } from '../common/models.js';

interface IChunkMatch {
	readonly kind: FrameRagChunkKind;
	readonly name: string;
	readonly startLine: number; // 1-based
	readonly endLine: number;
}

/**
 * Prefer function / class / module boundaries; fall back to sized blocks.
 */
export function chunkSource(params: {
	uri: URI;
	relativePath: string;
	language: string;
	text: string;
}): IFrameRagChunk[] {
	const { uri, relativePath, language, text } = params;
	const lines = text.split(/\r\n|\n|\r/);
	const matches = findStructuralMatches(lines, language);

	const chunks: IFrameRagChunk[] = [];
	if (matches.length) {
		for (const match of matches) {
			const slice = lines.slice(match.startLine - 1, match.endLine).join('\n');
			if (!slice.trim()) {
				continue;
			}
			chunks.push(makeChunk({
				uri,
				relativePath,
				language,
				kind: match.kind,
				symbolName: match.name,
				startLine: match.startLine,
				endLine: match.endLine,
				text: slice,
			}));
		}
		return chunks;
	}

	// Fallback: ~80-line overlapping blocks
	const blockSize = 80;
	const overlap = 10;
	for (let start = 0; start < lines.length; start += blockSize - overlap) {
		const end = Math.min(lines.length, start + blockSize);
		const slice = lines.slice(start, end).join('\n');
		if (!slice.trim()) {
			continue;
		}
		chunks.push(makeChunk({
			uri,
			relativePath,
			language,
			kind: FrameRagChunkKind.Block,
			startLine: start + 1,
			endLine: end,
			text: slice,
		}));
		if (end >= lines.length) {
			break;
		}
	}

	// Module-level summary chunk (first ~40 lines) when file is large
	if (lines.length > 40 && chunks.every(c => c.kind === FrameRagChunkKind.Block)) {
		chunks.unshift(makeChunk({
			uri,
			relativePath,
			language,
			kind: FrameRagChunkKind.Module,
			symbolName: relativePath.split(/[/\\]/).pop(),
			startLine: 1,
			endLine: Math.min(40, lines.length),
			text: lines.slice(0, 40).join('\n'),
		}));
	}

	return chunks;
}

export function extractSymbolNames(text: string, language: string): string[] {
	const lines = text.split(/\r\n|\n|\r/);
	return findStructuralMatches(lines, language).map(m => m.name).filter(Boolean);
}

function makeChunk(input: {
	uri: URI;
	relativePath: string;
	language: string;
	kind: FrameRagChunkKind;
	symbolName?: string;
	startLine: number;
	endLine: number;
	text: string;
}): IFrameRagChunk {
	return {
		id: generateUuid(),
		uri: input.uri,
		relativePath: input.relativePath,
		language: input.language,
		kind: input.kind,
		symbolName: input.symbolName,
		startLine: input.startLine,
		endLine: input.endLine,
		text: input.text,
		metadata: {
			path: input.relativePath,
			language: input.language,
			kind: input.kind,
		},
	};
}

function findStructuralMatches(lines: string[], language: string): IChunkMatch[] {
	const lang = language.toLowerCase();
	const patterns = patternsForLanguage(lang);
	if (!patterns.length) {
		return [];
	}

	const starts: { kind: FrameRagChunkKind; name: string; line: number; indent: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const pattern of patterns) {
			const m = line.match(pattern.regex);
			if (!m) {
				continue;
			}
			const name = (m[1] || m[2] || 'anonymous').trim();
			starts.push({
				kind: pattern.kind,
				name,
				line: i + 1,
				indent: leadingIndent(line),
			});
			break;
		}
	}

	const matches: IChunkMatch[] = [];
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		let endLine = lines.length;
		for (let j = i + 1; j < starts.length; j++) {
			if (starts[j].indent <= start.indent) {
				endLine = starts[j].line - 1;
				break;
			}
		}
		// For brace languages, extend to closing brace when possible
		if (isBraceLanguage(lang)) {
			endLine = Math.max(endLine, findBraceEnd(lines, start.line - 1));
		}
		endLine = Math.max(start.line, Math.min(endLine, lines.length));
		// Cap very large chunks
		if (endLine - start.line > 250) {
			endLine = start.line + 250;
		}
		matches.push({
			kind: start.kind,
			name: start.name,
			startLine: start.line,
			endLine,
		});
	}
	return matches;
}

function patternsForLanguage(language: string): { kind: FrameRagChunkKind; regex: RegExp }[] {
	switch (language) {
		case 'typescript':
		case 'typescriptreact':
		case 'javascript':
		case 'javascriptreact':
			return [
				{ kind: FrameRagChunkKind.Class, regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:public|private|protected|static|async|\s)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|typeof\b|new\b)([A-Za-z0-9_$]+)\s*\([^;]*\)\s*\{/ },
			];
		case 'python':
			return [
				{ kind: FrameRagChunkKind.Class, regex: /^\s*class\s+([A-Za-z0-9_]+)/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
			];
		case 'go':
			return [
				{ kind: FrameRagChunkKind.Function, regex: /^func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)/ },
				{ kind: FrameRagChunkKind.Class, regex: /^type\s+([A-Za-z0-9_]+)\s+struct/ },
			];
		case 'rust':
			return [
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
				{ kind: FrameRagChunkKind.Class, regex: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/ },
				{ kind: FrameRagChunkKind.Class, regex: /^\s*impl(?:\s*<[^>]+>)?\s+(?:[A-Za-z0-9_:]+\s+for\s+)?([A-Za-z0-9_]+)/ },
			];
		case 'java':
		case 'kotlin':
		case 'csharp':
			return [
				{ kind: FrameRagChunkKind.Class, regex: /^\s*(?:public|private|protected|internal|static|abstract|final|\s)*(?:class|interface|enum|record|object)\s+([A-Za-z0-9_]+)/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:public|private|protected|internal|static|async|override|\s)*[\w<>\[\]]+\s+([A-Za-z0-9_]+)\s*\(/ },
			];
		default:
			return [
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/ },
				{ kind: FrameRagChunkKind.Class, regex: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/ },
				{ kind: FrameRagChunkKind.Function, regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
			];
	}
}

function isBraceLanguage(language: string): boolean {
	return !['python', 'yaml', 'markdown', 'shellscript'].includes(language);
}

function leadingIndent(line: string): number {
	const m = line.match(/^(\s*)/);
	return m ? m[1].length : 0;
}

function findBraceEnd(lines: string[], startIdx: number): number {
	let depth = 0;
	let seen = false;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		for (const ch of line) {
			if (ch === '{') {
				depth++;
				seen = true;
			} else if (ch === '}') {
				depth--;
				if (seen && depth <= 0) {
					return i + 1;
				}
			}
		}
	}
	return Math.min(lines.length, startIdx + 120);
}
