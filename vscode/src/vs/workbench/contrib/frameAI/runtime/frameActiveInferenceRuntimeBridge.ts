/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameLocalModelHandle,
	FrameRuntimeKind,
} from '../common/models.js';
import { IFrameRuntimeAdapters, buildRuntimeAdapters, withResolvedAdapterPaths } from './frameAdapterRuntime.js';
import { IFrameModelExecutor } from './frameModelExecution.js';
import { FrameLocalModelExecutor } from './frameLocalModelExecutor.js';
import { IFrameInferenceRuntime } from './frameInferenceRuntime.js';
import { IFrameRuntimeService } from './frameRuntime.js';
import { IFrameModelWorkerManager } from './worker/frameModelWorkerManager.js';

/**
 * DI bridge:
 * Orchestrator → Runtime Bridge → Model Executor → Worker Manager → Worker Process
 *
 * Opens a worker session, streams stub tokens, supports cancellation.
 * No inference.
 */
export class FrameActiveInferenceRuntimeBridge implements IFrameInferenceRuntime {

	declare readonly _serviceBrand: undefined;

	private _sessionOpen = false;
	private readonly _onDidStreamToken = new Emitter<{ readonly taskId: string; readonly token: string }>();
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	constructor(
		@IFrameRuntimeService private readonly runtimeService: IFrameRuntimeService,
		@IFrameModelExecutor private readonly modelExecutor: IFrameModelExecutor,
		@IFrameModelWorkerManager private readonly workerManager: IFrameModelWorkerManager,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		this.workerManager.onDidStream(e => {
			if (e.kind === 'token' && e.token) {
				this._onDidStreamToken.fire({
					taskId: e.taskId ?? e.requestId,
					token: e.token,
				});
			}
		});
	}

	get id(): string {
		return this.runtimeService.getActiveRuntime().id;
	}

	get kind(): FrameRuntimeKind {
		return this.runtimeService.getActiveRuntime().kind;
	}

	get displayName(): string {
		return this.runtimeService.getActiveRuntime().displayName;
	}

	initialize(): Promise<void> {
		return this.runtimeService.initialize();
	}

	isAvailable(): boolean {
		return this.runtimeService.getActiveRuntime().isAvailable();
	}

	isReady(): boolean {
		return this.runtimeService.getActiveRuntime().isReady();
	}

	getModelInfo(): IFrameLocalModelHandle | undefined {
		return this.runtimeService.getActiveRuntime().getModelInfo();
	}

	/** Ensure worker session is open (initialize metadata + optional adapter weight paths). */
	async openSession(): Promise<void> {
		await this.runtimeService.initialize();
		const status = this.runtimeService.getStatus();
		const selected = this.runtimeService.getSelectedModelMetadata();
		const adapters = this.resolveAdapters(selected?.id ?? status.activeModelId ?? 'none', undefined);
		await this.modelExecutor.initialize({
			modelId: selected?.id ?? status.activeModelId ?? 'none',
			modelPath: status.modelPath,
			displayName: selected?.displayName,
			adapters,
			runtimeId: this.id,
		});
		this._sessionOpen = true;
	}

	async generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		if (!this._sessionOpen) {
			await this.openSession();
		} else {
			// Refresh adapters / path metadata without forcing a full worker restart.
			const status = this.runtimeService.getStatus();
			const selected = this.runtimeService.getSelectedModelMetadata();
			const adapters = this.resolveAdapters(
				selected?.id ?? status.activeModelId ?? 'none',
				context,
			);
			await this.modelExecutor.initialize({
				modelId: selected?.id ?? status.activeModelId ?? 'none',
				modelPath: status.modelPath,
				displayName: selected?.displayName,
				adapters,
				runtimeId: this.id,
			});
		}

		return this.modelExecutor.generate(context, options);
	}

	/**
	 * Async iterator of streamed stub tokens for the UI / orchestrator path.
	 */
	async *streamGenerate(
		context: IFrameInferenceContext,
		options?: IFrameGenerateOptions,
	): AsyncGenerator<string, IFrameInferenceResult, void> {
		await this.openSession();
		const status = this.runtimeService.getStatus();
		const selected = this.runtimeService.getSelectedModelMetadata();
		const adapters = this.resolveAdapters(
			selected?.id ?? status.activeModelId ?? 'none',
			context,
		);
		await this.modelExecutor.initialize({
			modelId: selected?.id ?? status.activeModelId ?? 'none',
			modelPath: status.modelPath,
			displayName: selected?.displayName,
			adapters,
			runtimeId: this.id,
		});

		const executor = this.modelExecutor;
		if (executor instanceof FrameLocalModelExecutor) {
			return yield* executor.streamGenerate(context, options);
		}

		const result = await executor.generate(context, options);
		if (result.text) {
			yield result.text;
		}
		return result;
	}

	async cancelActive(requestId: string): Promise<void> {
		await this.workerManager.cancel(requestId);
	}

	dispose(): Promise<void> {
		this._sessionOpen = false;
		return this.runtimeService.getActiveRuntime().dispose();
	}

	private resolveAdapters(baseModel: string, context: IFrameInferenceContext | undefined): IFrameRuntimeAdapters {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		const active = context?.adapters.active ?? [];
		const adapterContext = context?.adapters;
		if (folder && active.length) {
			return withResolvedAdapterPaths(
				baseModel,
				active,
				adapterContext,
				(...parts) => joinPath(folder, ...parts).fsPath,
			);
		}
		return buildRuntimeAdapters(baseModel, active, adapterContext);
	}
}
