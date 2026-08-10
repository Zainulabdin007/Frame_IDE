/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	finalizePlanForExecution,
	IFrameExecutionPlan,
	IFramePlanStep,
} from './frameTaskPlan.js';
import { IFramePlanTemplateService } from './framePlanTemplateService.js';
import { planFromTemplate } from './framePlanTemplates.js';

export const IFramePlanReviewService = createDecorator<IFramePlanReviewService>('framePlanReviewService');

/** How long a plan waits for an interactive Approve/Reject before auto-approving. */
export const FRAME_PLAN_REVIEW_AUTO_APPROVE_MS = 0;

export type FramePlanReviewDecisionKind = 'approved' | 'rejected';

/** Countdown state for the review UI (remaining time before auto-approve). */
export interface IFramePlanReviewCountdown {
	readonly planId: string;
	readonly startedAt: number;
	readonly deadline: number;
	readonly remainingMs: number;
	readonly timeoutMs: number;
}

export interface IFramePlanReviewDecision {
	readonly decision: FramePlanReviewDecisionKind;
	readonly plan: IFrameExecutionPlan;
}

export interface IFrameReusablePlanRecord {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly steps: readonly IFramePlanStep[];
	readonly summary: string;
}

export interface IFramePlanReviewService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeReview: Event<void>;

	/** Plan currently awaiting interactive review, if any. */
	getDraft(): IFrameExecutionPlan | undefined;

	isAwaitingReview(): boolean;

	/** Remaining time before the pending review auto-approves, if a review is active. */
	getReviewCountdown(): IFramePlanReviewCountdown | undefined;

	/**
	 * Present a plan for review. Resolves when the user Approves or Rejects,
	 * or auto-approves after {@link FRAME_PLAN_REVIEW_AUTO_APPROVE_MS} so Edit
	 * tasks cannot hang forever.
	 * Mutations (reorder / enable / rename / notes) apply to the draft before resolve.
	 */
	beginReview(plan: IFrameExecutionPlan, signal?: AbortSignal): Promise<IFramePlanReviewDecision>;

	reorderStep(fromIndex: number, toIndex: number): void;

	setStepEnabled(stepId: string, enabled: boolean): void;

	renameStep(stepId: string, title: string): void;

	setStepNotes(stepId: string, notes: string): void;

	/** Replace draft steps from a template while awaiting review. */
	applyTemplate(templateId: string): Promise<boolean>;

	approve(): void;

	reject(): void;

	/** Persist draft (or given plan) under `.frame/plans/` for reuse. */
	saveReusable(name: string, plan?: IFrameExecutionPlan): Promise<IFrameReusablePlanRecord | undefined>;

	listReusablePlans(): Promise<readonly IFrameReusablePlanRecord[]>;
}

/**
 * Interactive plan review — execution starts only after Approve.
 */
export class FramePlanReviewService extends Disposable implements IFramePlanReviewService {

	declare readonly _serviceBrand: undefined;

	private _draft: IFrameExecutionPlan | undefined;
	private _resolve: ((decision: IFramePlanReviewDecision) => void) | undefined;
	private _abortListener: (() => void) | undefined;
	private _autoApproveTimer: ReturnType<typeof setTimeout> | undefined;
	private _reviewStartedAt: number | undefined;
	private _reviewDeadline: number | undefined;

	private readonly _onDidChangeReview = this._register(new Emitter<void>());
	readonly onDidChangeReview: Event<void> = this._onDidChangeReview.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFramePlanTemplateService private readonly templates: IFramePlanTemplateService,
	) {
		super();
		this.logService.info('[FramePlanReview] Service ready (interactive review before execute)');
	}

	getDraft(): IFrameExecutionPlan | undefined {
		return this._draft;
	}

	isAwaitingReview(): boolean {
		return !!this._draft && this._draft.status === 'awaiting_review' && !!this._resolve;
	}

	getReviewCountdown(): IFramePlanReviewCountdown | undefined {
		if (!this.isAwaitingReview() || this._reviewDeadline === undefined || this._reviewStartedAt === undefined) {
			return undefined;
		}
		return {
			planId: this._draft!.id,
			startedAt: this._reviewStartedAt,
			deadline: this._reviewDeadline,
			remainingMs: Math.max(0, this._reviewDeadline - Date.now()),
			timeoutMs: FRAME_PLAN_REVIEW_AUTO_APPROVE_MS,
		};
	}

	beginReview(plan: IFrameExecutionPlan, signal?: AbortSignal): Promise<IFramePlanReviewDecision> {
		if (this._resolve) {
			this._resolve({
				decision: 'rejected',
				plan: this._draft ?? plan,
			});
			this.clearPending();
		}

		this._draft = {
			...plan,
			status: 'awaiting_review',
			updatedAt: Date.now(),
			steps: plan.steps.map(s => ({
				...s,
				enabled: s.enabled !== false,
				notes: s.notes ?? '',
			})),
		};
		this._onDidChangeReview.fire();

		return new Promise<IFramePlanReviewDecision>(resolve => {
			this._resolve = resolve;
			if (signal) {
				const onAbort = () => {
					this.reject();
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
				this._abortListener = () => signal.removeEventListener('abort', onAbort);
			}
			// Wait for a real Approve/Reject from the sidebar, but never hang an
			// Edit task forever: auto-approve after the review timeout elapses.
			this._reviewStartedAt = Date.now();
			this._reviewDeadline = this._reviewStartedAt + FRAME_PLAN_REVIEW_AUTO_APPROVE_MS;
			this._autoApproveTimer = setTimeout(() => {
				if (this._resolve === resolve) {
					this.logService.info(`[FramePlanReview] Auto-approving plan after ${FRAME_PLAN_REVIEW_AUTO_APPROVE_MS}ms without a user decision`);
					this.approve();
				}
			}, FRAME_PLAN_REVIEW_AUTO_APPROVE_MS);
			this._onDidChangeReview.fire();
		});
	}

	reorderStep(fromIndex: number, toIndex: number): void {
		if (!this._draft) {
			return;
		}
		const steps = [...this._draft.steps];
		if (fromIndex < 0 || fromIndex >= steps.length || toIndex < 0 || toIndex >= steps.length || fromIndex === toIndex) {
			return;
		}
		const [moved] = steps.splice(fromIndex, 1);
		steps.splice(toIndex, 0, moved);
		const reordered = steps.map((s, i) => ({
			...s,
			dependsOn: i === 0 ? [] : [steps[i - 1].id],
			parallelizable: false,
		}));
		this._draft = { ...this._draft, steps: reordered, updatedAt: Date.now() };
		this._onDidChangeReview.fire();
		this.templates.recordStyleEvent('reorder').catch(err => this.logService.warn('[FramePlanReview] Failed to record style event', err));
	}

	setStepEnabled(stepId: string, enabled: boolean): void {
		this.patchStep(stepId, { enabled });
		if (!enabled) {
			this.templates.recordStyleEvent('disable').catch(err => this.logService.warn('[FramePlanReview] Failed to record style event', err));
		}
	}

	renameStep(stepId: string, title: string): void {
		const trimmed = title.trim();
		if (!trimmed) {
			return;
		}
		this.patchStep(stepId, { title: trimmed });
		this.templates.recordStyleEvent('rename').catch(err => this.logService.warn('[FramePlanReview] Failed to record style event', err));
	}

	setStepNotes(stepId: string, notes: string): void {
		this.patchStep(stepId, { notes });
	}

	async applyTemplate(templateId: string): Promise<boolean> {
		if (!this._draft || !this.isAwaitingReview()) {
			return false;
		}
		const template = this.templates.getTemplate(templateId);
		if (!template) {
			return false;
		}
		const materialized = planFromTemplate(template, this._draft.taskId, this._draft.prompt);
		this._draft = {
			...materialized,
			id: this._draft.id,
			status: 'awaiting_review',
			suggestedTemplateId: template.id,
			suggestedTemplateName: template.name,
			suggestedTemplateScore: 100,
			fromTemplateId: template.id,
		};
		await this.templates.markUsed(templateId);
		this._onDidChangeReview.fire();
		return true;
	}

	approve(): void {
		if (!this._draft || !this._resolve) {
			return;
		}
		const finalPlan = finalizePlanForExecution(this._draft);
		const resolve = this._resolve;
		this.clearPending();
		this._draft = finalPlan;
		this._onDidChangeReview.fire();
		resolve({ decision: 'approved', plan: finalPlan });
	}

	reject(): void {
		if (!this._resolve) {
			return;
		}
		const plan: IFrameExecutionPlan = this._draft
			? { ...this._draft, status: 'rejected', updatedAt: Date.now() }
			: {
				id: generateUuid(),
				taskId: 'none',
				prompt: '',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				summary: 'Rejected',
				steps: [],
				requiredFiles: [],
				requiredTools: [],
				expectedOutputs: [],
				phase: 'idle',
				status: 'rejected',
				deterministic: true,
			};
		const resolve = this._resolve;
		this.clearPending();
		this._draft = undefined;
		this._onDidChangeReview.fire();
		resolve({ decision: 'rejected', plan });
	}

	async saveReusable(name: string, plan?: IFrameExecutionPlan): Promise<IFrameReusablePlanRecord | undefined> {
		const source = plan ?? this._draft;
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!source || !folder) {
			return undefined;
		}
		const trimmed = name.trim() || `plan-${source.id.slice(0, 8)}`;
		const record: IFrameReusablePlanRecord = {
			id: generateUuid(),
			name: trimmed,
			prompt: source.prompt,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			steps: source.steps,
			summary: source.summary,
		};
		const dir = joinPath(folder, '.frame', 'plans');
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(dir);
		const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
		const uri = joinPath(dir, `${safe}-${record.id.slice(0, 8)}.json`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(record, null, 2) + '\n'));
		this.logService.info(`[FramePlanReview] Saved reusable plan ${uri.path}`);
		if (this._draft && this._draft.id === source.id) {
			this._draft = { ...this._draft, reusableName: trimmed, updatedAt: Date.now() };
			this._onDidChangeReview.fire();
		}
		return record;
	}

	async listReusablePlans(): Promise<readonly IFrameReusablePlanRecord[]> {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return [];
		}
		const dir = joinPath(folder, '.frame', 'plans');
		try {
			if (!(await this.fileService.exists(dir))) {
				return [];
			}
			const resolved = await this.fileService.resolve(dir);
			const out: IFrameReusablePlanRecord[] = [];
			for (const child of resolved.children ?? []) {
				if (!child.name.endsWith('.json') || child.isDirectory) {
					continue;
				}
				try {
					const buf = await this.fileService.readFile(child.resource);
					const parsed = JSON.parse(buf.value.toString()) as IFrameReusablePlanRecord;
					if (parsed?.id && parsed?.name && Array.isArray(parsed.steps)) {
						out.push(parsed);
					}
				} catch {
					// skip bad file
				}
			}
			return out.sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			return [];
		}
	}

	private patchStep(stepId: string, patch: Partial<IFramePlanStep>): void {
		if (!this._draft) {
			return;
		}
		this._draft = {
			...this._draft,
			updatedAt: Date.now(),
			steps: this._draft.steps.map(s => s.id === stepId ? { ...s, ...patch } : s),
		};
		this._onDidChangeReview.fire();
	}

	private clearPending(): void {
		this._abortListener?.();
		this._abortListener = undefined;
		this._resolve = undefined;
		if (this._autoApproveTimer !== undefined) {
			clearTimeout(this._autoApproveTimer);
			this._autoApproveTimer = undefined;
		}
		this._reviewStartedAt = undefined;
		this._reviewDeadline = undefined;
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}

	override dispose(): void {
		if (this._autoApproveTimer !== undefined) {
			clearTimeout(this._autoApproveTimer);
			this._autoApproveTimer = undefined;
		}
		super.dispose();
	}
}
