/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	FrameModelWorkerStatus,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameModelWorkerDiagnostics,
	IFrameModelWorkerHealth,
	IFrameModelWorkerSnapshot,
} from '../../common/models.js';
import { FrameModelWorkerHandler } from './frameModelWorker.js';
import type { IFrameWorkerProcessHandle } from './frameModelWorkerProcessHost.js';
import { IFrameModelWorkerProcessSpawner } from './frameModelWorkerProcessSpawner.js';
import {
	FRAME_MODEL_RUNTIME_NOT_CONNECTED,
	FrameModelWorkerInboundMessage,
	FrameModelWorkerOutboundMessage,
	IFrameModelWorkerToolRequestMessage,
	IFrameModelWorkerToolResultMessage,
} from './frameModelWorkerProtocol.js';

export const IFrameModelWorkerManager = createDecorator<IFrameModelWorkerManager>('frameModelWorkerManager');

export interface IFrameWorkerStreamEvent {
	readonly requestId: string;
	readonly taskId?: string;
	readonly kind: 'start' | 'token' | 'end' | 'error' | 'toolRequest';
	readonly token?: string;
	readonly text?: string;
	readonly status?: string;
	readonly cancelled?: boolean;
	readonly message?: string;
	readonly toolRequest?: IFrameModelWorkerToolRequestMessage;
}

export interface IFrameWorkerGenerateStreamResult {
	readonly requestId: string;
	readonly text: string;
	readonly status: string;
	readonly cancelled: boolean;
	readonly error?: string;
}

/**
 * Owns the local model worker child process lifecycle + multi-request streaming + tool round-trips.
 */
export interface IFrameModelWorkerManager {
	readonly _serviceBrand: undefined;

	readonly onDidChangeHealth: Event<IFrameModelWorkerHealth>;
	readonly onDidStream: Event<IFrameWorkerStreamEvent>;
	readonly onDidToolRequest: Event<IFrameModelWorkerToolRequestMessage>;

	start(): Promise<IFrameModelWorkerHealth>;
	stop(): Promise<IFrameModelWorkerHealth>;
	restart(): Promise<IFrameModelWorkerHealth>;
	sendMessage(message: FrameModelWorkerInboundMessage): Promise<FrameModelWorkerOutboundMessage>;
	/** Fire-and-forget tool result back to the worker (keeps generate open). */
	postToolResult(message: IFrameModelWorkerToolResultMessage): void;
	cancel(requestId: string): Promise<void>;
	generateStream(
		context: IFrameInferenceContext,
		options?: IFrameGenerateOptions & { readonly requestId?: string; readonly timeoutMs?: number },
	): Promise<IFrameWorkerGenerateStreamResult>;
	health(): IFrameModelWorkerHealth;
	getSnapshot(): IFrameModelWorkerSnapshot;
	getDiagnostics(): IFrameModelWorkerDiagnostics;
	isProcessRunning(): boolean;
	getPid(): number | null;
	setActiveConversation(id: string | null): void;

	startWorker(): Promise<IFrameModelWorkerHealth>;
	stopWorker(): Promise<IFrameModelWorkerHealth>;
	restartWorker(): Promise<IFrameModelWorkerHealth>;
	getHealth(): IFrameModelWorkerHealth;
	healthCheck(): Promise<IFrameModelWorkerHealth>;
}

interface IPendingRequest {
	readonly requestId: string;
	readonly taskId: string;
	readonly startedAt: number;
	readonly timeoutMs: number;
	timer: ReturnType<typeof setTimeout>;
	tokens: string[];
	resolve: (result: IFrameWorkerGenerateStreamResult) => void;
	reject: (err: Error) => void;
	cleanupAbort?: () => void;
}

export class FrameModelWorkerManager extends Disposable implements IFrameModelWorkerManager {

	declare readonly _serviceBrand: undefined;

	private _status: FrameModelWorkerStatus = FrameModelWorkerStatus.Stopped;
	private _handle: IFrameWorkerProcessHandle | undefined;
	private _fallback: FrameModelWorkerHandler | undefined;
	private _disposeMessageListener: (() => void) | undefined;
	private _lastError: string | undefined;
	private _lastHeartbeatAt: number | null = null;
	private _startedAt: number | null = null;
	private _startEpoch = 0;
	private _startPromise: Promise<IFrameModelWorkerHealth> | undefined;
	private _usingChildProcess = false;
	private _messagesSent = 0;
	private _messagesReceived = 0;
	private _activeConversationId: string | null = null;
	private readonly _pending = new Map<string, IPendingRequest>();
	private _modelLoaded = false;
	private _autoRestart = true;

	private readonly _onDidChangeHealth = this._register(new Emitter<IFrameModelWorkerHealth>());
	readonly onDidChangeHealth: Event<IFrameModelWorkerHealth> = this._onDidChangeHealth.event;

	private readonly _onDidStream = this._register(new Emitter<IFrameWorkerStreamEvent>());
	readonly onDidStream: Event<IFrameWorkerStreamEvent> = this._onDidStream.event;

	private readonly _onDidToolRequest = this._register(new Emitter<IFrameModelWorkerToolRequestMessage>());
	readonly onDidToolRequest: Event<IFrameModelWorkerToolRequestMessage> = this._onDidToolRequest.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFrameModelWorkerProcessSpawner private readonly processSpawner: IFrameModelWorkerProcessSpawner,
	) {
		super();
		this.logService.info('[FrameWorker] Manager ready (streaming + tool calling)');
	}

	getPid(): number | null {
		return this._handle?.pid ?? null;
	}

	setActiveConversation(id: string | null): void {
		this._activeConversationId = id;
		this.fireHealth();
	}

	getDiagnostics(): IFrameModelWorkerDiagnostics {
		return {
			status: this._status,
			pid: this.getPid(),
			pendingRequests: this._pending.size,
			activeConversationId: this._activeConversationId,
			messagesSent: this._messagesSent,
			messagesReceived: this._messagesReceived,
			lastHeartbeatAt: this._lastHeartbeatAt,
			workerId: this._handle?.workerId ?? this._fallback?.workerId ?? null,
			usingChildProcess: this._usingChildProcess,
		};
	}

	health(): IFrameModelWorkerHealth {
		const status = this._status;
		return {
			status,
			healthy: status === FrameModelWorkerStatus.Ready,
			lastHeartbeatAt: this._lastHeartbeatAt,
			message: this._lastError
				?? (status === FrameModelWorkerStatus.Ready
					? (this._usingChildProcess
						? `Worker child process ready (pid=${this.getPid() ?? '?'})${this._modelLoaded ? ' — model loaded.' : ' — awaiting modelPath.'}`
						: 'Worker ready (in-process stub) — child process unavailable.')
					: status === FrameModelWorkerStatus.Stopped
						? 'Worker process stopped.'
						: status === FrameModelWorkerStatus.Starting
							? 'Worker process starting…'
							: status === FrameModelWorkerStatus.Stopping
								? 'Worker process stopping…'
								: 'Worker process error.'),
			memory: {
				ramMb: null,
				gpuMb: null,
				memoryUsage: null,
				gpuUsage: null,
				note: this._modelLoaded
					? 'GPU/RAM metrics not exported by worker yet — model is loaded; Metal may be active inside llama.cpp.'
					: (this._usingChildProcess
						? 'No GPU metrics yet — awaiting modelPath / GGUF load.'
						: 'No GPU metrics (in-process stub; inference not connected).'),
			},
			workerId: this._handle?.workerId ?? this._fallback?.workerId ?? null,
			uptimeMs: this._startedAt ? Math.max(0, Date.now() - this._startedAt) : 0,
			pid: this.getPid(),
			diagnostics: this.getDiagnostics(),
		};
	}

	getHealth(): IFrameModelWorkerHealth {
		return this.health();
	}

	getSnapshot(): IFrameModelWorkerSnapshot {
		const h = this.health();
		const d = this.getDiagnostics();
		return {
			status: h.status,
			healthy: h.healthy,
			message: h.message,
			memory: h.memory,
			processRunning: this.isProcessRunning(),
			modelLoaded: this._modelLoaded,
			inferenceEnabled: this._modelLoaded && this._usingChildProcess,
			pid: h.pid,
			diagnostics: d,
		};
	}

	isProcessRunning(): boolean {
		return this._status === FrameModelWorkerStatus.Ready
			&& (this._usingChildProcess ? !!this._handle : !!this._fallback);
	}

	async start(): Promise<IFrameModelWorkerHealth> {
		if (this._status === FrameModelWorkerStatus.Ready) {
			return this.fireHealth();
		}
		if (this._startPromise) {
			return this._startPromise;
		}

		this._startPromise = this.doStart().finally(() => {
			this._startPromise = undefined;
		});
		return this._startPromise;
	}

	private async doStart(): Promise<IFrameModelWorkerHealth> {
		if (this._status === FrameModelWorkerStatus.Ready) {
			return this.fireHealth();
		}

		const epoch = ++this._startEpoch;
		this._status = FrameModelWorkerStatus.Starting;
		this._lastError = undefined;
		this._modelLoaded = false;
		this.clearProcessHandles();
		this.fireHealth();

		try {
			// Prefer main-process host (Electron sandbox cannot child_process.fork).
			let handle: IFrameWorkerProcessHandle | undefined;
			let ready: FrameModelWorkerOutboundMessage | undefined;
			const spawned = await this.processSpawner.trySpawn();
			if (spawned) {
				handle = spawned.handle;
				ready = spawned.ready;
			} else {
				// Legacy direct fork (may fail in sandboxed renderer).
				const { spawnFrameModelWorkerProcess } = await import('./frameModelWorkerProcessHost.js');
				const direct = await spawnFrameModelWorkerProcess();
				handle = direct.handle;
				ready = direct.ready;
			}
			if (epoch !== this._startEpoch) {
				await handle.terminate(500);
				return this.health();
			}
			if (ready.type !== 'ready') {
				throw new Error('Child worker did not signal ready.');
			}

			this._handle = handle;
			this._usingChildProcess = true;
			this._startedAt = Date.now();
			this._lastHeartbeatAt = Date.now();
			this._status = FrameModelWorkerStatus.Ready;
			this._messagesReceived++;
			this._modelLoaded = !!(ready as { modelLoaded?: boolean }).modelLoaded;
			this._disposeMessageListener = handle.onMessage(msg => this.onWorkerOutbound(msg));

			handle.onUnexpectedExit((code, signal) => {
				if (epoch !== this._startEpoch) {
					return;
				}
				this.logService.error(`[FrameWorker] unexpected exit code=${code} signal=${signal}`);
				this.failPending(`Worker crashed (code=${code}, signal=${signal})`);
				this._lastError = `Worker crashed (code=${code}, signal=${signal})`;
				this._status = FrameModelWorkerStatus.Error;
				this._modelLoaded = false;
				this.clearProcessHandles();
				this.fireHealth();
				if (this._autoRestart) {
					void this.restart();
				}
			});

			this.logService.info(`[FrameWorker] READY child pid=${handle.pid} modelLoaded=${this._modelLoaded}`);
			return this.fireHealth();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[FrameWorker] child_process spawn failed (${message}) — in-process stub fallback`);
			if (epoch !== this._startEpoch) {
				return this.health();
			}
			const fallback = new FrameModelWorkerHandler();
			await fallback.bootstrap();
			fallback.setStreamListener(msg => this.onWorkerOutbound(msg));
			this._fallback = fallback;
			this._usingChildProcess = false;
			this._modelLoaded = false;
			this._startedAt = Date.now();
			this._lastHeartbeatAt = Date.now();
			this._status = FrameModelWorkerStatus.Ready;
			// Keep the spawn error visible so Runtime UI does not claim a real child worker.
			this._lastError = `Child worker unavailable (${message}); using in-process stub.`;
			return this.fireHealth();
		}
	}

	async stop(): Promise<IFrameModelWorkerHealth> {
		this._startEpoch++;
		this._startPromise = undefined;
		this._autoRestart = false;
		this._status = FrameModelWorkerStatus.Stopping;
		this.fireHealth();
		this.failPending('Worker stopping');

		const handle = this._handle;
		const fallback = this._fallback;
		this.clearProcessHandles();

		try {
			if (handle) {
				await handle.terminate(3000);
			} else if (fallback) {
				await fallback.handleMessage({ type: 'shutdown' });
			}
		} catch (err) {
			this.logService.warn(`[FrameWorker] stop error: ${err instanceof Error ? err.message : String(err)}`);
		}

		this._usingChildProcess = false;
		this._startedAt = null;
		this._lastHeartbeatAt = null;
		this._lastError = undefined;
		this._status = FrameModelWorkerStatus.Stopped;
		this._autoRestart = true;
		return this.fireHealth();
	}

	async restart(): Promise<IFrameModelWorkerHealth> {
		const keepAuto = this._autoRestart;
		this._autoRestart = false;
		await this.stop();
		this._autoRestart = keepAuto;
		return this.start();
	}

	async sendMessage(message: FrameModelWorkerInboundMessage): Promise<FrameModelWorkerOutboundMessage> {
		if (this._status !== FrameModelWorkerStatus.Ready) {
			return { type: 'error', message: `Worker process is ${this._status}.` };
		}
		this._messagesSent++;
		this.logService.info(`[FrameWorker] sendMessage type=${message.type}`);
		try {
			let response: FrameModelWorkerOutboundMessage;
			if (this._handle) {
				response = await this._handle.send(message);
			} else if (this._fallback) {
				response = await this._fallback.handleMessage(message);
			} else {
				return { type: 'error', message: 'No worker process.' };
			}
			this._messagesReceived++;
			this._lastHeartbeatAt = Date.now();
			this.fireHealth();
			return response;
		} catch (err) {
			const messageText = err instanceof Error ? err.message : String(err);
			this._lastError = messageText;
			this._status = FrameModelWorkerStatus.Error;
			this.failPending(messageText);
			const handle = this._handle;
			this.clearProcessHandles();
			if (handle) {
				try {
					await handle.terminate(500);
				} catch {
					// ignore terminate errors during failure cleanup
				}
			}
			this.fireHealth();
			return { type: 'error', message: messageText };
		}
	}

	async cancel(requestId: string): Promise<void> {
		const pending = this._pending.get(requestId);
		this._messagesSent++;
		if (this._handle) {
			this._handle.post({ type: 'cancel', requestId });
		} else if (this._fallback) {
			await this._fallback.handleMessage({ type: 'cancel', requestId });
		}
		// If the worker never emits streamEnd, settle after a short grace so generateStream resolves.
		if (pending) {
			clearTimeout(pending.timer);
			pending.timer = setTimeout(() => {
				const current = this._pending.get(requestId);
				if (!current) {
					return;
				}
				this._pending.delete(requestId);
				clearTimeout(current.timer);
				current.cleanupAbort?.();
				current.resolve({
					requestId,
					text: current.tokens.join(''),
					status: 'cancelled',
					cancelled: true,
				});
				this.fireHealth();
			}, 2_000);
		}
	}

	postToolResult(message: IFrameModelWorkerToolResultMessage): void {
		this._messagesSent++;
		this.logService.info(`[FrameWorker] toolResult callId=${message.callId} success=${message.success}`);
		this.refreshPendingTimeout(message.requestId);
		if (this._handle) {
			this._handle.post(message);
		} else if (this._fallback) {
			void this._fallback.handleMessage(message);
		}
	}

	async generateStream(
		context: IFrameInferenceContext,
		options?: IFrameGenerateOptions & { readonly requestId?: string; readonly timeoutMs?: number },
	): Promise<IFrameWorkerGenerateStreamResult> {
		if (this._status !== FrameModelWorkerStatus.Ready) {
			await this.start();
		}
		if (this._status !== FrameModelWorkerStatus.Ready) {
			return {
				requestId: options?.requestId ?? generateUuid(),
				text: '',
				status: 'error',
				cancelled: false,
				error: this._lastError ?? 'Worker not ready.',
			};
		}

		const requestId = options?.requestId ?? generateUuid();
		const timeoutMs = options?.timeoutMs ?? 180_000;

		if (options?.signal?.aborted) {
			return { requestId, text: '', status: 'cancelled', cancelled: true };
		}

		return new Promise<IFrameWorkerGenerateStreamResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				void this.cancel(requestId);
				const pending = this._pending.get(requestId);
				if (pending) {
					this._pending.delete(requestId);
					clearTimeout(pending.timer);
					pending.cleanupAbort?.();
					resolve({
						requestId,
						text: pending.tokens.join(''),
						status: 'timeout',
						cancelled: true,
						error: `Request timed out after ${timeoutMs}ms`,
					});
					this.fireHealth();
				}
			}, timeoutMs);

			const onAbort = () => {
				void this.cancel(requestId);
			};
			options?.signal?.addEventListener('abort', onAbort, { once: true });

			this._pending.set(requestId, {
				requestId,
				taskId: context.taskId,
				startedAt: Date.now(),
				timeoutMs,
				timer,
				tokens: [],
				resolve,
				reject,
				cleanupAbort: () => options?.signal?.removeEventListener('abort', onAbort),
			});
			this.fireHealth();

			this._messagesSent++;
			const inbound: FrameModelWorkerInboundMessage = {
				type: 'generate',
				requestId,
				context,
			};

			// Fire-and-forget: resolve pending from onWorkerOutbound(streamEnd/error).
			// Do NOT use handle.send() here — an early `error` frame would resolve the
			// IPC waiter before tokens/streamEnd and leave the UI with empty output.
			try {
				if (this._handle) {
					this._handle.post(inbound);
				} else if (this._fallback) {
					void this._fallback.handleMessage(inbound).then(terminal => {
						this.settleGenerate(requestId, terminal);
					}, err => {
						this.settleGenerate(requestId, {
							type: 'error',
							requestId,
							message: err instanceof Error ? err.message : String(err),
						});
					});
				} else {
					this.settleGenerate(requestId, {
						type: 'error',
						requestId,
						message: 'No worker.',
					});
				}
			} catch (err) {
				this.settleGenerate(requestId, {
					type: 'error',
					requestId,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		});
	}

	private settleGenerate(
		requestId: string,
		terminal: FrameModelWorkerOutboundMessage,
	): void {
		const pending = this._pending.get(requestId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this._pending.delete(requestId);
		pending.cleanupAbort?.();
		this._messagesReceived++;
		this._lastHeartbeatAt = Date.now();

		if (terminal.type === 'error') {
			pending.resolve({
				requestId,
				text: pending.tokens.join(''),
				status: 'error',
				cancelled: false,
				error: terminal.message,
			});
		} else if (terminal.type === 'streamEnd') {
			const status = terminal.status;
			const text = terminal.text || pending.tokens.join('');
			const explicitError = (terminal as { error?: string }).error;
			pending.resolve({
				requestId,
				text,
				status,
				cancelled: !!terminal.cancelled,
				error: explicitError
					?? (status === 'error' ? (text || 'Worker generate failed') : undefined)
					?? (status === FRAME_MODEL_RUNTIME_NOT_CONNECTED ? FRAME_MODEL_RUNTIME_NOT_CONNECTED : undefined),
			});
		} else if (terminal.type === 'response') {
			const status = terminal.status || FRAME_MODEL_RUNTIME_NOT_CONNECTED;
			const text = terminal.text || pending.tokens.join('');
			const explicitError = (terminal as { error?: string }).error;
			pending.resolve({
				requestId,
				text,
				status,
				cancelled: false,
				error: explicitError
					?? (status === 'error' ? (text || 'Worker generate failed') : undefined)
					?? (status === FRAME_MODEL_RUNTIME_NOT_CONNECTED ? FRAME_MODEL_RUNTIME_NOT_CONNECTED : undefined),
			});
		} else {
			pending.resolve({
				requestId,
				text: pending.tokens.join(''),
				status: FRAME_MODEL_RUNTIME_NOT_CONNECTED,
				cancelled: false,
				error: FRAME_MODEL_RUNTIME_NOT_CONNECTED,
			});
		}
		this.fireHealth();
	}

	async startWorker(): Promise<IFrameModelWorkerHealth> {
		return this.start();
	}

	async stopWorker(): Promise<IFrameModelWorkerHealth> {
		return this.stop();
	}

	async restartWorker(): Promise<IFrameModelWorkerHealth> {
		return this.restart();
	}

	async healthCheck(): Promise<IFrameModelWorkerHealth> {
		if (this._status === FrameModelWorkerStatus.Ready) {
			const res = await this.sendMessage({ type: 'health', requestId: generateUuid() });
			if (res.type === 'health' && res.ok) {
				this._lastHeartbeatAt = Date.now();
			}
		}
		return this.fireHealth();
	}

	private onWorkerOutbound(msg: FrameModelWorkerOutboundMessage): void {
		this._messagesReceived++;
		this._lastHeartbeatAt = Date.now();

		if (msg.type === 'ready') {
			const ready = msg as { modelLoaded?: boolean };
			if (typeof ready.modelLoaded === 'boolean') {
				this._modelLoaded = ready.modelLoaded;
				this.fireHealth();
			}
			return;
		}
		if (msg.type === 'health') {
			const health = msg as { modelLoaded?: boolean };
			if (typeof health.modelLoaded === 'boolean') {
				this._modelLoaded = health.modelLoaded;
			}
			return;
		}
		if (msg.type === 'streamStart') {
			this._onDidStream.fire({ requestId: msg.requestId, kind: 'start', taskId: this._pending.get(msg.requestId)?.taskId });
			return;
		}
		if (msg.type === 'streamToken') {
			const pending = this._pending.get(msg.requestId);
			pending?.tokens.push(msg.token);
			this._onDidStream.fire({
				requestId: msg.requestId,
				taskId: pending?.taskId,
				kind: 'token',
				token: msg.token,
			});
			return;
		}
		if (msg.type === 'toolRequest') {
			this.refreshPendingTimeout(msg.requestId);
			this._onDidToolRequest.fire(msg);
			this._onDidStream.fire({
				requestId: msg.requestId,
				taskId: this._pending.get(msg.requestId)?.taskId,
				kind: 'toolRequest',
				toolRequest: msg,
			});
			return;
		}
		if (msg.type === 'streamEnd') {
			this._onDidStream.fire({
				requestId: msg.requestId,
				taskId: this._pending.get(msg.requestId)?.taskId,
				kind: 'end',
				text: msg.text,
				status: msg.status,
				cancelled: msg.cancelled,
			});
			this.settleGenerate(msg.requestId, msg);
			return;
		}
		if (msg.type === 'response') {
			this.settleGenerate(msg.requestId, msg);
			return;
		}
		if (msg.type === 'error' && msg.requestId) {
			this._onDidStream.fire({
				requestId: msg.requestId,
				taskId: this._pending.get(msg.requestId)?.taskId,
				kind: 'error',
				message: msg.message,
			});
			// Settle immediately — worker may send bare `error` without streamEnd.
			this.settleGenerate(msg.requestId, msg);
			return;
		}
		if (msg.type === 'error') {
			this.logService.warn(`[FrameWorker] worker error: ${msg.message}`);
		}
	}

	private refreshPendingTimeout(requestId: string): void {
		const pending = this._pending.get(requestId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			void this.cancel(requestId);
			const current = this._pending.get(requestId);
			if (current) {
				this._pending.delete(requestId);
				clearTimeout(current.timer);
				current.resolve({
					requestId,
					text: current.tokens.join(''),
					status: 'timeout',
					cancelled: true,
					error: `Request timed out after ${current.timeoutMs}ms`,
				});
				this.fireHealth();
			}
		}, pending.timeoutMs);
	}

	private failPending(reason: string): void {
		for (const [id, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.resolve({
				requestId: id,
				text: pending.tokens.join(''),
				status: 'error',
				cancelled: false,
				error: reason,
			});
		}
		this._pending.clear();
	}

	private clearProcessHandles(): void {
		this._disposeMessageListener?.();
		this._disposeMessageListener = undefined;
		this._handle = undefined;
		this._fallback?.setStreamListener(undefined);
		this._fallback = undefined;
	}

	private fireHealth(): IFrameModelWorkerHealth {
		const health = this.health();
		this._onDidChangeHealth.fire(health);
		return health;
	}
}
