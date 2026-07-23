/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import {
	FRAME_MODEL_WORKER_HOST_CHANNEL,
	IFrameModelWorkerHostMainService,
} from '../../../../platform/frameModelWorker/common/frameModelWorkerHost.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	FrameModelWorkerInboundMessage,
	FrameModelWorkerOutboundMessage,
	isMidFlightOutboundMessage,
	isStreamOutboundMessage,
} from '../runtime/worker/frameModelWorkerProtocol.js';
import type { FrameWorkerProcessMessageListener, IFrameWorkerProcessHandle } from '../runtime/worker/frameModelWorkerProcessHost.js';

function isTerminalFor(message: FrameModelWorkerInboundMessage, msg: FrameModelWorkerOutboundMessage): boolean {
	if (message.type === 'generate') {
		if (msg.type === 'streamEnd' || msg.type === 'response') {
			return (msg as { requestId?: string }).requestId === (message as { requestId?: string }).requestId;
		}
		if (msg.type === 'error') {
			const rid = (msg as { requestId?: string }).requestId;
			return !rid || rid === (message as { requestId?: string }).requestId;
		}
		return false;
	}
	if (message.type === 'initialize' || message.type === 'shutdown') {
		// Soft init failures still send ready (modelLoaded: false).
		return msg.type === 'ready';
	}
	if (message.type === 'health') {
		return msg.type === 'health' || msg.type === 'error';
	}
	if (message.type === 'cancel') {
		return (msg.type === 'streamEnd' && (msg as { requestId?: string }).requestId === message.requestId)
			|| msg.type === 'error';
	}
	return false;
}

/**
 * Renderer-side client for the main-process Frame model worker host.
 */
export class FrameModelWorkerHostClient extends Disposable {

	private readonly _proxy: IFrameModelWorkerHostMainService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		const channel = mainProcessService.getChannel(FRAME_MODEL_WORKER_HOST_CHANNEL);
		this._proxy = ProxyChannel.toService<IFrameModelWorkerHostMainService>(channel);
	}

	async spawnFrameModelWorkerProcess(options?: {
		readonly entryPath?: string;
		readonly readyTimeoutMs?: number;
	}): Promise<{ handle: IFrameWorkerProcessHandle; ready: FrameModelWorkerOutboundMessage }> {
		const readyTimeout = options?.readyTimeoutMs ?? 120_000;
		const proxy = this._proxy;
		const sendTimeoutMs = options?.readyTimeoutMs ?? 120_000;

		type Waiter = {
			resolve: (msg: FrameModelWorkerOutboundMessage) => void;
			reject: (err: Error) => void;
			inbound: FrameModelWorkerInboundMessage;
			timer?: ReturnType<typeof setTimeout>;
		};

		let queue: Waiter[] = [];
		const messageListeners = new Set<FrameWorkerProcessMessageListener>();
		const unexpectedExitListeners: Array<(code: number | null, signal: string | null) => void> = [];
		let intentionalStop = false;
		let alive = true;
		let startupResolve: ((msg: FrameModelWorkerOutboundMessage) => void) | undefined;
		let startupReject: ((err: Error) => void) | undefined;
		let startupDone = false;
		let bufferedStartup: FrameModelWorkerOutboundMessage | undefined;

		const readyPromise = new Promise<FrameModelWorkerOutboundMessage>((resolve, reject) => {
			startupResolve = resolve;
			startupReject = reject;
		});

		const finishStartup = (msg: FrameModelWorkerOutboundMessage) => {
			if (startupDone) {
				return;
			}
			startupDone = true;
			startupResolve?.(msg);
		};

		const failStartup = (err: Error) => {
			if (startupDone) {
				return;
			}
			startupDone = true;
			startupReject?.(err);
		};

		const dispatchOutbound = (msg: FrameModelWorkerOutboundMessage) => {
			for (const l of messageListeners) {
				l(msg);
			}
			if (isMidFlightOutboundMessage(msg) || (isStreamOutboundMessage(msg) && msg.type !== 'streamEnd')) {
				return;
			}
			const waiter = queue.find(q => isTerminalFor(q.inbound, msg));
			if (waiter) {
				queue = queue.filter(q => q !== waiter);
				if (waiter.timer) {
					clearTimeout(waiter.timer);
				}
				waiter.resolve(msg);
				return;
			}
			if (!startupDone && msg?.type === 'ready') {
				finishStartup(msg);
				return;
			}
			if (!startupDone) {
				bufferedStartup = msg;
			}
		};

		// Subscribe BEFORE spawn — worker may emit `ready` immediately after fork.
		const msgSub = proxy.onDidReceiveMessage((raw: unknown) => {
			dispatchOutbound(raw as FrameModelWorkerOutboundMessage);
		});
		this._register(toDisposable(() => msgSub.dispose()));

		const exitSub = proxy.onDidExit(({ code, signal }) => {
			alive = false;
			const err = new Error(`Worker process exited (code=${code}, signal=${signal})`);
			for (const q of queue) {
				if (q.timer) {
					clearTimeout(q.timer);
				}
				q.reject(err);
			}
			queue = [];
			failStartup(err);
			if (!intentionalStop) {
				for (const l of unexpectedExitListeners) {
					l(code, signal);
				}
			}
		});
		this._register(toDisposable(() => exitSub.dispose()));

		const readyTimer = setTimeout(() => {
			intentionalStop = true;
			void proxy.terminate(0);
			failStartup(new Error(`Timed out waiting for worker ready (${readyTimeout}ms)`));
		}, readyTimeout);

		const spawn = await proxy.spawn({ entryPath: options?.entryPath });

		if (!startupDone && bufferedStartup?.type === 'ready') {
			finishStartup(bufferedStartup);
		}

		const ready = await readyPromise.finally(() => clearTimeout(readyTimer));
		if (ready.type !== 'ready') {
			intentionalStop = true;
			await proxy.terminate(0);
			throw new Error('Worker process did not signal ready.');
		}

		const postMessage = async (message: FrameModelWorkerInboundMessage) => {
			await proxy.post(message);
		};

		const handle: IFrameWorkerProcessHandle = {
			get pid() {
				return spawn.pid;
			},
			workerId: spawn.workerId || `frame-worker-${generateUuid().slice(0, 8)}`,
			post(message) {
				if (!alive) {
					dispatchOutbound({
						type: 'error',
						requestId: message.type === 'generate' || message.type === 'cancel' || message.type === 'health'
							? message.requestId
							: undefined,
						message: 'Worker process is not connected.',
					});
					return;
				}
				void postMessage(message).catch(err => {
					dispatchOutbound({
						type: 'error',
						requestId: message.type === 'generate' || message.type === 'cancel' || message.type === 'health'
							? message.requestId
							: undefined,
						message: err instanceof Error ? err.message : String(err),
					});
				});
			},
			async send(message) {
				if (!alive) {
					throw new Error('Worker process is not connected.');
				}
				return new Promise<FrameModelWorkerOutboundMessage>((resolve, reject) => {
					const waiter: Waiter = {
						resolve: msg => {
							if (waiter.timer) {
								clearTimeout(waiter.timer);
							}
							resolve(msg);
						},
						reject: err => {
							if (waiter.timer) {
								clearTimeout(waiter.timer);
							}
							reject(err);
						},
						inbound: message,
					};
					waiter.timer = setTimeout(() => {
						queue = queue.filter(q => q !== waiter);
						reject(new Error(`Timed out waiting for worker reply to ${message.type} (${sendTimeoutMs}ms)`));
					}, sendTimeoutMs);
					queue.push(waiter);
					void postMessage(message).catch(err => {
						queue = queue.filter(q => q !== waiter);
						if (waiter.timer) {
							clearTimeout(waiter.timer);
						}
						reject(err instanceof Error ? err : new Error(String(err)));
					});
				});
			},
			async terminate(graceMs = 3000) {
				intentionalStop = true;
				if (!alive) {
					return { code: 0, signal: null };
				}
				const result = await proxy.terminate(graceMs);
				alive = false;
				return result;
			},
			onUnexpectedExit(listener) {
				unexpectedExitListeners.push(listener);
			},
			onMessage(listener) {
				messageListeners.add(listener);
				return () => messageListeners.delete(listener);
			},
		};

		return { handle, ready };
	}
}
