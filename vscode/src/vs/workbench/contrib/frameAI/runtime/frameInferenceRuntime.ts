/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameRuntimeKind,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameLocalModelHandle,
} from '../common/models.js';

export const IFrameInferenceRuntime = createDecorator<IFrameInferenceRuntime>('frameInferenceRuntime');

/**
 * Pluggable local inference backend.
 *
 * Frame talks to this abstraction only — never to cloud / OpenAI / Anthropic APIs.
 * Implementations must only load **user-provided** on-disk weights (when wired).
 *
 * Current: {@link FrameLocalInferenceRuntime} (stub, no model load).
 * Future: MLX / llama.cpp adapters registered beside the stub.
 */
export interface IFrameInferenceRuntime {
	readonly _serviceBrand: undefined;

	readonly id: string;
	readonly kind: FrameRuntimeKind;
	readonly displayName: string;

	/** Fired for each streamed token/chunk during {@link generate}. */
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }>;

	/** Prepare the runtime (no network). Idempotent. */
	initialize(): Promise<void>;

	/**
	 * True when this backend can run on this machine with the current config.
	 * Stub is always available. MLX / llama.cpp stay false until native + modelPath exist.
	 */
	isAvailable(): boolean;

	/** True after initialize and (when required) a local model bind. */
	isReady(): boolean;

	/** Active / bound model info (undefined until ready or when stub-only). */
	getModelInfo(): IFrameLocalModelHandle | undefined;

	/**
	 * Generate from an assembled {@link IFrameInferenceContext}.
	 * Validates privacy rules; never opens network sockets.
	 */
	generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult>;

	/** Tear down native resources / unload weights. */
	dispose(): Promise<void>;
}
