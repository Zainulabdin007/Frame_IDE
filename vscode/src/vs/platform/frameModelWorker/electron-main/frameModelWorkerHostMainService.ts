/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import {
	IFrameModelWorkerHostMainService,
	IFrameModelWorkerHostSpawnResult,
} from '../common/frameModelWorkerHost.js';

/**
 * Forks the standalone Frame model worker (node-llama-cpp) from the Electron main process.
 */
export class FrameModelWorkerHostMainService extends Disposable implements IFrameModelWorkerHostMainService {

	declare readonly _serviceBrand: undefined;

	private _child: ChildProcess | undefined;
	private _intentionalStop = false;

	private readonly _onDidReceiveMessage = this._register(new Emitter<unknown>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	private readonly _onDidExit = this._register(new Emitter<{ readonly code: number | null; readonly signal: string | null }>());
	readonly onDidExit = this._onDidExit.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
	}

	async spawn(options?: { readonly entryPath?: string }): Promise<IFrameModelWorkerHostSpawnResult> {
		if (this._child && !this._child.killed) {
			await this.terminate(500);
		}

		const entry = this.resolveEntry(options?.entryPath);
		if (!entry) {
			throw new Error('Frame model worker entry not found (tools/frame-model-worker/frameModelWorkerMain.mjs).');
		}

		const workerId = `frame-worker-${generateUuid().slice(0, 8)}`;
		this._intentionalStop = false;

		const child = fork(entry, [], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			env: {
				...process.env,
				FRAME_MODEL_WORKER: '1',
				FRAME_MODEL_WORKER_ID: workerId,
			},
		});
		this._child = child;

		child.on('message', (raw: unknown) => {
			this._onDidReceiveMessage.fire(raw);
		});
		child.on('error', (err) => {
			this.logService.error(`[FrameWorkerHost] child error: ${err instanceof Error ? err.message : String(err)}`);
		});
		child.on('exit', (code, signal) => {
			this._child = undefined;
			if (!this._intentionalStop) {
				this._onDidExit.fire({ code, signal });
			}
		});

		this.logService.info(`[FrameWorkerHost] spawned pid=${child.pid} entry=${entry}`);
		return { pid: child.pid ?? null, workerId, entryPath: entry };
	}

	async post(message: unknown): Promise<void> {
		const child = this._child;
		if (!child || !child.connected) {
			throw new Error('Frame model worker is not connected.');
		}
		child.send(message as any);
	}

	async terminate(graceMs = 3000): Promise<{ readonly code: number | null; readonly signal: string | null }> {
		const child = this._child;
		if (!child) {
			return { code: 0, signal: null };
		}
		this._intentionalStop = true;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				try {
					child.kill('SIGTERM');
				} catch {
					// ignore
				}
				setTimeout(() => {
					try {
						if (this._child === child) {
							child.kill('SIGKILL');
						}
					} catch {
						// ignore
					}
				}, 1000);
			}, graceMs);

			child.once('exit', (code, signal) => {
				clearTimeout(timer);
				this._child = undefined;
				resolve({ code, signal });
			});

			if (child.connected) {
				try {
					child.send({ type: 'shutdown' });
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
	}

	async isRunning(): Promise<boolean> {
		return !!(this._child && !this._child.killed);
	}

	private resolveEntry(explicit?: string): string | undefined {
		if (explicit && existsSync(explicit)) {
			return explicit;
		}
		const envEntry = process.env.FRAME_MODEL_WORKER_ENTRY;
		if (envEntry && existsSync(envEntry)) {
			return envEntry;
		}

		const candidates: string[] = [];
		const appRoot = this.environmentMainService.appRoot;
		if (appRoot) {
			// Dev: appRoot is vscode/; worker lives at ../tools/...
			candidates.push(join(appRoot, '..', 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'));
			candidates.push(join(appRoot, 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'));
		}
		const cwd = process.cwd();
		candidates.push(join(cwd, 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'));
		candidates.push(join(cwd, '..', 'tools', 'frame-model-worker', 'frameModelWorkerMain.mjs'));

		for (const c of candidates) {
			if (existsSync(c)) {
				return c;
			}
		}
		return undefined;
	}
}
