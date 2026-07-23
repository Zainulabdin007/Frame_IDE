/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	FrameModelWorkerStatus,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameModelWorkerHealth,
} from '../common/models.js';
import {
	IFrameModelExecutor,
	IFrameModelExecutorHealthView,
	IFrameModelExecutorInit,
} from './frameModelExecution.js';
import { IFrameRuntimeAdapters } from './frameAdapterRuntime.js';
import { IFrameModelWorkerManager } from './worker/frameModelWorkerManager.js';
import { FRAME_MODEL_RUNTIME_NOT_CONNECTED } from './worker/frameModelWorkerProtocol.js';

/**
 * Local model executor — streams via worker manager.
 * Initializes once per model path; does not reload on every generate.
 */
export class FrameLocalModelExecutor implements IFrameModelExecutor {

	declare readonly _serviceBrand: undefined;

	private _runtimeId = 'worker';
	private _lastInit: IFrameModelExecutorInit | undefined;
	private _initializedKey: string | undefined;
	private _generateChain: Promise<void> = Promise.resolve();
	private readonly _onDidStreamToken = new Emitter<{ readonly taskId: string; readonly token: string; readonly requestId: string }>();
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string; readonly requestId: string }> = this._onDidStreamToken.event;

	constructor(
		@IFrameModelWorkerManager private readonly workerManager: IFrameModelWorkerManager,
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.info('[FrameExecutor] Local executor ready');
		this.workerManager.onDidStream(e => {
			if (e.kind === 'token' && e.token) {
				this._onDidStreamToken.fire({
					taskId: e.taskId ?? e.requestId,
					token: e.token,
					requestId: e.requestId,
				});
			}
		});
	}

	private initKey(model: IFrameModelExecutorInit): string {
		let paths = '';
		const adapters = model.adapters;
		if (isRuntimeAdapters(adapters)) {
			paths = (adapters.adapterPaths ?? []).map(p => p.path).sort().join('|');
		}
		return `${model.modelId}::${model.modelPath ?? ''}::${paths}`;
	}

	async initialize(model: IFrameModelExecutorInit): Promise<void> {
		this._lastInit = model;
		this._runtimeId = model.runtimeId ?? this._runtimeId;
		await this.workerManager.start();
		const key = this.initKey(model);
		if (this._initializedKey === key
			&& this.workerManager.health().status === FrameModelWorkerStatus.Ready
			&& this.workerManager.getSnapshot().modelLoaded) {
			return;
		}
		const response = await this.workerManager.sendMessage({
			type: 'initialize',
			modelId: model.modelId,
			modelPath: model.modelPath,
			adapters: model.adapters ?? [],
		});
		if (response.type === 'error') {
			this.logService.warn(`[FrameExecutor] initialize error: ${response.message}`);
			this._initializedKey = undefined;
			return;
		}
		const modelLoaded = !!(response as { modelLoaded?: boolean }).modelLoaded;
		if (!modelLoaded) {
			const initError = (response as { initError?: string }).initError;
			this.logService.warn(`[FrameExecutor] initialize soft-fail modelLoaded=false ${initError ?? '(no initError)'}`);
			this._initializedKey = undefined;
			return;
		}
		this._initializedKey = key;
		this.logService.info(`[FrameExecutor] initialize ok modelLoaded=true id=${model.modelId}`);
	}

	async generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		const run = async (): Promise<IFrameInferenceResult> => {
			const started = Date.now();
			if (options?.signal?.aborted) {
				return {
					taskId: context.taskId,
					text: '',
					runtimeId: this._runtimeId,
					durationMs: Date.now() - started,
					placeholder: true,
					privacyValidated: true,
					aborted: true,
				};
			}

			if (this.workerManager.health().status !== FrameModelWorkerStatus.Ready) {
				await this.workerManager.start();
			}

			// Ensure initialized once — do not reload weights every turn.
			if (this._lastInit) {
				await this.initialize(this._lastInit);
			}

			const requestId = generateUuid();
			const stream = await this.workerManager.generateStream(context, {
				...options,
				requestId,
			});

			const snap = this.workerManager.getSnapshot();
			this.logService.info(
				`[FrameExecutor] generate done status=${stream.status} chars=${stream.text.length} error=${stream.error ?? '(none)'}`,
			);
			return {
				taskId: context.taskId,
				text: stream.text,
				runtimeId: this._runtimeId,
				durationMs: Date.now() - started,
				placeholder: !snap.modelLoaded,
				privacyValidated: true,
				aborted: stream.cancelled,
				error: stream.error
					?? (stream.status === FRAME_MODEL_RUNTIME_NOT_CONNECTED ? FRAME_MODEL_RUNTIME_NOT_CONNECTED : undefined),
			};
		};

		// Serialize turns so the worker never overlaps GGUF sessions.
		const resultPromise = this._generateChain.then(run, run);
		this._generateChain = resultPromise.then(() => undefined, () => undefined);
		return resultPromise;
	}

	/**
	 * Async iterator over stream tokens.
	 */
	async *streamGenerate(
		context: IFrameInferenceContext,
		options?: IFrameGenerateOptions,
	): AsyncGenerator<string, IFrameInferenceResult, void> {
		const started = Date.now();
		const requestId = generateUuid();
		const queue: string[] = [];
		let done = false;
		let endText = '';
		let cancelled = false;
		let err: string | undefined;
		let endStatus: string | undefined;

		if (this._lastInit) {
			await this.initialize(this._lastInit);
		}

		const sub = this.workerManager.onDidStream(e => {
			if (e.requestId !== requestId) {
				return;
			}
			if (e.kind === 'token' && e.token) {
				queue.push(e.token);
			}
			if (e.kind === 'end') {
				endText = e.text ?? queue.join('');
				cancelled = !!e.cancelled;
				endStatus = e.status;
				done = true;
			}
			if (e.kind === 'error') {
				err = e.message;
				done = true;
			}
		});

		const resultPromise = this.workerManager.generateStream(context, { ...options, requestId });

		try {
			while (!done || queue.length) {
				if (options?.signal?.aborted) {
					await this.workerManager.cancel(requestId);
					cancelled = true;
					done = true;
					break;
				}
				if (queue.length) {
					yield queue.shift()!;
					continue;
				}
				await new Promise(r => setTimeout(r, 5));
			}
			const stream = await resultPromise;
			const snap = this.workerManager.getSnapshot();
			const status = endStatus ?? stream.status;
			return {
				taskId: context.taskId,
				text: stream.text || endText,
				runtimeId: this._runtimeId,
				durationMs: Date.now() - started,
				placeholder: !snap.modelLoaded,
				privacyValidated: true,
				aborted: cancelled || stream.cancelled,
				error: err ?? stream.error
					?? (status === FRAME_MODEL_RUNTIME_NOT_CONNECTED ? FRAME_MODEL_RUNTIME_NOT_CONNECTED : undefined),
			};
		} finally {
			sub.dispose();
		}
	}

	async shutdown(): Promise<void> {
		await this.workerManager.stop();
		this._lastInit = undefined;
		this._initializedKey = undefined;
		this.logService.info('[FrameExecutor] shutdown complete');
	}

	health(): IFrameModelWorkerHealth {
		return this.workerManager.health();
	}

	getExecutionView(): IFrameModelExecutorHealthView {
		const snap = this.workerManager.getSnapshot();
		const status = this.workerManager.health().status;
		return {
			worker: String(status).toUpperCase(),
			model: snap.modelLoaded ? 'loaded' : 'not loaded',
			inference: !!snap.inferenceEnabled,
		};
	}
}

function isRuntimeAdapters(value: IFrameModelExecutorInit['adapters']): value is IFrameRuntimeAdapters {
	return !!value && !Array.isArray(value) && typeof value === 'object' && 'baseModel' in value;
}
