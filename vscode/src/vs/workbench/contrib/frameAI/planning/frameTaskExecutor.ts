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
import { IFrameInferenceContext } from '../common/models.js';
import { IFrameWorkspaceEditService } from '../editing/frameWorkspaceEditService.js';
import { IFrameToolExecutionService } from '../runtime/tools/frameToolExecutionService.js';
import { FrameToolName } from '../runtime/tools/frameTools.js';
import {
	emptyTimeline,
	IFrameExecutionPlan,
	IFramePlanStep,
	IFrameTaskTimelineSnapshot,
	phaseForStepKind,
	timelineFromPlan,
	withStepUpdate,
} from './frameTaskPlan.js';
import { defaultFrameTaskPlanner, FrameTaskPlanner } from './frameTaskPlanner.js';
import { IFramePlanTemplateService } from './framePlanTemplateService.js';
import { FRAME_PLAN_TEMPLATE_HIGH_CONFIDENCE } from './framePlanTemplates.js';

export const IFrameTaskExecutionService = createDecorator<IFrameTaskExecutionService>('frameTaskExecutionService');

export interface IFrameTaskExecutionResult {
	readonly plan: IFrameExecutionPlan;
	readonly editPlanId?: string;
	readonly analysisNotes: string;
	readonly ok: boolean;
	readonly message: string;
}

export interface IFrameTaskExecutionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProgress: Event<IFrameTaskTimelineSnapshot>;

	readonly planner: FrameTaskPlanner;

	getActivePlan(): IFrameExecutionPlan | undefined;

	getTimeline(): IFrameTaskTimelineSnapshot;

	/** Build a deterministic plan (does not execute). */
	buildPlan(taskId: string, prompt: string, context: IFrameInferenceContext): IFrameExecutionPlan;

	/** Execute an already-reviewed plan. */
	executePlan(plan: IFrameExecutionPlan, context: IFrameInferenceContext, signal?: AbortSignal): Promise<IFrameTaskExecutionResult>;

	/** Build plan then execute immediately (no interactive review). */
	run(taskId: string, prompt: string, context: IFrameInferenceContext, signal?: AbortSignal): Promise<IFrameTaskExecutionResult>;

	/** Replace the active plan (e.g. after review mutations). */
	setActivePlan(plan: IFrameExecutionPlan): void;

	/** Apply a template to the current task context and return a new plan (does not execute). */
	buildPlanFromTemplate(taskId: string, prompt: string, context: IFrameInferenceContext, templateId: string): Promise<IFrameExecutionPlan | undefined>;

	cancel(): void;
}

/**
 * Executes Frame task plans with progress events and `.frame/tasks/` persistence.
 */
export class FrameTaskExecutionService extends Disposable implements IFrameTaskExecutionService {

	declare readonly _serviceBrand: undefined;

	readonly planner: FrameTaskPlanner = defaultFrameTaskPlanner;

	private _active: IFrameExecutionPlan | undefined;
	private _cancelled = false;

	private readonly _onDidChangeProgress = this._register(new Emitter<IFrameTaskTimelineSnapshot>());
	readonly onDidChangeProgress: Event<IFrameTaskTimelineSnapshot> = this._onDidChangeProgress.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFrameToolExecutionService private readonly tools: IFrameToolExecutionService,
		@IFrameWorkspaceEditService private readonly workspaceEdits: IFrameWorkspaceEditService,
		@IFramePlanTemplateService private readonly templates: IFramePlanTemplateService,
	) {
		super();
		this.logService.info('[FramePlanner] Task execution service ready (deterministic)');
	}

	getActivePlan(): IFrameExecutionPlan | undefined {
		return this._active;
	}

	getTimeline(): IFrameTaskTimelineSnapshot {
		return timelineFromPlan(this._active) ?? emptyTimeline();
	}

	buildPlan(taskId: string, prompt: string, context: IFrameInferenceContext): IFrameExecutionPlan {
		const projectType = inferProjectType(context);
		const suggestion = this.templates.getSuggested({
			prompt,
			languageId: context.languageId,
			projectType,
		});
		const applyTemplate = !!suggestion && suggestion.score >= FRAME_PLAN_TEMPLATE_HIGH_CONFIDENCE;
		const plan = this.planner.buildPlan({
			taskId,
			prompt,
			context,
			template: applyTemplate ? suggestion.template : undefined,
			suggestion,
		});
		if (applyTemplate && suggestion) {
			void this.templates.markUsed(suggestion.template.id);
		}
		this._active = plan;
		this.fireProgress();
		void this.persistPlan(plan);
		return plan;
	}

	async buildPlanFromTemplate(
		taskId: string,
		prompt: string,
		context: IFrameInferenceContext,
		templateId: string,
	): Promise<IFrameExecutionPlan | undefined> {
		const template = this.templates.getTemplate(templateId);
		if (!template) {
			return undefined;
		}
		const suggestion = {
			template,
			score: 100,
			reasons: ['user-selected'],
		};
		const plan = this.planner.buildPlan({
			taskId,
			prompt,
			context,
			template,
			suggestion,
		});
		await this.templates.markUsed(templateId);
		this._active = plan;
		this.fireProgress();
		void this.persistPlan(plan);
		return plan;
	}

	setActivePlan(plan: IFrameExecutionPlan): void {
		this.setActive(plan);
	}

	cancel(): void {
		this._cancelled = true;
	}

	async run(
		taskId: string,
		prompt: string,
		context: IFrameInferenceContext,
		signal?: AbortSignal,
	): Promise<IFrameTaskExecutionResult> {
		// Never execute without plan review — route through review gate.
		throw new Error('Use plan review (Approve) before execution. Direct run() is disabled.');
	}

	async executePlan(
		inputPlan: IFrameExecutionPlan,
		context: IFrameInferenceContext,
		signal?: AbortSignal,
	): Promise<IFrameTaskExecutionResult> {
		if (inputPlan.status !== 'approved' && inputPlan.status !== 'running') {
			throw new Error(`Plan must be approved before execution (status=${inputPlan.status}).`);
		}

		this._cancelled = false;
		let plan: IFrameExecutionPlan = {
			...inputPlan,
			status: 'running',
			phase: 'building_context',
			startedAt: Date.now(),
			updatedAt: Date.now(),
			steps: inputPlan.steps
				.filter(s => s.enabled !== false)
				.map(s => ({ ...s, status: 'pending' as const })),
		};
		this.setActive(plan);

		const toolOutputs = new Map<string, unknown>();
		let analysisNotes = '';
		let editPlanId: string | undefined;

		try {
			while (true) {
				if (this._cancelled || signal?.aborted) {
					plan = { ...plan, status: 'cancelled', phase: 'failed', finishedAt: Date.now(), elapsedMs: Date.now() - (plan.startedAt ?? Date.now()), updatedAt: Date.now() };
					this.setActive(plan);
					await this.persistPlan(plan);
					return { plan, ok: false, analysisNotes, message: 'Task plan cancelled.', editPlanId };
				}

				const ready = plan.steps.filter(s =>
					s.enabled !== false
					&& s.status === 'pending'
					&& s.dependsOn.every(d => {
						const dep = plan.steps.find(x => x.id === d);
						return dep && (dep.status === 'completed' || dep.status === 'skipped');
					}),
				);

				if (!ready.length) {
					const pending = plan.steps.some(s => s.status === 'pending' || s.status === 'running');
					if (pending) {
						throw new Error('Deadlock in execution graph — unresolved dependencies.');
					}
					break;
				}

				const parallel = ready.filter(s => s.parallelizable);
				const serial = ready.filter(s => !s.parallelizable);
				const batch = parallel.length ? parallel : serial.slice(0, 1);

				// Mark batch running
				for (const step of batch) {
					plan = withStepUpdate(plan, step.id, { status: 'running', startedAt: Date.now() }, {
						phase: phaseForStepKind(step.kind),
						status: 'running',
					});
				}
				this.setActive(plan);

				const outcomes = await Promise.all(batch.map(async step => {
					const startedAt = Date.now();
					try {
						const result = await this.executeStep(step, plan, context, toolOutputs);
						return { step, startedAt, ok: true as const, result };
					} catch (err) {
						return {
							step,
							startedAt,
							ok: false as const,
							error: err instanceof Error ? err.message : String(err),
						};
					}
				}));

				for (const outcome of outcomes) {
					if (!outcome.ok) {
						plan = withStepUpdate(plan, outcome.step.id, {
							status: 'failed',
							finishedAt: Date.now(),
							durationMs: Date.now() - outcome.startedAt,
							error: outcome.error,
						}, {
							status: 'failed',
							phase: 'failed',
							finishedAt: Date.now(),
							elapsedMs: Date.now() - (plan.startedAt ?? Date.now()),
						});
						this.setActive(plan);
						await this.persistPlan(plan);
						return {
							plan,
							ok: false,
							analysisNotes,
							editPlanId,
							message: outcome.error,
						};
					}
					if (outcome.result.analysisNotes) {
						analysisNotes = outcome.result.analysisNotes;
					}
					if (outcome.result.editPlanId) {
						editPlanId = outcome.result.editPlanId;
					}
					plan = withStepUpdate(plan, outcome.step.id, {
						status: 'completed',
						finishedAt: Date.now(),
						durationMs: Date.now() - outcome.startedAt,
						outputPreview: outcome.result.preview,
					}, {
						editPlanId: editPlanId ?? plan.editPlanId,
						phase: phaseForStepKind(outcome.step.kind),
					});
				}
				this.setActive(plan);
			}

			plan = {
				...plan,
				status: 'completed',
				phase: 'finished',
				finishedAt: Date.now(),
				elapsedMs: Date.now() - (plan.startedAt ?? Date.now()),
				updatedAt: Date.now(),
				editPlanId,
			};
			this.setActive(plan);
			await this.persistPlan(plan);

			return {
				plan,
				ok: true,
				analysisNotes,
				editPlanId,
				message: `Plan finished: ${plan.steps.filter(s => s.status === 'completed').length}/${plan.steps.length} steps. ${editPlanId ? 'Edit plan ready for preview.' : 'No edit plan.'}`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			plan = {
				...plan,
				status: 'failed',
				phase: 'failed',
				finishedAt: Date.now(),
				elapsedMs: Date.now() - (plan.startedAt ?? Date.now()),
				updatedAt: Date.now(),
			};
			this.setActive(plan);
			await this.persistPlan(plan);
			return { plan, ok: false, analysisNotes, editPlanId, message };
		}
	}

	private async executeStep(
		step: IFramePlanStep,
		plan: IFrameExecutionPlan,
		context: IFrameInferenceContext,
		toolOutputs: Map<string, unknown>,
	): Promise<{ preview?: string; analysisNotes?: string; editPlanId?: string }> {
		switch (step.kind) {
			case 'search':
			case 'read':
			case 'verify': {
				if (!step.tools.length) {
					return { preview: 'No tools' };
				}
				const tool = step.tools[0] as FrameToolName;
				const result = await this.tools.executeCall({
					id: generateUuid(),
					name: tool,
					arguments: step.toolArgs ?? {},
					requestId: plan.taskId,
					createdAt: Date.now(),
				});
				toolOutputs.set(step.id, result.data ?? result.error);
				const preview = result.success
					? truncate(JSON.stringify(result.data), 180)
					: `error: ${result.error}`;
				return { preview };
			}
			case 'analyze': {
				// Run knowledge / analysis tools attached to the step before notes.
				if (step.tools.length) {
					for (const toolName of step.tools) {
						const result = await this.tools.executeCall({
							id: generateUuid(),
							name: toolName as FrameToolName,
							arguments: step.toolArgs ?? {},
							requestId: plan.taskId,
							createdAt: Date.now(),
						});
						toolOutputs.set(`${step.id}:${toolName}`, result.data ?? result.error);
					}
				}
				const notes = buildAnalysisNotes(plan, context, toolOutputs);
				toolOutputs.set(step.id, notes);
				return { preview: truncate(notes, 180), analysisNotes: notes };
			}
			case 'edit': {
				const editPlan = await this.workspaceEdits.proposeStubPlan(plan.taskId, plan.prompt, context);
				toolOutputs.set(step.id, { editPlanId: editPlan.id, ops: editPlan.operations.length });
				return {
					preview: editPlan.summary,
					editPlanId: editPlan.id,
				};
			}
		}
	}

	private setActive(plan: IFrameExecutionPlan): void {
		this._active = plan;
		this.fireProgress();
	}

	private fireProgress(): void {
		this._onDidChangeProgress.fire(this.getTimeline());
	}

	private async persistPlan(plan: IFrameExecutionPlan): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return;
		}
		const dir = joinPath(folder, '.frame', 'tasks');
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(dir);
		const name = `task-${plan.createdAt}-${plan.id.slice(0, 8)}.json`;
		const uri = joinPath(dir, name);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(plan, null, 2) + '\n'));
		this.logService.info(`[FramePlanner] Persisted ${name} phase=${plan.phase}`);
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}

function buildAnalysisNotes(
	plan: IFrameExecutionPlan,
	context: IFrameInferenceContext,
	toolOutputs: Map<string, unknown>,
): string {
	const lines = [
		'# Frame deterministic analysis',
		'',
		`Prompt: ${plan.prompt.trim().slice(0, 300)}`,
		`Active file: ${context.activeRelativePath ?? '(none)'}`,
		`Related files: ${context.relatedFiles.slice(0, 8).join(', ') || '(none)'}`,
		`Required files: ${plan.requiredFiles.join(', ') || '(none)'}`,
		`Required tools: ${plan.requiredTools.join(', ') || '(none)'}`,
		'',
		'## Tool outputs',
	];
	for (const step of plan.steps) {
		if (!toolOutputs.has(step.id)) {
			continue;
		}
		lines.push(`- ${step.title}: ${truncate(JSON.stringify(toolOutputs.get(step.id)), 120)}`);
	}
	lines.push('', 'Status: MODEL_RUNTIME_NOT_CONNECTED (rule-based planner, no inference).', '');
	return lines.join('\n');
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}

function inferProjectType(context: IFrameInferenceContext): string | undefined {
	const files = [...context.relatedFiles, ...context.openFiles.map(f => f.relativePath ?? '')].join(' ').toLowerCase();
	if (/\b(react|vue|svelte|tsx|jsx|css)\b/.test(files) || context.languageId === 'typescriptreact') {
		return 'frontend';
	}
	if (/\b(express|fastapi|django|spring|api|server)\b/.test(files)) {
		return 'backend';
	}
	if (/\b(test|spec|pytest|jest)\b/.test(files)) {
		return 'testing';
	}
	if (context.languageId) {
		return context.languageId;
	}
	return undefined;
}
