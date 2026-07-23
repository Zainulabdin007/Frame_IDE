/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { FrameIntelligencePhase } from '../common/frameAI.js';
import { IFrameInferenceContext, IFrameTaskPlan, IFrameTaskRequest, IFrameTaskResult } from '../common/models.js';

export const IFrameOrchestratorService = createDecorator<IFrameOrchestratorService>('frameOrchestratorService');

/**
 * Central coordinator for Frame Intelligence.
 *
 * Responsibilities (this milestone):
 * - Accept task requests from Frame UI
 * - Build {@link IFrameInferenceContext} via the Context Engine
 * - Send context to {@link IFrameRuntimeService} → active {@link IFrameInferenceRuntime}
 * - Never call cloud APIs; stub runtime by default (user-provided weights only later)
 */
export interface IFrameOrchestratorService {
	readonly _serviceBrand: undefined;

	readonly phase: FrameIntelligencePhase;
	readonly onDidChangePhase: Event<FrameIntelligencePhase>;
	readonly onDidCompleteTask: Event<IFrameTaskResult>;
	/** Relayed token stream from the inference runtime. */
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }>;

	/** Enqueue a task: gather context → generate via local runtime (stub). */
	submitTask(request: IFrameTaskRequest): Promise<IFrameTaskResult>;

	/** Cancel a queued or in-flight task. */
	cancelTask(taskId: string): Promise<void>;

	/** Build or return the cached inference context for a task. */
	buildInferenceContext(taskId: string): Promise<IFrameInferenceContext | undefined>;

	/** Peek the last plan for a task, if any. */
	getPlan(taskId: string): IFrameTaskPlan | undefined;
}
