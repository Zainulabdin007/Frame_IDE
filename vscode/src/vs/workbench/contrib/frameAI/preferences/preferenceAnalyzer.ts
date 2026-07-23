/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IFrameObservation } from '../common/models.js';

export interface IPreferenceSignalHit {
	readonly signalId: string;
	readonly preference: string;
	readonly language?: string;
	readonly confidence: number;
	readonly beforeSnippet: string;
	readonly afterSnippet: string;
}

/**
 * Heuristic preference extractor — no ML.
 * Detects repeated stylistic transforms from before/after pairs.
 */
export class PreferenceAnalyzer {

	analyzeObservation(observation: IFrameObservation): IPreferenceSignalHit[] {
		const before = observation.before;
		const after = observation.after;
		if (!before.trim() && !after.trim()) {
			return [];
		}
		if (before === after) {
			return [];
		}

		const hits: IPreferenceSignalHit[] = [];
		const language = observation.language;

		const tryHit = (signalId: string, preference: string, matched: boolean, confidence: number) => {
			if (!matched) {
				return;
			}
			hits.push({
				signalId,
				preference,
				language,
				confidence: clamp01(confidence * (observation.confidence || 0.7)),
				beforeSnippet: truncate(before),
				afterSnippet: truncate(after),
			});
		};

		tryHit(
			'iteration.foreach',
			'Prefers collection iteration (forEach / for-of) over classic for loops',
			detectForToForeach(before, after),
			0.75,
		);

		tryHit(
			'quotes.single',
			'Prefers single quotes over double quotes',
			detectQuotePreference(before, after, 'single'),
			0.7,
		);

		tryHit(
			'quotes.double',
			'Prefers double quotes over single quotes',
			detectQuotePreference(before, after, 'double'),
			0.7,
		);

		tryHit(
			'bindings.const',
			'Prefers const/let over var',
			detectVarToConstLet(before, after),
			0.8,
		);

		tryHit(
			'style.early_return',
			'Prefers early returns over nested conditionals',
			detectEarlyReturn(before, after),
			0.65,
		);

		tryHit(
			'style.trailing_comma',
			'Prefers trailing commas in multiline lists',
			detectTrailingComma(before, after),
			0.6,
		);

		tryHit(
			'style.semicolons',
			'Prefers semicolons',
			detectSemicolonPreference(before, after, true),
			0.55,
		);

		tryHit(
			'style.no_semicolons',
			'Prefers no semicolons',
			detectSemicolonPreference(before, after, false),
			0.55,
		);

		return hits;
	}
}

function detectForToForeach(before: string, after: string): boolean {
	const classicFor = /\bfor\s*\(\s*(?:let|var|int)\s+\w+\s*=/.test(before)
		|| /\bfor\s*\(\s*\w+\s*=\s*0\s*;/.test(before);
	const modern = /\bfor\s*\(\s*(?:const|let)\s+\w+\s+of\s+/.test(after)
		|| /\.forEach\s*\(/.test(after)
		|| /\bforeach\s*\(/i.test(after);
	const lostClassic = !/\bfor\s*\(\s*(?:let|var|int)\s+\w+\s*=/.test(after)
		&& !/\bfor\s*\(\s*\w+\s*=\s*0\s*;/.test(after);
	return classicFor && modern && lostClassic;
}

function detectQuotePreference(before: string, after: string, prefer: 'single' | 'double'): boolean {
	const beforeDouble = countChar(before, '"');
	const beforeSingle = countChar(before, '\'');
	const afterDouble = countChar(after, '"');
	const afterSingle = countChar(after, '\'');

	if (prefer === 'single') {
		return beforeDouble > afterDouble && afterSingle > beforeSingle && (beforeDouble - afterDouble) >= 2;
	}
	return beforeSingle > afterSingle && afterDouble > beforeDouble && (beforeSingle - afterSingle) >= 2;
}

function detectVarToConstLet(before: string, after: string): boolean {
	const beforeVar = (before.match(/\bvar\s+/g) || []).length;
	const afterVar = (after.match(/\bvar\s+/g) || []).length;
	const afterConstLet = (after.match(/\b(?:const|let)\s+/g) || []).length;
	const beforeConstLet = (before.match(/\b(?:const|let)\s+/g) || []).length;
	return beforeVar > afterVar && afterConstLet > beforeConstLet;
}

function detectEarlyReturn(before: string, after: string): boolean {
	const beforeNest = (before.match(/\bif\s*\(/g) || []).length;
	const afterNest = (after.match(/\bif\s*\(/g) || []).length;
	const afterReturns = (after.match(/\breturn\b/g) || []).length;
	const beforeReturns = (before.match(/\breturn\b/g) || []).length;
	return afterReturns > beforeReturns && afterNest <= beforeNest && beforeNest >= 2;
}

function detectTrailingComma(before: string, after: string): boolean {
	const beforeTrail = (before.match(/,[ \t]*\n/g) || []).length;
	const afterTrail = (after.match(/,[ \t]*\n/g) || []).length;
	return afterTrail > beforeTrail && (afterTrail - beforeTrail) >= 1;
}

function detectSemicolonPreference(before: string, after: string, preferSemicolons: boolean): boolean {
	const beforeSemi = countChar(before, ';');
	const afterSemi = countChar(after, ';');
	if (preferSemicolons) {
		return afterSemi > beforeSemi && (afterSemi - beforeSemi) >= 2;
	}
	return beforeSemi > afterSemi && (beforeSemi - afterSemi) >= 2;
}

function countChar(text: string, ch: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === ch) {
			n++;
		}
	}
	return n;
}

function truncate(text: string, max = 240): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) {
		return 0;
	}
	return Math.min(1, Math.max(0, n));
}
