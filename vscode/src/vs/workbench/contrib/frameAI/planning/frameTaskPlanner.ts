/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { IFrameInferenceContext } from '../common/models.js';
import { FrameToolName } from '../runtime/tools/frameTools.js';
import {
	createStepId,
	IFrameExecutionPlan,
	IFramePlanStep,
	isFramePlanningIntent,
} from './frameTaskPlan.js';
import { IFramePlanTemplate, IFramePlanTemplateMatch, planFromTemplate } from './framePlanTemplates.js';

export interface IFrameTaskPlannerInput {
	readonly taskId: string;
	readonly prompt: string;
	readonly context: IFrameInferenceContext;
	/** When set, materialize steps from this template instead of rule defaults. */
	readonly template?: IFramePlanTemplate;
	/** Attached suggestion metadata (even when template not applied). */
	readonly suggestion?: IFramePlanTemplateMatch;
}

/**
 * Deterministic rule-based planner.
 * Optional template materialization — execution pipeline unchanged.
 * No model calls.
 */
export class FrameTaskPlanner {

	buildPlan(input: IFrameTaskPlannerInput): IFrameExecutionPlan {
		const { taskId, prompt, context, template, suggestion } = input;

		if (template) {
			const fromTemplate = planFromTemplate(template, taskId, prompt, context.activeRelativePath);
			return {
				...fromTemplate,
				suggestedTemplateId: suggestion?.template.id ?? template.id,
				suggestedTemplateName: suggestion?.template.name ?? template.name,
				suggestedTemplateScore: suggestion?.score ?? 100,
			};
		}

		const plan = this.buildRuleBasedPlan(taskId, prompt, context);
		if (suggestion) {
			return {
				...plan,
				suggestedTemplateId: suggestion.template.id,
				suggestedTemplateName: suggestion.template.name,
				suggestedTemplateScore: suggestion.score,
				summary: `${plan.summary} Suggested template: ${suggestion.template.name} (score ${suggestion.score}).`,
			};
		}
		return plan;
	}

	private buildRuleBasedPlan(taskId: string, prompt: string, context: IFrameInferenceContext): IFrameExecutionPlan {
		const lower = prompt.toLowerCase();
		const keywords = extractKeywords(prompt);
		const requiredFiles = collectRequiredFiles(context, keywords);
		const steps: IFramePlanStep[] = [];

		const searchId = createStepId();
		const grepId = createStepId();
		const readId = createStepId();
		const listId = createStepId();
		const analyzeId = createStepId();
		const editId = createStepId();
		const verifyId = createStepId();

		const query = keywords[0] || 'frame';
		const wantsSearch = true;
		const wantsGrep = /\b(refactor|fix|find|where|usage|reference)\b/i.test(lower) || keywords.length > 0;
		const wantsRead = !!context.activeRelativePath || requiredFiles.length > 0;
		const wantsEdit = isFramePlanningIntent(prompt)
			|| /\b(edit|create|fix|implement|refactor|update|add|delete|rename)\b/i.test(lower);
		const wantsSymbol = /\b(symbol|class|function|interface|type|method)\b/i.test(lower) || !!(context.relatedSymbols?.length);
		const wantsDeps = /\b(dependenc|import|module|package)\b/i.test(lower) || !!(context.dependencyGraph?.length);
		const wantsCalls = /\b(call\s*chain|caller|callee|call\s*hierarch)\b/i.test(lower) || !!(context.callHierarchy?.length);

		if (wantsSearch) {
			steps.push({
				id: searchId,
				kind: 'search',
				title: 'Search workspace',
				description: `searchWorkspace for "${query}"`,
				dependsOn: [],
				tools: ['searchWorkspace'],
				toolArgs: { query, limit: 20 },
				expectedOutput: 'Matching file paths',
				status: 'pending',
				parallelizable: true,
				enabled: true,
				notes: '',
			});
		}

		if (wantsGrep) {
			steps.push({
				id: grepId,
				kind: 'search',
				title: 'Grep workspace',
				description: `grepWorkspace for "${query}"`,
				dependsOn: [],
				tools: ['grepWorkspace'],
				toolArgs: { pattern: query, limit: 20 },
				expectedOutput: 'Content hits with line previews',
				status: 'pending',
				parallelizable: true,
				enabled: true,
				notes: '',
			});
		}

		const symbolId = createStepId();
		const depsId = createStepId();
		const callsId = createStepId();
		const moduleId = createStepId();

		if (wantsSymbol) {
			steps.push({
				id: symbolId,
				kind: 'search',
				title: 'Find Symbol',
				description: `findSymbol for "${query}"`,
				dependsOn: [],
				tools: ['findSymbol'],
				toolArgs: { name: query, limit: 20 },
				expectedOutput: 'Knowledge-graph symbol matches',
				status: 'pending',
				parallelizable: true,
				enabled: true,
				notes: '',
			});
		}

		if (wantsDeps || wantsEdit) {
			steps.push({
				id: depsId,
				kind: 'analyze',
				title: 'Analyze Dependency',
				description: `findDependencies for ${context.activeRelativePath || requiredFiles[0] || query}`,
				dependsOn: wantsSymbol ? [symbolId] : [],
				tools: ['findDependencies'],
				toolArgs: { path: context.activeRelativePath || requiredFiles[0] || '', limit: 20 },
				expectedOutput: 'Import dependencies and dependents',
				status: 'pending',
				parallelizable: false,
				enabled: true,
				notes: '',
			});
		}

		if (wantsCalls) {
			steps.push({
				id: callsId,
				kind: 'analyze',
				title: 'Analyze Call Chain',
				description: `findCallers for "${query}"`,
				dependsOn: wantsSymbol ? [symbolId] : [],
				tools: ['findCallers'],
				toolArgs: { name: query, limit: 20 },
				expectedOutput: 'Caller nodes from knowledge graph',
				status: 'pending',
				parallelizable: true,
				enabled: true,
				notes: '',
			});
		}

		if (wantsDeps || /\bmodule\b/i.test(lower)) {
			steps.push({
				id: moduleId,
				kind: 'analyze',
				title: 'Analyze Module',
				description: `findImplementations / exports for "${query}"`,
				dependsOn: wantsSymbol ? [symbolId] : [],
				tools: ['findImplementations'],
				toolArgs: { name: query, limit: 20 },
				expectedOutput: 'Implementations and derived types',
				status: 'pending',
				parallelizable: true,
				enabled: true,
				notes: '',
			});
		}

		const readPath = context.activeRelativePath || requiredFiles[0] || 'README.md';
		if (wantsRead) {
			steps.push({
				id: readId,
				kind: 'read',
				title: 'Read primary file',
				description: `readFile ${readPath}`,
				dependsOn: wantsSearch ? [searchId] : [],
				tools: ['readFile'],
				toolArgs: { path: readPath, maxBytes: 8000 },
				expectedOutput: 'File contents (truncated)',
				status: 'pending',
				parallelizable: false,
				enabled: true,
				notes: '',
			});
		}

		steps.push({
			id: listId,
			kind: 'read',
			title: 'List project root',
			description: 'listFiles at workspace root',
			dependsOn: [],
			tools: ['listFiles'],
			toolArgs: { path: '.', limit: 40 },
			expectedOutput: 'Top-level entries',
			status: 'pending',
			parallelizable: true,
			enabled: true,
			notes: '',
		});

		const analyzeDeps = [
			wantsSearch ? searchId : undefined,
			wantsGrep ? grepId : undefined,
			wantsRead ? readId : undefined,
			wantsSymbol ? symbolId : undefined,
			(wantsDeps || wantsEdit) ? depsId : undefined,
			wantsCalls ? callsId : undefined,
			(wantsDeps || /\bmodule\b/i.test(lower)) ? moduleId : undefined,
			listId,
		].filter((x): x is string => !!x);

		steps.push({
			id: analyzeId,
			kind: 'analyze',
			title: 'Analyze request',
			description: 'Deterministic analysis of prompt + gathered tool outputs',
			dependsOn: analyzeDeps,
			tools: [],
			expectedOutput: 'Structured analysis notes',
			status: 'pending',
			parallelizable: false,
			enabled: true,
			notes: '',
		});

		if (wantsEdit) {
			steps.push({
				id: editId,
				kind: 'edit',
				title: 'Prepare edit plan',
				description: 'Build stub workspace edit plan for preview',
				dependsOn: [analyzeId],
				tools: [],
				expectedOutput: 'IFrameEditPlan (preview only)',
				status: 'pending',
				parallelizable: false,
				enabled: true,
				notes: '',
			});
		}

		steps.push({
			id: verifyId,
			kind: 'verify',
			title: 'Verify readiness',
			description: 'Confirm plan outputs and workspace state',
			dependsOn: wantsEdit ? [editId] : [analyzeId],
			tools: ['gitStatus'],
			toolArgs: {},
			expectedOutput: 'Verification summary',
			status: 'pending',
			parallelizable: false,
			enabled: true,
			notes: '',
		});

		const deduped = dedupeSteps(steps);
		const requiredTools = uniqueTools(deduped);
		const expectedOutputs = deduped.map(s => s.expectedOutput);
		const summary = `Deterministic plan: ${deduped.length} step(s), ${requiredTools.length} tool(s), ${requiredFiles.length} focus file(s).`;

		return {
			id: generateUuid(),
			taskId,
			prompt,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			summary,
			steps: deduped,
			requiredFiles,
			requiredTools,
			expectedOutputs,
			phase: 'idle',
			status: 'planned',
			deterministic: true,
		};
	}
}

function extractKeywords(prompt: string): string[] {
	const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'please', 'a', 'an', 'to', 'of', 'in', 'on']);
	return prompt
		.toLowerCase()
		.replace(/[^a-z0-9_\-\s]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 2 && !stop.has(w))
		.slice(0, 6);
}

function collectRequiredFiles(context: IFrameInferenceContext, keywords: string[]): string[] {
	const files: string[] = [];
	if (context.activeRelativePath) {
		files.push(context.activeRelativePath);
	}
	for (const f of context.affectedFiles ?? []) {
		if (files.length >= 8) {
			break;
		}
		if (!files.includes(f)) {
			files.push(f);
		}
	}
	for (const f of context.relatedFiles) {
		if (files.length >= 8) {
			break;
		}
		if (!files.includes(f)) {
			files.push(f);
		}
	}
	if (keywords.length && files.length < 3) {
		for (const f of context.openFiles) {
			const rel = f.relativePath;
			if (!rel || files.includes(rel)) {
				continue;
			}
			if (keywords.some(k => rel.toLowerCase().includes(k))) {
				files.push(rel);
			}
			if (files.length >= 8) {
				break;
			}
		}
	}
	return files;
}

/** Collapse duplicate tool+args work into a single step. */
function dedupeSteps(steps: readonly IFramePlanStep[]): IFramePlanStep[] {
	const seen = new Map<string, string>();
	const idRemap = new Map<string, string>();
	const out: IFramePlanStep[] = [];

	for (const step of steps) {
		const key = stepKey(step);
		const existingId = seen.get(key);
		if (existingId && step.tools.length > 0) {
			idRemap.set(step.id, existingId);
			continue;
		}
		if (step.tools.length > 0) {
			seen.set(key, step.id);
		}
		out.push(step);
	}

	return out.map(step => ({
		...step,
		dependsOn: step.dependsOn
			.map(d => idRemap.get(d) ?? d)
			.filter(d => d !== step.id)
			.filter((d, i, arr) => arr.indexOf(d) === i)
			.filter(d => out.some(s => s.id === d) || idRemap.has(d)),
	})).map(step => ({
		...step,
		dependsOn: step.dependsOn.filter(d => out.some(s => s.id === d)),
	}));
}

function stepKey(step: IFramePlanStep): string {
	const tool = step.tools[0] ?? step.kind;
	const args = JSON.stringify(step.toolArgs ?? {});
	return `${tool}::${args}`;
}

function uniqueTools(steps: readonly IFramePlanStep[]): FrameToolName[] {
	const set = new Set<FrameToolName>();
	for (const s of steps) {
		for (const t of s.tools) {
			set.add(t);
		}
	}
	return [...set];
}

export const defaultFrameTaskPlanner = new FrameTaskPlanner();
