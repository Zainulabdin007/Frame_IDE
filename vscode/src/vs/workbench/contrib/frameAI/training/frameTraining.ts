/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameTrainingJobStatus,
	IFrameTrainingEstimate,
	IFrameTrainingExample,
	IFrameTrainingJob,
	IFrameTrainingJobOptions,
	IFrameTrainingProbe,
} from '../common/models.js';

export const IFrameTrainingManager = createDecorator<IFrameTrainingManager>('frameTrainingManager');

/**
 * Local LoRA training manager.
 * Prefers MLX Metal on Apple Silicon; falls back to CPU; supports pause/cancel/schedule.
 */
export interface IFrameTrainingManager {
	readonly _serviceBrand: undefined;

	readonly onDidChangeJobs: Event<readonly IFrameTrainingJob[]>;

	listJobs(): readonly IFrameTrainingJob[];
	getJob(id: string): IFrameTrainingJob | undefined;

	/** Detect MLX / Apple Silicon and preferred backend. */
	probe(): Promise<IFrameTrainingProbe>;

	/** Estimate duration + RAM before starting. */
	estimate(options?: IFrameTrainingJobOptions): Promise<IFrameTrainingEstimate>;

	createJob(input: {
		name: string;
		baseModelId?: string;
		adapterId?: string;
		examples?: readonly IFrameTrainingExample[];
		options?: IFrameTrainingJobOptions;
	}): Promise<IFrameTrainingJob>;

	addExamples(jobId: string, examples: readonly IFrameTrainingExample[]): Promise<IFrameTrainingJob | undefined>;
	setStatus(jobId: string, status: FrameTrainingJobStatus, error?: string): Promise<IFrameTrainingJob | undefined>;

	/** Show estimate then start (or schedule) via tools/frame-lora-train. */
	start(jobId: string, options?: IFrameTrainingJobOptions): Promise<IFrameTrainingJob | undefined>;

	/** @deprecated Prefer {@link start}. */
	enqueue(jobId: string): Promise<IFrameTrainingJob | undefined>;

	pause(jobId: string): Promise<IFrameTrainingJob | undefined>;
	resume(jobId: string): Promise<IFrameTrainingJob | undefined>;
	cancel(jobId: string): Promise<IFrameTrainingJob | undefined>;
	schedule(jobId: string, when: string): Promise<IFrameTrainingJob | undefined>;

	/** Refresh status from on-disk job files written by the Python manager. */
	refresh(): Promise<readonly IFrameTrainingJob[]>;

	getLastEstimate(): IFrameTrainingEstimate | undefined;
	getLastProbe(): IFrameTrainingProbe | undefined;
}
