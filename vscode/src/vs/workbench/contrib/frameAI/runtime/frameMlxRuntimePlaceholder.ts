/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	FrameRuntimeKind,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameLocalModelHandle,
} from '../common/models.js';
import { IFrameInferenceRuntime } from './frameInferenceRuntime.js';

/**
 * Future MLX backend placeholder (Apple Silicon).
 * Registered for discovery — not available until user supplies modelPath + native bridge.
 * Does not download weights.
 */
export class FrameMlxRuntimePlaceholder implements IFrameInferenceRuntime {

	declare readonly _serviceBrand: undefined;

	readonly id = 'mlx';
	readonly kind: FrameRuntimeKind = 'mlx';
	readonly displayName = 'MLX';

	private _modelPath: string | null = null;
	private readonly _onDidStreamToken = new Emitter<{ readonly taskId: string; readonly token: string }>();
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.trace('[FrameRuntime] MLX placeholder registered (unavailable until local weights + bridge)');
	}

	setModelPath(path: string | null): void {
		this._modelPath = path;
	}

	async initialize(): Promise<void> {
		// Native MLX bridge not wired — intentional no-op.
	}

	isAvailable(): boolean {
		// Native bridge not shipped; require explicit local path when wired later.
		return false;
	}

	isReady(): boolean {
		return false;
	}

	getModelInfo(): IFrameLocalModelHandle | undefined {
		if (!this._modelPath) {
			return undefined;
		}
		return {
			modelId: 'mlx-user-model',
			displayName: 'MLX (not loaded)',
			runtime: 'mlx',
			ready: false,
			modelPath: this._modelPath,
		};
	}

	async generate(context: IFrameInferenceContext, _options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		const message = this._modelPath
			? 'MLX runtime is registered but the native bridge is not wired yet. No inference performed.'
			: 'MLX runtime unavailable: set a user-provided modelPath in .frame/config/runtime.json (Frame never downloads weights).';
		return {
			taskId: context.taskId,
			text: '',
			runtimeId: this.id,
			modelInfo: this.getModelInfo(),
			durationMs: 0,
			placeholder: true,
			privacyValidated: true,
			error: message,
		};
	}

	async dispose(): Promise<void> {
		this._onDidStreamToken.dispose();
	}
}
