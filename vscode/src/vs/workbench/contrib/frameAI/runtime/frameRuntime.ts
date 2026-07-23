/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameModelDescriptor,
	IFrameRuntimeConfig,
	IFrameRuntimeDescriptor,
	IFrameRuntimeStatus,
} from '../common/models.js';
import { IFrameInferenceRuntime } from './frameInferenceRuntime.js';

export const IFrameRuntimeService = createDecorator<IFrameRuntimeService>('frameRuntimeService');

/**
 * Registry + selection for local inference backends.
 *
 * Example registered kinds: stub, mlx, llamacpp.
 * Only user-provided model paths are accepted — never downloaded by Frame.
 */
export interface IFrameRuntimeService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeStatus: Event<IFrameRuntimeStatus>;

	/** Relayed token stream from whichever backend is generating. */
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }>;

	/** Register a backend implementation (idempotent by id). */
	registerRuntime(runtime: IFrameInferenceRuntime): void;

	listRuntimes(): readonly IFrameRuntimeDescriptor[];

	getRuntime(id: string): IFrameInferenceRuntime | undefined;

	/** Active backend used for generate (falls back to stub). */
	getActiveRuntime(): IFrameInferenceRuntime;

	selectRuntime(id: string): Promise<void>;

	isAvailable(id: string): boolean;

	getStatus(): IFrameRuntimeStatus;

	getConfig(): IFrameRuntimeConfig;

	/** Selected Frame model profile metadata (not loaded into memory). */
	getSelectedModelMetadata(): IFrameModelDescriptor | undefined;

	/** Persist `.frame/config/runtime.json` and re-apply selection. */
	updateConfig(patch: Partial<IFrameRuntimeConfig>): Promise<IFrameRuntimeConfig>;

	/** Reload config from disk and ensure active runtime is initialized. */
	initialize(): Promise<void>;

	/**
	 * Generate via the active runtime.
	 * Context already includes prompt, files, RAG, memory, adapters, preferences.
	 */
	generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult>;
}
