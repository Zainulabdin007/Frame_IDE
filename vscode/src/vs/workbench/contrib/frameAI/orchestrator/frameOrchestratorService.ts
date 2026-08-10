/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { FrameIntelligencePhase } from '../common/frameAI.js';
import { FRAME_PRIVACY_GUARANTEES } from '../common/privacy.js';
import {
	FrameAdapterState,
	IFrameInferenceContext,
	IFrameTaskPlan,
	IFrameTaskRequest,
	IFrameTaskResult,
	FrameTaskKind,
	FrameTaskStatus,
} from '../common/models.js';
import { IFrameContextService } from '../context/frameContext.js';
import { IFrameRagService } from '../rag/frameRag.js';
import { IFrameAdapterService } from '../adapters/frameAdapters.js';
import { IFrameRuntimeService } from '../runtime/frameRuntime.js';
import { IFrameGenerationTracker } from '../preferences/frameGenerationTracker.js';
import { IFrameChatMemoryService } from '../memory/frameChatMemory.js';
import { IFramePersistentMemoryService } from '../memory/persistentMemory.js';
import { IFrameGenerationLogService } from '../runtime/frameGenerationLog.js';
import { IFrameModelWorkerManager } from '../runtime/worker/frameModelWorkerManager.js';
import { IFrameWorkspaceEditService } from '../editing/frameWorkspaceEditService.js';
import { isFrameEditIntent, parseModelEditPlan } from '../runtime/frameEditPlan.js';
import { IFrameTaskExecutionService } from '../planning/frameTaskExecutor.js';
import { IFramePlanReviewService } from '../planning/framePlanReviewService.js';
import { IFrameOrchestratorService } from './frameOrchestrator.js';

/**
 * Local orchestrator — Context Engine → Runtime Service → Generation Tracker.
 * Uses local runtimes only (stub today; MLX / llama.cpp later with user-provided weights).
 */
export class FrameOrchestratorService extends Disposable implements IFrameOrchestratorService {

	declare readonly _serviceBrand: undefined;

	private _phase = FrameIntelligencePhase.Scaffolded;
	private readonly _plans = new Map<string, IFrameTaskPlan>();
	private readonly _requests = new Map<string, IFrameTaskRequest>();
	private readonly _contexts = new Map<string, IFrameInferenceContext>();
	private readonly _abortControllers = new Map<string, AbortController>();

	private readonly _onDidChangePhase = this._register(new Emitter<FrameIntelligencePhase>());
	readonly onDidChangePhase: Event<FrameIntelligencePhase> = this._onDidChangePhase.event;

	private readonly _onDidCompleteTask = this._register(new Emitter<IFrameTaskResult>());
	readonly onDidCompleteTask: Event<IFrameTaskResult> = this._onDidCompleteTask.event;

	private readonly _onDidStreamToken = this._register(new Emitter<{ readonly taskId: string; readonly token: string }>());
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFrameContextService private readonly contextService: IFrameContextService,
		@IFrameRagService private readonly ragService: IFrameRagService,
		@IFrameAdapterService private readonly adapterService: IFrameAdapterService,
		@IFrameRuntimeService private readonly runtimeService: IFrameRuntimeService,
		@IFrameGenerationTracker private readonly generationTracker: IFrameGenerationTracker,
		@IFrameChatMemoryService private readonly chatMemory: IFrameChatMemoryService,
		@IFramePersistentMemoryService private readonly persistentMemory: IFramePersistentMemoryService,
		@IFrameGenerationLogService private readonly generationLog: IFrameGenerationLogService,
		@IFrameModelWorkerManager private readonly workerManager: IFrameModelWorkerManager,
		@IFrameWorkspaceEditService private readonly workspaceEdits: IFrameWorkspaceEditService,
		@IFrameTaskExecutionService private readonly taskExecution: IFrameTaskExecutionService,
		@IFramePlanReviewService private readonly planReview: IFramePlanReviewService,
	) {
		super();
		this.logService.info('[FrameAI] Orchestrator ready (streaming pipeline)', FRAME_PRIVACY_GUARANTEES);
		this._register(this.runtimeService.onDidStreamToken(e => this._onDidStreamToken.fire(e)));
		this.runtimeService.initialize().catch(err => this.logService.error('[FrameAI] Runtime initialization failed', err));
	}

	get phase(): FrameIntelligencePhase {
		return this._phase;
	}

	async submitTask(request: IFrameTaskRequest): Promise<IFrameTaskResult> {
		const id = request.id || generateUuid();
		const normalized: IFrameTaskRequest = { ...request, id };
		this._requests.set(id, normalized);

		// Register abort early so Chat Stop works during context gathering.
		const controller = new AbortController();
		this._abortControllers.set(id, controller);

		if (normalized.kind === FrameTaskKind.Index) {
			this._abortControllers.delete(id);
			const status = await this.ragService.reindex(this.workspaceFolders());
			const plan: IFrameTaskPlan = {
				taskId: id,
				status: FrameTaskStatus.Completed,
				memoryHints: [],
				ragQueries: [],
				adapterIds: [],
				notes: status.message,
			};
			this._plans.set(id, plan);
			const result: IFrameTaskResult = {
				taskId: id,
				status: FrameTaskStatus.Completed,
				plan,
				message: status.message ?? 'Workspace reindexed.',
			};
			this._onDidCompleteTask.fire(result);
			return result;
		}

		const plan: IFrameTaskPlan = {
			taskId: id,
			status: FrameTaskStatus.GatheringContext,
			memoryHints: normalized.sessionId ? [normalized.sessionId] : [],
			ragQueries: normalized.prompt.trim() ? [normalized.prompt.trim()] : [],
			adapterIds: this.adapterService.listAdapters().filter(a => a.state === FrameAdapterState.Active).map(a => a.id),
			notes: 'Context Engine gathering editor, RAG, memory, and adapters.',
		};
		this._plans.set(id, plan);

		try {
			const context = await this.contextService.build({
				taskId: id,
				request: normalized.prompt,
				sessionId: normalized.sessionId,
				activeUri: normalized.activeUri,
				attachedUris: normalized.attachedUris,
				selectionText: normalized.selectionText,
				workspaceFolders: this.workspaceFolders(),
				messages: normalized.messages,
			});
			this._contexts.set(id, context);

			let executionPlanId: string | undefined;
			let editPlanId: string | undefined;
			let editPlanSummary: string | undefined;
			let plannerMessage = '';

			if (controller.signal.aborted) {
				this._abortControllers.delete(id);
				const cancelled: IFrameTaskPlan = { ...plan, status: FrameTaskStatus.Cancelled };
				this._plans.set(id, cancelled);
				const result: IFrameTaskResult = { taskId: id, status: FrameTaskStatus.Cancelled, plan: cancelled };
				this._onDidCompleteTask.fire(result);
				return result;
			}

			// Chat must not block on plan-review UI (not yet exposed).
			// Explicit Edit tasks still use the planner; Chat proposes edits after inference.
			const shouldPlan = normalized.kind === FrameTaskKind.Edit;

			if (shouldPlan) {
				const built = this.taskExecution.buildPlan(id, normalized.prompt, context);
				this.taskExecution.setActivePlan({ ...built, status: 'awaiting_review' });
				const review = await this.planReview.beginReview(built, controller.signal);
				executionPlanId = review.plan.id;

				if (review.decision === 'rejected' || controller.signal.aborted) {
					this._abortControllers.delete(id);
					const cancelled: IFrameTaskPlan = {
						...plan,
						status: FrameTaskStatus.Cancelled,
						notes: 'Task plan rejected or cancelled during review.',
					};
					this._plans.set(id, cancelled);
					const result: IFrameTaskResult = {
						taskId: id,
						status: FrameTaskStatus.Cancelled,
						plan: cancelled,
						executionPlanId,
						message: 'Execution plan rejected — no tools or edits were run.',
					};
					this._onDidCompleteTask.fire(result);
					return result;
				}

				const exec = await this.taskExecution.executePlan(review.plan, context, controller.signal);
				executionPlanId = exec.plan.id;
				editPlanId = exec.editPlanId;
				if (editPlanId) {
					editPlanSummary = this.workspaceEdits.getPendingPlan()?.summary;
				}
				plannerMessage = exec.message;
				if (controller.signal.aborted || (!exec.ok && exec.plan.status === 'cancelled')) {
					this._abortControllers.delete(id);
					const cancelled: IFrameTaskPlan = {
						...plan,
						status: FrameTaskStatus.Cancelled,
						notes: 'Task plan cancelled.',
					};
					this._plans.set(id, cancelled);
					const result: IFrameTaskResult = {
						taskId: id,
						status: FrameTaskStatus.Cancelled,
						plan: cancelled,
						executionPlanId,
						message: exec.message,
					};
					this._onDidCompleteTask.fire(result);
					return result;
				}
			}

			const generatingPlan: IFrameTaskPlan = {
				...plan,
				status: FrameTaskStatus.Generating,
				adapterIds: context.adapters.active.map(a => a.id),
				notes: shouldPlan
					? `Task plan ${executionPlanId ?? ''} executed. Sending stub stream to runtime.`
					: `Context ready (${context.relatedFiles.length} files). Sending to inference runtime.`,
			};
			this._plans.set(id, generatingPlan);

			await this.runtimeService.initialize();

			const inference = await this.runtimeService.generate(context, { signal: controller.signal });
			this._abortControllers.delete(id);

			if (inference.aborted || controller.signal.aborted) {
				const cancelled: IFrameTaskPlan = { ...generatingPlan, status: FrameTaskStatus.Cancelled };
				this._plans.set(id, cancelled);
				const result: IFrameTaskResult = { taskId: id, status: FrameTaskStatus.Cancelled, plan: cancelled };
				this._onDidCompleteTask.fire(result);
				return result;
			}

			if (inference.error) {
				throw new Error(inference.error);
			}
			// Stub / unloaded model must not look like a successful chat reply.
			if (inference.placeholder && !inference.text.trim()) {
				throw new Error('Local model is not loaded. Configure a GGUF in the Frame sidebar.');
			}

			const output = inference.text || '';
			if (!output && !inference.error) {
				this.logService.warn(`[FrameAI] Empty inference text (runtime=${inference.runtimeId} placeholder=${!!inference.placeholder})`);
			}
			const tracked = this.generationTracker.trackGeneration({
				content: output,
				taskId: id,
				file: context.activeRelativePath ?? context.activeFile?.path,
				language: context.languageId,
				project: context.workspace.name,
			});

			const adapterNames = context.adapters.active.map(a => a.name || a.id);
			const selectedModel = this.runtimeService.getSelectedModelMetadata();
			const workerHealth = this.workerManager.health();

			if (!this.chatMemory.getActiveConversationId()) {
				const convId = await this.chatMemory.startConversation();
				this.workerManager.setActiveConversation(convId);
			}
			await this.chatMemory.appendTurn({
				prompt: normalized.prompt,
				response: output,
				modelId: selectedModel?.id ?? this.runtimeService.getConfig().activeModelId ?? null,
				modelDisplayName: selectedModel?.displayName,
				adapters: adapterNames,
				workspaceId: context.workspace.name ?? null,
				taskId: id,
				runtimeId: inference.runtimeId,
				workerId: workerHealth.workerId,
				status: inference.error ?? 'ok',
			});

			// Durable memory gets a summary only (not the full transcript).
			try {
				await this.persistentMemory.saveConversationSummary({
					id: generateUuid(),
					topic: normalized.prompt.trim().slice(0, 80) || 'chat',
					summary: [
						`User: ${normalized.prompt.trim().slice(0, 200)}`,
						`Assistant: ${output.trim().slice(0, 400)}`,
					].join('\n'),
					...(this.chatMemory.getActiveConversationId()
						? { sessionId: this.chatMemory.getActiveConversationId()! }
						: {}),
					relatedFiles: context.activeRelativePath ? [context.activeRelativePath] : [],
				});
			} catch (err) {
				this.logService.trace('[FrameAI] conversation summary write skipped', err);
			}

			await this.generationLog.logGeneration({
				taskId: id,
				durationMs: inference.durationMs,
				contextSize: context.relatedFiles.length + context.relatedChunks.length + context.memories.length + context.preferences.length,
				ragDocumentsUsed: context.relatedChunks.length + context.documentationChunks.length,
				memoryEntriesUsed: context.memories.length + context.preferences.length,
				activeAdapters: adapterNames,
				selectedModel: selectedModel?.id ?? null,
				workerId: workerHealth.workerId,
				runtimeBackend: inference.runtimeId,
				promptPreview: normalized.prompt.slice(0, 200),
				responseChars: output.length,
				status: inference.error ?? (inference.placeholder ? 'MODEL_RUNTIME_NOT_CONNECTED' : 'ok'),
			});

			const completedPlan: IFrameTaskPlan = {
				...generatingPlan,
				status: FrameTaskStatus.Completed,
				notes: `Runtime (${inference.runtimeId}${inference.placeholder ? ', placeholder' : ''}) streamed ${output.length} chars in ${inference.durationMs}ms. Generation ${tracked.generationId} pending accept/reject.`,
			};
			this._plans.set(id, completedPlan);

			let message = this.formatContextSummary(context);
			if (plannerMessage) {
				message = `${message}\n${plannerMessage}`;
			}
			if (!editPlanId && (normalized.kind === FrameTaskKind.Edit || isFrameEditIntent(normalized.prompt))) {
				// Prefer model-emitted ```frame-edit-plan``` JSON; fall back to stub plan.
				const editPlan = await this.workspaceEdits.proposeStubPlan(id, normalized.prompt, context, output);
				editPlanId = editPlan.id;
				editPlanSummary = editPlan.summary;
				message = editPlan.stub
					? `${message}\n${editPlan.summary}`
					: `${message}\nModel edit plan ready — applying safe file changes.`;
			} else if (editPlanId) {
				// The planner's pre-inference plan never saw model output. When the
				// model emitted a parsable ```frame-edit-plan```, it supersedes the
				// earlier stub: dismiss the stub so only one pending plan remains.
				const modelPlan = parseModelEditPlan(id, normalized.prompt, context, output);
				if (modelPlan) {
					this.workspaceEdits.dismissPlan(editPlanId);
					const editPlan = await this.workspaceEdits.proposeStubPlan(id, normalized.prompt, context, output);
					editPlanId = editPlan.id;
					editPlanSummary = editPlan.summary;
					message = editPlan.stub
						? `${message}\n${editPlan.summary}`
						: `${message}\nModel edit plan ready — applying safe file changes.`;
				} else if (editPlanSummary) {
					message = `${message}\nEdit plan ready — applying safe file changes.`;
				}
			}

			const result: IFrameTaskResult = {
				taskId: id,
				status: FrameTaskStatus.Completed,
				plan: completedPlan,
				message,
				output,
				generationId: tracked.generationId,
				editPlanId,
				editPlanSummary,
				executionPlanId,
			};
			this._onDidCompleteTask.fire(result);
			return result;
		} catch (err) {
			this._abortControllers.delete(id);
			const message = err instanceof Error ? err.message : String(err);
			const failedPlan: IFrameTaskPlan = {
				...plan,
				status: FrameTaskStatus.Failed,
				notes: message,
			};
			this._plans.set(id, failedPlan);
			const result: IFrameTaskResult = {
				taskId: id,
				status: FrameTaskStatus.Failed,
				plan: failedPlan,
				error: message,
				message: `Inference failed: ${message}`,
			};
			this._onDidCompleteTask.fire(result);
			return result;
		}
	}

	async cancelTask(taskId: string): Promise<void> {
		this._abortControllers.get(taskId)?.abort();
		this._abortControllers.delete(taskId);
		this.taskExecution.cancel();
		if (this.planReview.isAwaitingReview()) {
			this.planReview.reject();
		}
		const plan = this._plans.get(taskId);
		if (!plan) {
			return;
		}
		const cancelled: IFrameTaskPlan = { ...plan, status: FrameTaskStatus.Cancelled };
		this._plans.set(taskId, cancelled);
		this._onDidCompleteTask.fire({ taskId, status: FrameTaskStatus.Cancelled });
	}

	async buildInferenceContext(taskId: string): Promise<IFrameInferenceContext | undefined> {
		const cached = this._contexts.get(taskId);
		if (cached) {
			return cached;
		}

		const request = this._requests.get(taskId);
		if (!request) {
			return undefined;
		}

		const context = await this.contextService.build({
			taskId,
			request: request.prompt,
			sessionId: request.sessionId,
			activeUri: request.activeUri,
			attachedUris: request.attachedUris,
			selectionText: request.selectionText,
			workspaceFolders: this.workspaceFolders(),
		});
		this._contexts.set(taskId, context);
		return context;
	}

	getPlan(taskId: string): IFrameTaskPlan | undefined {
		return this._plans.get(taskId);
	}

	private workspaceFolders() {
		return this.workspaceService.getWorkspace().folders.map(f => f.uri);
	}

	private formatContextSummary(context: IFrameInferenceContext): string {
		const files = context.relatedFiles.length
			? context.relatedFiles.slice(0, 10).join(', ')
			: '(none)';
		return `Context → runtime: ${context.relatedChunks.length} chunks, files: ${files}`;
	}
}
