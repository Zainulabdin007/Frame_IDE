/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { FrameIntelligencePhase } from '../common/frameAI.js';
import { FramePrivacyGuarantees } from '../common/privacy.js';
import { IFrameChatMessage, IFrameLocalModelHandle, IFrameTaskRequest, IFrameTaskResult } from '../common/models.js';
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

export const IFrameIntelligenceService = createDecorator<IFrameIntelligenceService>('frameIntelligenceService');

/**
 * Facade over the Frame Intelligence stack for UI and future commands.
 * Prefer this from the Frame AI panel rather than reaching into subsystems.
 */
export interface IFrameIntelligenceService {
	readonly _serviceBrand: undefined;

	readonly privacy: FramePrivacyGuarantees;
	readonly phase: FrameIntelligencePhase;
	readonly onDidChangePhase: Event<FrameIntelligencePhase>;

	readonly orchestrator: IFrameOrchestratorService;
	readonly context: IFrameContextService;
	readonly runtime: IFrameInferenceRuntime;
	readonly runtimes: IFrameRuntimeService;
	readonly modelWorker: IFrameModelWorkerManager;
	readonly modelExecutor: IFrameModelExecutor;
	readonly models: IFrameModelService;
	readonly modelInstaller: IFrameModelInstallerService;
	readonly modelImport: IFrameModelImportService;
	readonly modelSignatures: IFrameModelSignatureService;
	readonly modelKeys: IFrameModelKeyStore;
	readonly hardware: IFrameHardwareService;
	readonly modelCompatibility: IFrameModelCompatibilityService;
	readonly memory: IFrameMemoryService;
	readonly persistentMemory: IFramePersistentMemoryService;
	readonly chatMemory: IFrameChatMemoryService;
	readonly observations: IFrameObservationService;
	readonly preferenceReview: IFramePreferenceReviewService;
	readonly generations: IFrameGenerationTracker;
	readonly rag: IFrameRagService;
	readonly adapters: IFrameAdapterService;
	readonly adapterManagement: IFrameAdapterManagementService;
	readonly training: IFrameTrainingManager;
	readonly workspaceEdits: IFrameWorkspaceEditService;
	readonly tools: IFrameToolExecutionService;
	readonly taskPlanning: IFrameTaskExecutionService;
	readonly planReview: IFramePlanReviewService;
	readonly planTemplates: IFramePlanTemplateService;
	readonly knowledge: IFrameKnowledgeService;
	readonly background: IFrameBackgroundIntelligence;

	/**
	 * Local model handle from the active inference runtime (stub until user weights + backend).
	 */
	getLocalModel(): IFrameLocalModelHandle;

	/** Convenience: submit a chat-style task through the orchestrator. */
	submitChat(prompt: string, sessionId?: string, taskId?: string, messages?: readonly IFrameChatMessage[]): Promise<IFrameTaskResult>;

	/** Convenience: submit an arbitrary task request. */
	submitTask(request: IFrameTaskRequest): Promise<IFrameTaskResult>;
}
