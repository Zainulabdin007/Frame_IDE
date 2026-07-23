/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import { FrameModelWorkerStatus, IFrameModelWorkerMemoryStatus } from '../../common/models.js';
import {
	FRAME_MODEL_RUNTIME_NOT_CONNECTED,
	FrameModelWorkerInboundMessage,
	FrameModelWorkerOutboundMessage,
	IFrameModelWorkerGenerateMessage,
	IFrameModelWorkerInitializeMessage,
	IFrameModelWorkerToolResultMessage,
	isWorkerInboundMessage,
} from './frameModelWorkerProtocol.js';

export type FrameModelWorkerStreamListener = (msg: FrameModelWorkerOutboundMessage) => void;

/**
 * In-process protocol handler (fallback when child_process is unavailable).
 * Mirrors tools/frame-model-worker streaming + tool stub loop — no inference.
 */
export class FrameModelWorkerHandler {

	readonly workerId: string;
	private _status: FrameModelWorkerStatus = FrameModelWorkerStatus.Stopped;
	private _startedAt: number | null = null;
	private _lastError: string | undefined;
	private _initializedModelId: string | null = null;
	private _initializedModelPath: string | null = null;
	private readonly _active = new Map<string, { cancelled: boolean }>();
	private readonly _pendingTools = new Map<string, (msg: IFrameModelWorkerToolResultMessage) => void>();
	private _streamListener: FrameModelWorkerStreamListener | undefined;

	constructor(workerId?: string) {
		this.workerId = workerId ?? `frame-worker-${generateUuid().slice(0, 8)}`;
	}

	get status(): FrameModelWorkerStatus {
		return this._status;
	}

	get lastError(): string | undefined {
		return this._lastError;
	}

	get startedAt(): number | null {
		return this._startedAt;
	}

	get pendingCount(): number {
		return this._active.size;
	}

	setStreamListener(listener: FrameModelWorkerStreamListener | undefined): void {
		this._streamListener = listener;
	}

	async bootstrap(): Promise<FrameModelWorkerOutboundMessage> {
		this._status = FrameModelWorkerStatus.Starting;
		this._lastError = undefined;
		await Promise.resolve();
		this._status = FrameModelWorkerStatus.Ready;
		this._startedAt = Date.now();
		return { type: 'ready' };
	}

	async stop(): Promise<void> {
		this._status = FrameModelWorkerStatus.Stopping;
		for (const slot of this._active.values()) {
			slot.cancelled = true;
		}
		this._active.clear();
		for (const [callId, resolve] of this._pendingTools) {
			this._pendingTools.delete(callId);
			resolve({ type: 'toolResult', requestId: '', callId, success: false, error: 'shutdown' });
		}
		this._status = FrameModelWorkerStatus.Stopped;
		this._startedAt = null;
		this._initializedModelId = null;
		this._initializedModelPath = null;
	}

	markError(message: string): void {
		this._status = FrameModelWorkerStatus.Error;
		this._lastError = message;
	}

	memoryUsage(): IFrameModelWorkerMemoryStatus {
		return {
			ramMb: null,
			gpuMb: null,
			memoryUsage: null,
			gpuUsage: null,
			note: 'Handler fallback — no GPU metrics.',
		};
	}

	async handleMessage(raw: unknown): Promise<FrameModelWorkerOutboundMessage> {
		if (!isWorkerInboundMessage(raw)) {
			return { type: 'error', message: 'Invalid worker protocol message.' };
		}
		return this.dispatch(raw);
	}

	private emit(msg: FrameModelWorkerOutboundMessage): void {
		this._streamListener?.(msg);
	}

	private async dispatch(message: FrameModelWorkerInboundMessage): Promise<FrameModelWorkerOutboundMessage> {
		switch (message.type) {
			case 'initialize':
				return this.onInitialize(message);
			case 'generate':
				return this.onGenerate(message);
			case 'toolResult': {
				const resolve = this._pendingTools.get(message.callId);
				if (resolve) {
					this._pendingTools.delete(message.callId);
					resolve(message);
				}
				return { type: 'ready' };
			}
			case 'cancel': {
				const slot = this._active.get(message.requestId);
				if (slot) {
					slot.cancelled = true;
				}
				for (const [callId, resolve] of this._pendingTools) {
					this._pendingTools.delete(callId);
					resolve({
						type: 'toolResult',
						requestId: message.requestId,
						callId,
						success: false,
						error: 'cancelled',
					});
				}
				const end = {
					type: 'streamEnd' as const,
					requestId: message.requestId,
					text: '',
					status: 'cancelled',
					cancelled: true,
				};
				this.emit(end);
				return end;
			}
			case 'health':
				return {
					type: 'health',
					requestId: message.requestId,
					ok: true,
					pending: this._active.size,
				};
			case 'shutdown':
				await this.stop();
				return { type: 'ready' };
			default: {
				const _exhaustive: never = message;
				void _exhaustive;
				return { type: 'error', message: 'Unknown worker message type.' };
			}
		}
	}

	private onInitialize(message: IFrameModelWorkerInitializeMessage): FrameModelWorkerOutboundMessage {
		if (this._status !== FrameModelWorkerStatus.Ready && this._status !== FrameModelWorkerStatus.Starting) {
			return { type: 'error', message: 'Worker must be started before initialize.' };
		}
		this._initializedModelId = message.modelId || null;
		this._initializedModelPath = message.modelPath;
		this._status = FrameModelWorkerStatus.Ready;
		return { type: 'ready' };
	}

	private async onGenerate(message: IFrameModelWorkerGenerateMessage): Promise<FrameModelWorkerOutboundMessage> {
		if (this._status !== FrameModelWorkerStatus.Ready) {
			return {
				type: 'error',
				requestId: message.requestId,
				message: `Worker not ready (status=${this._status}).`,
			};
		}

		const slot = { cancelled: false };
		this._active.set(message.requestId, slot);
		this.emit({ type: 'streamStart', requestId: message.requestId });

		const cancelled = slot.cancelled;
		this._active.delete(message.requestId);
		const error = `MODEL_RUNTIME_NOT_CONNECTED — in-process stub (child worker unavailable; modelId=${this._initializedModelId ?? '(none)'}, modelPath=${this._initializedModelPath ?? '(none)'}). Configure a GGUF in the Frame sidebar.`;
		const end: FrameModelWorkerOutboundMessage = {
			type: 'streamEnd',
			requestId: message.requestId,
			text: '',
			status: cancelled ? 'cancelled' : FRAME_MODEL_RUNTIME_NOT_CONNECTED,
			cancelled,
			error: cancelled ? undefined : error,
		};
		this.emit(end);

		if (cancelled) {
			return end;
		}

		return {
			type: 'response',
			requestId: message.requestId,
			text: '',
			status: FRAME_MODEL_RUNTIME_NOT_CONNECTED,
			error,
		};
	}
}
/** @deprecated Prefer {@link FrameModelWorkerHandler}. */
export const FrameModelWorker = FrameModelWorkerHandler;
