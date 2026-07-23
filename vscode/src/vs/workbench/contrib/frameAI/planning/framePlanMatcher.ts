/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	FRAME_PLAN_TEMPLATE_HIGH_CONFIDENCE,
	IFramePlanTemplate,
	IFramePlanTemplateMatch,
} from './framePlanTemplates.js';

export interface IFramePlanMatchContext {
	readonly prompt: string;
	readonly languageId?: string;
	readonly projectType?: string;
}

/**
 * Deterministic template matcher — simple keyword / language / project scoring.
 * No AI.
 */
export class FramePlanMatcher {

	match(templates: readonly IFramePlanTemplate[], context: IFramePlanMatchContext): IFramePlanTemplateMatch[] {
		const prompt = context.prompt.toLowerCase();
		const language = (context.languageId ?? '').toLowerCase();
		const projectType = (context.projectType ?? '').toLowerCase();

		const scored: IFramePlanTemplateMatch[] = [];
		for (const template of templates) {
			const reasons: string[] = [];
			let score = 0;

			for (const pattern of template.triggerPatterns) {
				const p = pattern.toLowerCase();
				if (prompt.includes(p)) {
					score += 15;
					reasons.push(`trigger:${pattern}`);
				}
			}

			for (const example of template.examplePrompts) {
				const tokens = example.toLowerCase().split(/\s+/).filter(t => t.length > 3);
				let hits = 0;
				for (const t of tokens) {
					if (prompt.includes(t)) {
						hits++;
					}
				}
				if (hits >= 2) {
					score += 10;
					reasons.push('example-overlap');
					break;
				}
			}

			if (language && template.supportedLanguages.length) {
				if (template.supportedLanguages.some(l => language.includes(l.toLowerCase()) || l.toLowerCase().includes(language))) {
					score += 12;
					reasons.push(`language:${language}`);
				}
			} else if (!template.supportedLanguages.length) {
				score += 2;
			}

			if (projectType && template.projectTypes?.length) {
				if (template.projectTypes.includes('any') || template.projectTypes.some(p => projectType.includes(p))) {
					score += 10;
					reasons.push(`project:${projectType}`);
				}
			}

			if (template.favorite) {
				score += 5;
				reasons.push('favorite');
			}

			score += Math.min(8, Math.floor(template.usageCount / 3));

			if (score > 0) {
				scored.push({ template, score, reasons });
			}
		}

		return scored.sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name));
	}

	bestMatch(templates: readonly IFramePlanTemplate[], context: IFramePlanMatchContext): IFramePlanTemplateMatch | undefined {
		const all = this.match(templates, context);
		const best = all[0];
		if (!best || best.score < FRAME_PLAN_TEMPLATE_HIGH_CONFIDENCE) {
			return undefined;
		}
		return best;
	}
}

export const defaultFramePlanMatcher = new FramePlanMatcher();
