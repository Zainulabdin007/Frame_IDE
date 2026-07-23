/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FRAME_PRIVACY_GUARANTEES, FRAME_INTELLIGENCE_NON_GOALS } from '../common/privacy.js';
import {
	FrameRuntimeKind,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameLocalModelHandle,
} from '../common/models.js';
import { IFrameInferenceRuntime } from './frameInferenceRuntime.js';

const STUB_MODEL_ID = 'frame-local-stub';

/**
 * Default local inference runtime (stub).
 *
 * Accepts {@link IFrameInferenceContext}, validates privacy rules, returns a
 * placeholder {@link IFrameInferenceResult}. Does **not** load model weights.
 */
export class FrameLocalInferenceRuntime implements IFrameInferenceRuntime {

	declare readonly _serviceBrand: undefined;

	readonly id = 'stub';
	readonly kind: FrameRuntimeKind = 'stub';
	readonly displayName = 'Frame Local Stub';

	private _initialized = false;
	private _model: IFrameLocalModelHandle | undefined;

	private readonly _onDidStreamToken = new Emitter<{ readonly taskId: string; readonly token: string }>();
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.info('[FrameRuntime] Local stub registered (no model weights)');
	}

	async initialize(): Promise<void> {
		if (this._initialized) {
			return;
		}
		this._initialized = true;
		this._model = {
			modelId: STUB_MODEL_ID,
			displayName: 'Frame Local Runtime Stub',
			runtime: 'stub',
			ready: true,
			modelPath: null,
		};
		this.logService.info('[FrameRuntime] Local stub initialized');
	}

	isAvailable(): boolean {
		return true;
	}

	isReady(): boolean {
		return this._initialized && !!this._model?.ready;
	}

	getModelInfo(): IFrameLocalModelHandle | undefined {
		return this._model;
	}

	async generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		const started = Date.now();
		const privacyValidated = validatePrivacyForGenerate();
		if (!privacyValidated) {
			return {
				taskId: context.taskId,
				text: '',
				runtimeId: this.id,
				modelInfo: this._model,
				durationMs: Date.now() - started,
				placeholder: true,
				privacyValidated: false,
				error: 'Privacy validation failed — refusing to generate.',
			};
		}

		if (!this.isReady()) {
			await this.initialize();
		}

		const chunks = buildStubChunks(context);
		const parts: string[] = [];
		for (const chunk of chunks) {
			if (options?.signal?.aborted) {
				return {
					taskId: context.taskId,
					text: parts.join(''),
					runtimeId: this.id,
					modelInfo: this._model,
					durationMs: Date.now() - started,
					placeholder: true,
					privacyValidated: true,
					aborted: true,
				};
			}
			this._onDidStreamToken.fire({ taskId: context.taskId, token: chunk });
			parts.push(chunk);
		}

		return {
			taskId: context.taskId,
			text: parts.join(''),
			runtimeId: this.id,
			modelInfo: this._model,
			durationMs: Date.now() - started,
			placeholder: true,
			privacyValidated: true,
		};
	}

	async dispose(): Promise<void> {
		this._model = undefined;
		this._initialized = false;
		this._onDidStreamToken.dispose();
		this.logService.info('[FrameRuntime] Local stub disposed');
	}
}

/** @deprecated Prefer {@link FrameLocalInferenceRuntime}. */
export const FrameLocalRuntimeStub = FrameLocalInferenceRuntime;

function validatePrivacyForGenerate(): boolean {
	return (
		FRAME_PRIVACY_GUARANTEES.localOnly
		&& FRAME_PRIVACY_GUARANTEES.noCloudInference
		&& FRAME_PRIVACY_GUARANTEES.noPromptTelemetry
		&& FRAME_INTELLIGENCE_NON_GOALS.length > 0
	);
}

function buildStubChunks(context: IFrameInferenceContext): string[] {
	const request = context.request.trim() || '(empty request)';
	const active = context.activeRelativePath ?? context.activeFile?.path ?? '(none)';
	const files = context.relatedFiles.slice(0, 8).join(', ') || '(none)';
	const adapters = context.adapters.active.map(a => a.name).join(', ') || '(none)';
	const prefs = context.preferences.slice(0, 5).map(p => p.value?.slice(0, 40) ?? p.key).join('; ') || '(none)';
	const selectionNote = context.selectedCode?.trim()
		? `Selection: ${context.selectedCode.trim().slice(0, 160)}${context.selectedCode.trim().length > 160 ? '…' : ''}`
		: 'Selection: (none)';

	const body = [
		'[Frame Local Inference Runtime]',
		'Placeholder response — no coding model attached. User-provided weights only when a backend is enabled.',
		'',
		`Request: ${request}`,
		`Active file: ${active}`,
		selectionNote,
		`Related files (${context.relatedFiles.length}): ${files}`,
		`Code chunks: ${context.relatedChunks.length}; docs: ${context.documentationChunks.length}`,
		`Memories: ${context.memories.length}; preferences: ${context.preferences.length}`,
		`Preferences sample: ${prefs}`,
		`Active adapters: ${adapters}`,
		'',
		'Privacy: local-only · no cloud APIs · no model download.',
		'Next: enable MLX or llama.cpp in .frame/config/runtime.json with a local modelPath.',
	].join('\n');

	const parts: string[] = [];
	const size = 90;
	for (let i = 0; i < body.length; i += size) {
		parts.push(body.slice(i, i + size));
	}
	return parts.length ? parts : [body];
}
