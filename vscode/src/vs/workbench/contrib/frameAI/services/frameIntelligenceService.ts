/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FrameIntelligencePhase } from '../common/frameAI.js';
import { FRAME_PRIVACY_GUARANTEES, FramePrivacyGuarantees } from '../common/privacy.js';
import { FrameTaskKind, IFrameChatMessage, IFrameLocalModelHandle, IFrameTaskRequest, IFrameTaskResult } from '../common/models.js';
import { IFrameOrchestratorService } from '../orchestrator/frameOrchestrator.js';
import { IFrameMemoryService } from '../memory/frameMemory.js';
import { IFramePersistentMemoryService } from '../memory/persistentMemory.js';
import { IFrameRagService } from '../rag/frameRag.js';
import { IFrameAdapterService } from '../adapters/frameAdapters.js';
import { IFrameAdapterManagementService } from '../adapters/frameAdapterManagement.js';
import { IFrameTrainingManager } from '../training/frameTraining.js';
import { IFrameContextService } from '../context/frameContext.js';
import { IFrameInferenceRuntime } from '../runtime/frameInferenceRuntime.js';
import { IFrameRuntimeService } from '../runtime/frameRuntime.js';
import { IFrameModelWorkerManager } from '../runtime/worker/frameModelWorkerManager.js';
import { IFrameModelExecutor } from '../runtime/frameModelExecution.js';
import { IFrameModelService } from '../models/frameModels.js';
import { IFrameModelInstallerService } from '../models/frameModelInstaller.js';
import { IFrameModelImportService } from '../models/frameModelImport.js';
import { IFrameModelSignatureService } from '../models/frameModelSignature.js';
import { IFrameModelKeyStore } from '../models/frameModelKeyStore.js';
import { IFrameHardwareService } from '../hardware/frameHardware.js';
import { IFrameModelCompatibilityService } from '../hardware/frameModelCompatibility.js';
import { IFrameChatMemoryService } from '../memory/frameChatMemory.js';
import { IFrameObservationService } from '../preferences/frameObservation.js';
import { IFrameGenerationTracker } from '../preferences/frameGenerationTracker.js';
import { IFramePreferenceReviewService } from '../preferences/framePreferenceReview.js';
import { IFrameWorkspaceEditService } from '../editing/frameWorkspaceEditService.js';
import { IFrameToolExecutionService } from '../runtime/tools/frameToolExecutionService.js';
import { IFrameTaskExecutionService } from '../planning/frameTaskExecutor.js';
import { IFramePlanReviewService } from '../planning/framePlanReviewService.js';
import { IFramePlanTemplateService } from '../planning/framePlanTemplateService.js';
import { IFrameKnowledgeService } from '../knowledge/frameKnowledgeService.js';
import { IFrameBackgroundIntelligence } from '../background/frameBackgroundIntelligence.js';
import { IFrameIntelligenceService } from './frameIntelligence.js';

export class FrameIntelligenceService extends Disposable implements IFrameIntelligenceService {

	declare readonly _serviceBrand: undefined;

	readonly privacy: FramePrivacyGuarantees = FRAME_PRIVACY_GUARANTEES;

	constructor(
		@IFrameOrchestratorService public readonly orchestrator: IFrameOrchestratorService,
		@IFrameContextService public readonly context: IFrameContextService,
		@IFrameInferenceRuntime public readonly runtime: IFrameInferenceRuntime,
		@IFrameRuntimeService public readonly runtimes: IFrameRuntimeService,
		@IFrameModelWorkerManager public readonly modelWorker: IFrameModelWorkerManager,
		@IFrameModelExecutor public readonly modelExecutor: IFrameModelExecutor,
		@IFrameModelService public readonly models: IFrameModelService,
		@IFrameModelInstallerService public readonly modelInstaller: IFrameModelInstallerService,
		@IFrameModelImportService public readonly modelImport: IFrameModelImportService,
		@IFrameModelSignatureService public readonly modelSignatures: IFrameModelSignatureService,
		@IFrameModelKeyStore public readonly modelKeys: IFrameModelKeyStore,
		@IFrameHardwareService public readonly hardware: IFrameHardwareService,
		@IFrameModelCompatibilityService public readonly modelCompatibility: IFrameModelCompatibilityService,
		@IFrameMemoryService public readonly memory: IFrameMemoryService,
		@IFramePersistentMemoryService public readonly persistentMemory: IFramePersistentMemoryService,
		@IFrameChatMemoryService public readonly chatMemory: IFrameChatMemoryService,
		@IFrameObservationService public readonly observations: IFrameObservationService,
		@IFramePreferenceReviewService public readonly preferenceReview: IFramePreferenceReviewService,
		@IFrameGenerationTracker public readonly generations: IFrameGenerationTracker,
		@IFrameRagService public readonly rag: IFrameRagService,
		@IFrameAdapterService public readonly adapters: IFrameAdapterService,
		@IFrameAdapterManagementService public readonly adapterManagement: IFrameAdapterManagementService,
		@IFrameTrainingManager public readonly training: IFrameTrainingManager,
		@IFrameWorkspaceEditService public readonly workspaceEdits: IFrameWorkspaceEditService,
		@IFrameToolExecutionService public readonly tools: IFrameToolExecutionService,
		@IFrameTaskExecutionService public readonly taskPlanning: IFrameTaskExecutionService,
		@IFramePlanReviewService public readonly planReview: IFramePlanReviewService,
		@IFramePlanTemplateService public readonly planTemplates: IFramePlanTemplateService,
		@IFrameKnowledgeService public readonly knowledge: IFrameKnowledgeService,
		@IFrameBackgroundIntelligence public readonly background: IFrameBackgroundIntelligence,
	) {
		super();
	}

	get phase(): FrameIntelligencePhase {
		return this.orchestrator.phase;
	}

	get onDidChangePhase(): Event<FrameIntelligencePhase> {
		return this.orchestrator.onDidChangePhase;
	}

	getLocalModel(): IFrameLocalModelHandle {
		return this.runtime.getModelInfo() ?? {
			modelId: 'none',
			displayName: 'No local model attached',
			runtime: 'none',
			ready: false,
			modelPath: null,
		};
	}

	submitChat(prompt: string, sessionId?: string, taskId?: string, messages?: readonly IFrameChatMessage[]): Promise<IFrameTaskResult> {
		const request: IFrameTaskRequest = {
			id: taskId || generateUuid(),
			kind: FrameTaskKind.Chat,
			prompt,
			sessionId,
			createdAt: Date.now(),
			messages,
		};
		return this.orchestrator.submitTask(request);
	}

	submitTask(request: IFrameTaskRequest): Promise<IFrameTaskResult> {
		return this.orchestrator.submitTask(request);
	}
}
