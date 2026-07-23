/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
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
 * llama.cpp backend registration.
 * Available when a local GGUF modelPath exists on disk.
 * Actual inference runs in the isolated Frame model worker (not in this class).
 */
export class FrameLlamaCppRuntimePlaceholder implements IFrameInferenceRuntime {

	declare readonly _serviceBrand: undefined;

	readonly id = 'llamacpp';
	readonly kind: FrameRuntimeKind = 'llamacpp';
	readonly displayName = 'llama.cpp';

	private _modelPath: string | null = null;
	private _pathExists = false;
	private readonly _onDidStreamToken = new Emitter<{ readonly taskId: string; readonly token: string }>();
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		this.logService.trace('[FrameRuntime] llama.cpp runtime registered');
	}

	setModelPath(path: string | null): void {
		if (path === this._modelPath) {
			return;
		}
		this._modelPath = path;
		// Optimistic: treat a configured .gguf path as available immediately.
		// resolveRuntimeForGenerate() used to call setModelPath then isAvailable()
		// in the same turn, which always saw _pathExists=false and fell back to "stub"
		// in logs even while the worker loaded the real GGUF.
		const looksLikeGguf = !!path && path.toLowerCase().endsWith('.gguf');
		this._pathExists = looksLikeGguf;
		if (!looksLikeGguf) {
			return;
		}
		void this.fileService.exists(URI.file(path!)).then(exists => {
			if (this._modelPath === path) {
				this._pathExists = exists;
				if (!exists) {
					this.logService.warn(`[FrameRuntime] llama.cpp modelPath does not exist: ${path}`);
				}
			}
		}, err => {
			this.logService.warn('[FrameRuntime] llama.cpp path existence check failed', err);
		});
	}

	async initialize(): Promise<void> {
		// Weight load happens in the model worker on initialize(modelPath).
		if (this._modelPath?.toLowerCase().endsWith('.gguf')) {
			this._pathExists = await this.fileService.exists(URI.file(this._modelPath));
		}
	}

	isAvailable(): boolean {
		return typeof this._modelPath === 'string'
			&& this._modelPath.length > 0
			&& this._modelPath.toLowerCase().endsWith('.gguf')
			&& this._pathExists;
	}

	isReady(): boolean {
		return this.isAvailable();
	}

	getModelInfo(): IFrameLocalModelHandle | undefined {
		if (!this._modelPath) {
			return undefined;
		}
		return {
			modelId: 'llamacpp-user-model',
			displayName: this.isAvailable() ? 'llama.cpp (GGUF configured)' : 'llama.cpp (path missing or not .gguf)',
			runtime: 'llamacpp',
			ready: this.isAvailable(),
			modelPath: this._modelPath,
		};
	}

	async generate(context: IFrameInferenceContext, _options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		// Generation is routed through FrameLocalModelExecutor → worker; this path is a safety net.
		const message = this.isAvailable()
			? 'llama.cpp path is configured — use the Frame runtime executor / worker bridge for generation.'
			: 'llama.cpp runtime unavailable: set an existing user-provided .gguf modelPath in .frame/config/runtime.json (Frame never downloads weights).';
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
