/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameLocalModelHandle,
	IFrameModelWorkerHealth,
} from '../common/models.js';
import { IFrameRuntimeAdapters } from './frameAdapterRuntime.js';

export const IFrameModelExecutor = createDecorator<IFrameModelExecutor>('frameModelExecutor');

/**
 * Contract for executing a local model **only through the worker boundary**.
 *
 * Implementations must not load weights into the Electron IDE process.
 */
export interface IFrameModelExecutor {
	readonly _serviceBrand: undefined;

	initialize(model: IFrameModelExecutorInit): Promise<void>;

	generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult>;

	shutdown(): Promise<void>;

	health(): IFrameModelWorkerHealth;

	/** Honest worker/model/inference snapshot for Runtime UI. */
	getExecutionView(): IFrameModelExecutorHealthView;
}

export interface IFrameModelExecutorInit {
	readonly modelId: string;
	readonly modelPath: string | null;
	readonly displayName?: string;
	readonly handle?: IFrameLocalModelHandle;
	readonly adapters?: IFrameRuntimeAdapters | readonly string[];
	readonly runtimeId?: string;
}

export interface IFrameModelExecutorHealthView {
	readonly worker: string;
	readonly model: 'not loaded' | 'loaded';
	readonly inference: boolean;
}
