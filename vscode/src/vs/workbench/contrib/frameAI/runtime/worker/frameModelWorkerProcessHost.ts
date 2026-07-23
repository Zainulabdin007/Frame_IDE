/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { existsSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import {
	FrameModelWorkerInboundMessage,
	FrameModelWorkerOutboundMessage,
	isMidFlightOutboundMessage,
	isStreamOutboundMessage,
} from './frameModelWorkerProtocol.js';

export type FrameWorkerProcessMessageListener = (msg: FrameModelWorkerOutboundMessage) => void;

export interface IFrameWorkerProcessHandle {
	readonly pid: number | null;
	readonly workerId: string;
	/** Send and wait for a terminal reply (ready / response / streamEnd / error / health). */
	send(message: FrameModelWorkerInboundMessage): Promise<FrameModelWorkerOutboundMessage>;
	/** Fire-and-forget (e.g. cancel) — still routes stream events via onMessage. */
	post(message: FrameModelWorkerInboundMessage): void;
	terminate(graceMs?: number): Promise<{ code: number | null; signal: string | null }>;
	readonly onUnexpectedExit: (listener: (code: number | null, signal: string | null) => void) => void;
	readonly onMessage: (listener: FrameWorkerProcessMessageListener) => () => void;
}

/**
 * Resolve the standalone Node worker entry (tools/frame-model-worker).
 */
export function resolveFrameModelWorkerEntry(explicit?: string): string | undefined {
	if (explicit && existsSync(explicit)) {
		return explicit;
	}
	const envEntry = typeof process !== 'undefined' ? process.env.FRAME_MODEL_WORKER_ENTRY : undefined;
	if (envEntry && existsSync(envEntry)) {
		return envEntry;
	}

	const cwd = typeof process !== 'undefined' ? process.cwd() : '';
	const candidates = [
		join(cwd, 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'),
		join(cwd, '..', 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'),
	];
	for (const c of candidates) {
		if (existsSync(c)) {
			return c;
		}
	}
	return undefined;
}

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
		// Soft init failures still send ready (modelLoaded: false) — do not treat error as terminal.
		return msg.type === 'ready';
	}
	if (message.type === 'health') {
		return msg.type === 'health' || msg.type === 'error';
	}
	if (message.type === 'cancel') {
		return (msg.type === 'streamEnd' && (msg as { requestId?: string }).requestId === message.requestId)
			|| msg.type === 'error';
	}
	if (message.type === 'toolResult') {
		// toolResult is fire-and-forget (post); never a generate waiter.
		return false;
	}
	return false;
}

/**
 * Spawn an isolated Frame model worker via Node `child_process.fork`.
 */
export async function spawnFrameModelWorkerProcess(options?: {
	readonly entryPath?: string;
	readonly readyTimeoutMs?: number;
}): Promise<{ handle: IFrameWorkerProcessHandle; ready: FrameModelWorkerOutboundMessage }> {
	const entry = resolveFrameModelWorkerEntry(options?.entryPath);
	if (!entry) {
		throw new Error('Frame model worker entry not found (tools/frame-model-worker/frameModelWorkerMain.mjs).');
	}

	const workerId = `frame-worker-${generateUuid().slice(0, 8)}`;
	const readyTimeout = options?.readyTimeoutMs ?? 120_000;

	type Waiter = {
		resolve: (msg: FrameModelWorkerOutboundMessage) => void;
		reject: (err: Error) => void;
		inbound: FrameModelWorkerInboundMessage;
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

	const child = cp.fork(entry, [], {
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		env: {
			...process.env,
			FRAME_MODEL_WORKER: '1',
			FRAME_MODEL_WORKER_ID: workerId,
		},
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

	child.on('message', (raw: unknown) => {
		const msg = raw as FrameModelWorkerOutboundMessage;
		for (const l of messageListeners) {
			l(msg);
		}

		// Stream / tool mid-flight messages are not terminal waiters.
		if (isMidFlightOutboundMessage(msg) || (isStreamOutboundMessage(msg) && msg.type !== 'streamEnd')) {
			return;
		}

		const waiter = queue.find(q => isTerminalFor(q.inbound, msg));
		if (waiter) {
			queue = queue.filter(q => q !== waiter);
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
	});

	child.on('error', (err) => {
		const error = err instanceof Error ? err : new Error(String(err));
		for (const q of queue) {
			q.reject(error);
		}
		queue = [];
		failStartup(error);
	});

	child.on('exit', (code, signal) => {
		alive = false;
		const err = new Error(`Worker process exited (code=${code}, signal=${signal})`);
		for (const q of queue) {
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

	const readyTimer = setTimeout(() => {
		intentionalStop = true;
		try {
			child.kill('SIGKILL');
		} catch {
			// ignore
		}
		failStartup(new Error(`Timed out waiting for worker ready (${readyTimeout}ms)`));
	}, readyTimeout);

	if (bufferedStartup?.type === 'ready') {
		clearTimeout(readyTimer);
		finishStartup(bufferedStartup);
	}

	const ready = await readyPromise.finally(() => clearTimeout(readyTimer));

	if (ready.type !== 'ready') {
		intentionalStop = true;
		try {
			child.kill('SIGKILL');
		} catch {
			// ignore
		}
		throw new Error('Worker process did not signal ready.');
	}

	const handle: IFrameWorkerProcessHandle = {
		get pid() {
			return child.pid ?? null;
		},
		workerId,
		post(message) {
			if (!alive || !child.connected) {
				return;
			}
			try {
				child.send(message as cp.Serializable);
			} catch {
				// ignore
			}
		},
		async send(message) {
			if (!alive || !child.connected) {
				throw new Error('Worker process is not connected.');
			}
			return new Promise<FrameModelWorkerOutboundMessage>((resolve, reject) => {
				queue.push({ resolve, reject, inbound: message });
				try {
					child.send(message as cp.Serializable);
				} catch (err) {
					queue = queue.filter(q => q.resolve !== resolve);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		},
		async terminate(graceMs = 3000) {
			intentionalStop = true;
			if (!alive) {
				return { code: 0, signal: null };
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					try {
						child.kill('SIGTERM');
					} catch {
						// ignore
					}
					setTimeout(() => {
						try {
							if (alive) {
								child.kill('SIGKILL');
							}
						} catch {
							// ignore
						}
					}, 1000);
				}, graceMs);

				child.once('exit', (code, signal) => {
					clearTimeout(timer);
					alive = false;
					resolve({ code, signal });
				});

				if (child.connected) {
					try {
						child.send({ type: 'shutdown' } as cp.Serializable);
					} catch {
						try {
							child.kill('SIGTERM');
						} catch {
							// ignore
						}
					}
				} else {
					try {
						child.kill('SIGTERM');
					} catch {
						// ignore
					}
				}
			});
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
