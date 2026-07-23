/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { FrameToolName } from '../runtime/tools/frameTools.js';

/**
 * Frame Task Planning — deterministic execution plans (no inference).
 */

export type FramePlanStepKind = 'read' | 'search' | 'analyze' | 'edit' | 'verify';

export type FramePlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Coarse UI progress phases. */
export type FrameTaskProgressPhase =
	| 'idle'
	| 'reading_files'
	| 'searching_workspace'
	| 'building_context'
	| 'preparing_edit_plan'
	| 'verifying'
	| 'finished'
	| 'failed';

export interface IFramePlanStep {
	readonly id: string;
	readonly kind: FramePlanStepKind;
	readonly title: string;
	readonly description: string;
	/** Step ids that must complete first. */
	readonly dependsOn: readonly string[];
	/** Tools this step intends to call (may be empty for analyze/edit orchestration). */
	readonly tools: readonly FrameToolName[];
	readonly toolArgs?: Readonly<Record<string, unknown>>;
	readonly expectedOutput: string;
	readonly status: FramePlanStepStatus;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly durationMs?: number;
	readonly error?: string;
	readonly outputPreview?: string;
	/** When true, may run in parallel with other ready steps that share no mutual deps. */
	readonly parallelizable: boolean;
	/** Interactive review: when false, step is skipped at execution. */
	readonly enabled: boolean;
	/** User notes attached during plan review. */
	readonly notes: string;
}

export interface IFrameExecutionPlan {
	readonly id: string;
	readonly taskId: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly summary: string;
	readonly steps: readonly IFramePlanStep[];
	readonly requiredFiles: readonly string[];
	readonly requiredTools: readonly FrameToolName[];
	readonly expectedOutputs: readonly string[];
	readonly phase: FrameTaskProgressPhase;
	readonly status: 'planned' | 'awaiting_review' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'cancelled';
	readonly deterministic: true;
	readonly editPlanId?: string;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly elapsedMs?: number;
	/** Optional display name when saved as a reusable plan. */
	readonly reusableName?: string;
	/** Best template match metadata (user may ignore). */
	readonly suggestedTemplateId?: string;
	readonly suggestedTemplateName?: string;
	readonly suggestedTemplateScore?: number;
	/** Set when the plan was materialized from a template. */
	readonly fromTemplateId?: string;
}

export interface IFrameTaskTimelineSnapshot {
	readonly planId: string | undefined;
	readonly prompt: string;
	readonly phase: FrameTaskProgressPhase;
	readonly phaseLabel: string;
	readonly currentStep: IFramePlanStep | undefined;
	readonly completedSteps: readonly IFramePlanStep[];
	readonly pendingSteps: readonly IFramePlanStep[];
	readonly failedSteps: readonly IFramePlanStep[];
	readonly elapsedMs: number;
	readonly status: IFrameExecutionPlan['status'] | 'idle';
}

export function phaseLabel(phase: FrameTaskProgressPhase): string {
	switch (phase) {
		case 'reading_files':
			return 'Reading Files';
		case 'searching_workspace':
			return 'Searching Workspace';
		case 'building_context':
			return 'Building Context';
		case 'preparing_edit_plan':
			return 'Preparing Edit Plan';
		case 'verifying':
			return 'Verifying';
		case 'finished':
			return 'Finished';
		case 'failed':
			return 'Failed';
		case 'idle':
		default:
			return 'Idle';
	}
}

export function phaseForStepKind(kind: FramePlanStepKind): FrameTaskProgressPhase {
	switch (kind) {
		case 'read':
			return 'reading_files';
		case 'search':
			return 'searching_workspace';
		case 'analyze':
			return 'building_context';
		case 'edit':
			return 'preparing_edit_plan';
		case 'verify':
			return 'verifying';
	}
}

export function isFramePlanningIntent(prompt: string): boolean {
	return /\b(refactor|implement|migrate|restructure|rewrite|overhaul|fix|add|create|update|delete|rename|build|wire|integrate|cleanup|clean\s+up)\b/i.test(prompt.trim())
		|| /\b(authentication|auth|login|api|component|module|service|pipeline)\b/i.test(prompt.trim());
}

export interface IFrameTaskTimelineSnapshot {
	readonly planId: string | undefined;
	readonly prompt: string;
	readonly phase: FrameTaskProgressPhase;
	readonly phaseLabel: string;
	readonly currentStep: IFramePlanStep | undefined;
	readonly completedSteps: readonly IFramePlanStep[];
	readonly pendingSteps: readonly IFramePlanStep[];
	readonly failedSteps: readonly IFramePlanStep[];
	readonly elapsedMs: number;
	readonly status: IFrameExecutionPlan['status'] | 'idle';
	readonly reviewPending: boolean;
}

export function emptyTimeline(): IFrameTaskTimelineSnapshot {
	return {
		planId: undefined,
		prompt: '',
		phase: 'idle',
		phaseLabel: phaseLabel('idle'),
		currentStep: undefined,
		completedSteps: [],
		pendingSteps: [],
		failedSteps: [],
		elapsedMs: 0,
		status: 'idle',
		reviewPending: false,
	};
}

export function timelineFromPlan(plan: IFrameExecutionPlan | undefined): IFrameTaskTimelineSnapshot {
	if (!plan) {
		return emptyTimeline();
	}
	const currentStep = plan.steps.find(s => s.status === 'running');
	const completedSteps = plan.steps.filter(s => s.status === 'completed' || s.status === 'skipped');
	const pendingSteps = plan.steps.filter(s => s.status === 'pending' && s.enabled);
	const failedSteps = plan.steps.filter(s => s.status === 'failed');
	const elapsedMs = plan.elapsedMs
		?? (plan.startedAt ? Math.max(0, (plan.finishedAt ?? Date.now()) - plan.startedAt) : 0);
	return {
		planId: plan.id,
		prompt: plan.prompt,
		phase: plan.phase,
		phaseLabel: phaseLabel(plan.phase),
		currentStep,
		completedSteps,
		pendingSteps,
		failedSteps,
		elapsedMs,
		status: plan.status,
		reviewPending: plan.status === 'awaiting_review',
	};
}

/** Drop disabled steps and rewrite dependencies for execution. */
export function finalizePlanForExecution(plan: IFrameExecutionPlan): IFrameExecutionPlan {
	const enabled = plan.steps.filter(s => s.enabled);
	const enabledIds = new Set(enabled.map(s => s.id));
	return {
		...plan,
		status: 'approved',
		updatedAt: Date.now(),
		steps: enabled.map(s => ({
			...s,
			dependsOn: s.dependsOn.filter(d => enabledIds.has(d)),
			status: 'pending' as const,
		})),
		summary: `${plan.summary} (review approved: ${enabled.length}/${plan.steps.length} steps)`,
	};
}

export function withStepUpdate(
	plan: IFrameExecutionPlan,
	stepId: string,
	patch: Partial<IFramePlanStep>,
	planPatch?: Partial<IFrameExecutionPlan>,
): IFrameExecutionPlan {
	return {
		...plan,
		updatedAt: Date.now(),
		...planPatch,
		steps: plan.steps.map(s => s.id === stepId ? { ...s, ...patch } : s),
	};
}

export function createStepId(): string {
	return generateUuid();
}
