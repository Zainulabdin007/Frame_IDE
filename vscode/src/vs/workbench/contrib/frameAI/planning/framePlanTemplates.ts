/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { FrameToolName } from '../runtime/tools/frameTools.js';
import {
	createStepId,
	FramePlanStepKind,
	IFrameExecutionPlan,
	IFramePlanStep,
} from './frameTaskPlan.js';

/** On-disk / library plan template (no execution). */
export interface IFramePlanTemplate {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly category: FramePlanTemplateCategory;
	readonly supportedLanguages: readonly string[];
	readonly triggerPatterns: readonly string[];
	readonly defaultSteps: readonly IFramePlanTemplateStep[];
	readonly examplePrompts: readonly string[];
	readonly lastUsed: number | null;
	readonly usageCount: number;
	readonly editable: boolean;
	readonly favorite?: boolean;
	readonly source: FramePlanTemplateSource;
	readonly projectTypes?: readonly string[];
}

export type FramePlanTemplateCategory =
	| 'refactor'
	| 'backend'
	| 'frontend'
	| 'testing'
	| 'release'
	| 'general'
	| 'custom';

export type FramePlanTemplateSource = 'builtin' | 'workspace' | 'global' | 'imported';

export interface IFramePlanTemplateStep {
	readonly kind: FramePlanStepKind;
	readonly title: string;
	readonly description: string;
	readonly tools?: readonly FrameToolName[];
	readonly toolArgs?: Readonly<Record<string, unknown>>;
	readonly expectedOutput: string;
	readonly parallelizable?: boolean;
	readonly enabled?: boolean;
	readonly notes?: string;
}

export interface IFramePlanTemplateMatch {
	readonly template: IFramePlanTemplate;
	readonly score: number;
	readonly reasons: readonly string[];
}

/** Threshold for auto-suggesting a template in the planner. */
export const FRAME_PLAN_TEMPLATE_HIGH_CONFIDENCE = 40;

export const FRAME_PLAN_FORMAT = 'frameplan';
export const FRAME_PLAN_FORMAT_VERSION = 1;

export interface IFramePlanFile {
	readonly format: typeof FRAME_PLAN_FORMAT;
	readonly formatVersion: number;
	readonly template: IFramePlanTemplate;
}

export interface IFramePlanStyleStats {
	readonly renamedSteps: number;
	readonly disabledSteps: number;
	readonly reorderedSteps: number;
	readonly duplicatedPlans: number;
	readonly templatesApplied: number;
	readonly updatedAt: number;
}

function steps(...defs: IFramePlanTemplateStep[]): readonly IFramePlanTemplateStep[] {
	return defs;
}

export function createBuiltinPlanTemplates(): readonly IFramePlanTemplate[] {
	const now = null;
	return [
		{
			id: 'builtin-refactor-backend',
			name: 'Refactor Backend',
			description: 'Search, read, analyze, and prepare edits for backend/auth/API refactors.',
			category: 'refactor',
			supportedLanguages: ['typescript', 'javascript', 'python', 'go', 'java', 'rust'],
			triggerPatterns: ['refactor', 'authentication', 'auth', 'backend', 'api', 'service', 'middleware'],
			examplePrompts: ['Refactor authentication', 'Refactor the API layer', 'Clean up auth middleware'],
			defaultSteps: steps(
				{ kind: 'search', title: 'Search related symbols', description: 'searchWorkspace for domain terms', tools: ['searchWorkspace'], toolArgs: { query: 'auth', limit: 20 }, expectedOutput: 'Matching paths', parallelizable: true },
				{ kind: 'search', title: 'Grep usages', description: 'grepWorkspace for keywords', tools: ['grepWorkspace'], toolArgs: { pattern: 'auth', limit: 20 }, expectedOutput: 'Content hits', parallelizable: true },
				{ kind: 'read', title: 'Read primary module', description: 'readFile active or related file', tools: ['readFile'], expectedOutput: 'File contents', parallelizable: false },
				{ kind: 'analyze', title: 'Analyze refactor scope', description: 'Deterministic analysis notes', expectedOutput: 'Analysis', parallelizable: false },
				{ kind: 'edit', title: 'Prepare edit plan', description: 'Stub workspace edit plan', expectedOutput: 'Edit plan preview', parallelizable: false },
				{ kind: 'verify', title: 'Verify readiness', description: 'gitStatus stub check', tools: ['gitStatus'], expectedOutput: 'Verification', parallelizable: false },
			),
			lastUsed: now,
			usageCount: 0,
			editable: false,
			favorite: true,
			source: 'builtin',
			projectTypes: ['node', 'backend', 'api'],
		},
		{
			id: 'builtin-frontend',
			name: 'Frontend Feature',
			description: 'UI-oriented search/read/edit flow for components and styles.',
			category: 'frontend',
			supportedLanguages: ['typescript', 'javascript', 'tsx', 'jsx', 'css', 'html'],
			triggerPatterns: ['component', 'ui', 'frontend', 'react', 'view', 'page', 'style'],
			examplePrompts: ['Add a settings page component', 'Update the sidebar UI'],
			defaultSteps: steps(
				{ kind: 'search', title: 'Find UI files', description: 'searchWorkspace for UI terms', tools: ['searchWorkspace'], expectedOutput: 'UI paths', parallelizable: true },
				{ kind: 'read', title: 'List project root', description: 'listFiles', tools: ['listFiles'], toolArgs: { path: '.', limit: 40 }, expectedOutput: 'Entries', parallelizable: true },
				{ kind: 'read', title: 'Read active view', description: 'readFile', tools: ['readFile'], expectedOutput: 'Contents', parallelizable: false },
				{ kind: 'analyze', title: 'Analyze UI change', description: 'Deterministic notes', expectedOutput: 'Analysis', parallelizable: false },
				{ kind: 'edit', title: 'Prepare UI edit plan', description: 'Stub edit plan', expectedOutput: 'Edit plan', parallelizable: false },
				{ kind: 'verify', title: 'Verify', description: 'gitStatus', tools: ['gitStatus'], expectedOutput: 'Verification', parallelizable: false },
			),
			lastUsed: now,
			usageCount: 0,
			editable: false,
			source: 'builtin',
			projectTypes: ['frontend', 'web'],
		},
		{
			id: 'builtin-testing',
			name: 'Testing',
			description: 'Locate tests, read fixtures, and prepare test-related edits.',
			category: 'testing',
			supportedLanguages: ['typescript', 'javascript', 'python', 'go'],
			triggerPatterns: ['test', 'spec', 'coverage', 'assert', 'unit', 'e2e'],
			examplePrompts: ['Add unit tests for auth', 'Fix failing specs'],
			defaultSteps: steps(
				{ kind: 'search', title: 'Find tests', description: 'searchWorkspace for test files', tools: ['searchWorkspace'], toolArgs: { query: 'test', limit: 20 }, expectedOutput: 'Test paths', parallelizable: true },
				{ kind: 'search', title: 'Grep assertions', description: 'grepWorkspace', tools: ['grepWorkspace'], toolArgs: { pattern: 'test', limit: 20 }, expectedOutput: 'Hits', parallelizable: true },
				{ kind: 'read', title: 'Read test file', description: 'readFile', tools: ['readFile'], expectedOutput: 'Contents', parallelizable: false },
				{ kind: 'analyze', title: 'Analyze test gaps', description: 'Deterministic notes', expectedOutput: 'Analysis', parallelizable: false },
				{ kind: 'edit', title: 'Prepare test edits', description: 'Stub edit plan', expectedOutput: 'Edit plan', parallelizable: false },
				{ kind: 'verify', title: 'Verify', description: 'gitStatus', tools: ['gitStatus'], expectedOutput: 'Verification', parallelizable: false },
			),
			lastUsed: now,
			usageCount: 0,
			editable: false,
			source: 'builtin',
			projectTypes: ['any'],
		},
		{
			id: 'builtin-release',
			name: 'Release',
			description: 'Checklist-style plan for release readiness (docs, status, verify).',
			category: 'release',
			supportedLanguages: [],
			triggerPatterns: ['release', 'ship', 'changelog', 'version', 'tag'],
			examplePrompts: ['Prepare release checklist', 'Ship version bump'],
			defaultSteps: steps(
				{ kind: 'read', title: 'List root', description: 'listFiles', tools: ['listFiles'], toolArgs: { path: '.', limit: 40 }, expectedOutput: 'Entries', parallelizable: true },
				{ kind: 'search', title: 'Find changelog', description: 'searchWorkspace', tools: ['searchWorkspace'], toolArgs: { query: 'changelog', limit: 10 }, expectedOutput: 'Paths', parallelizable: true },
				{ kind: 'analyze', title: 'Analyze release notes', description: 'Deterministic notes', expectedOutput: 'Analysis', parallelizable: false },
				{ kind: 'edit', title: 'Prepare release edits', description: 'Stub edit plan', expectedOutput: 'Edit plan', parallelizable: false },
				{ kind: 'verify', title: 'Verify git status', description: 'gitStatus', tools: ['gitStatus'], expectedOutput: 'Verification', parallelizable: false },
			),
			lastUsed: now,
			usageCount: 0,
			editable: false,
			source: 'builtin',
			projectTypes: ['any'],
		},
		{
			id: 'builtin-general',
			name: 'General Coding',
			description: 'Default search → read → analyze → edit → verify pipeline.',
			category: 'general',
			supportedLanguages: [],
			triggerPatterns: ['fix', 'implement', 'update', 'add', 'create', 'build'],
			examplePrompts: ['Fix the bug in the parser', 'Implement the new helper'],
			defaultSteps: steps(
				{ kind: 'search', title: 'Search workspace', description: 'searchWorkspace', tools: ['searchWorkspace'], expectedOutput: 'Paths', parallelizable: true },
				{ kind: 'read', title: 'List root', description: 'listFiles', tools: ['listFiles'], toolArgs: { path: '.', limit: 40 }, expectedOutput: 'Entries', parallelizable: true },
				{ kind: 'read', title: 'Read primary file', description: 'readFile', tools: ['readFile'], expectedOutput: 'Contents', parallelizable: false },
				{ kind: 'analyze', title: 'Analyze request', description: 'Deterministic notes', expectedOutput: 'Analysis', parallelizable: false },
				{ kind: 'edit', title: 'Prepare edit plan', description: 'Stub edit plan', expectedOutput: 'Edit plan', parallelizable: false },
				{ kind: 'verify', title: 'Verify', description: 'gitStatus', tools: ['gitStatus'], expectedOutput: 'Verification', parallelizable: false },
			),
			lastUsed: now,
			usageCount: 0,
			editable: false,
			favorite: false,
			source: 'builtin',
			projectTypes: ['any'],
		},
	];
}

export function materializeTemplateSteps(
	template: IFramePlanTemplate,
	prompt: string,
	activePath?: string,
): IFramePlanStep[] {
	const keywords = prompt.toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
	const query = keywords[0] || 'frame';
	const ids: string[] = [];
	const steps: IFramePlanStep[] = [];

	template.defaultSteps.forEach((def, index) => {
		const id = createStepId();
		ids.push(id);
		const toolArgs = { ...(def.toolArgs ?? {}) } as Record<string, unknown>;
		if (def.tools?.includes('searchWorkspace') && typeof toolArgs.query !== 'string') {
			toolArgs.query = query;
		}
		if (def.tools?.includes('grepWorkspace') && typeof toolArgs.pattern !== 'string') {
			toolArgs.pattern = query;
		}
		if (def.tools?.includes('readFile') && !toolArgs.path && activePath) {
			toolArgs.path = activePath;
			toolArgs.maxBytes = toolArgs.maxBytes ?? 8000;
		}
		if (def.tools?.includes('readFile') && !toolArgs.path) {
			toolArgs.path = 'README.md';
			toolArgs.maxBytes = toolArgs.maxBytes ?? 8000;
		}

		const dependsOn = index === 0 ? [] : [ids[index - 1]];
		steps.push({
			id,
			kind: def.kind,
			title: def.title,
			description: def.description,
			dependsOn,
			tools: def.tools ?? [],
			toolArgs,
			expectedOutput: def.expectedOutput,
			status: 'pending',
			parallelizable: !!def.parallelizable,
			enabled: def.enabled !== false,
			notes: def.notes ?? '',
		});
	});

	return steps;
}

export function planFromTemplate(
	template: IFramePlanTemplate,
	taskId: string,
	prompt: string,
	activePath?: string,
): IFrameExecutionPlan {
	const steps = materializeTemplateSteps(template, prompt, activePath);
	const requiredTools = [...new Set(steps.flatMap(s => s.tools))];
	return {
		id: generateUuid(),
		taskId,
		prompt,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		summary: `Template “${template.name}”: ${steps.length} step(s) (deterministic).`,
		steps,
		requiredFiles: activePath ? [activePath] : [],
		requiredTools,
		expectedOutputs: steps.map(s => s.expectedOutput),
		phase: 'idle',
		status: 'planned',
		deterministic: true,
		suggestedTemplateId: template.id,
		suggestedTemplateName: template.name,
		suggestedTemplateScore: 100,
		fromTemplateId: template.id,
	};
}

export function validateFramePlanFile(raw: unknown): { ok: true; file: IFramePlanFile } | { ok: false; error: string } {
	if (!raw || typeof raw !== 'object') {
		return { ok: false, error: 'Invalid JSON object.' };
	}
	const obj = raw as Record<string, unknown>;
	if (obj.format !== FRAME_PLAN_FORMAT) {
		return { ok: false, error: `Expected format "${FRAME_PLAN_FORMAT}".` };
	}
	if (typeof obj.formatVersion !== 'number' || obj.formatVersion < 1) {
		return { ok: false, error: 'Unsupported formatVersion.' };
	}
	const template = obj.template;
	if (!template || typeof template !== 'object') {
		return { ok: false, error: 'Missing template object.' };
	}
	const t = template as Record<string, unknown>;
	if (typeof t.id !== 'string' || typeof t.name !== 'string') {
		return { ok: false, error: 'Template requires id and name.' };
	}
	if (!Array.isArray(t.defaultSteps) || t.defaultSteps.length === 0) {
		return { ok: false, error: 'Template requires defaultSteps.' };
	}
	for (const step of t.defaultSteps) {
		if (!step || typeof step !== 'object') {
			return { ok: false, error: 'Invalid step in defaultSteps.' };
		}
		const s = step as Record<string, unknown>;
		if (typeof s.kind !== 'string' || typeof s.title !== 'string') {
			return { ok: false, error: 'Each step needs kind and title.' };
		}
		if (Array.isArray(s.tools)) {
			const blocked = new Set(['writeFile', 'terminalRun', 'taskRun']);
			const tools = s.tools.filter(t => typeof t === 'string') as string[];
			if (tools.some(t => blocked.has(t))) {
				return { ok: false, error: `Template step "${s.title}" includes disallowed tools (write/execute).` };
			}
		}
	}
	return { ok: true, file: raw as IFramePlanFile };
}

export function toFramePlanFile(template: IFramePlanTemplate): IFramePlanFile {
	return {
		format: FRAME_PLAN_FORMAT,
		formatVersion: FRAME_PLAN_FORMAT_VERSION,
		template: {
			...template,
			source: template.source === 'builtin' ? 'imported' : template.source,
			editable: true,
		},
	};
}
