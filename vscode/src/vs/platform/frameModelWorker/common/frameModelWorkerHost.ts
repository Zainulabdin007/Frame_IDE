/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const FRAME_MODEL_WORKER_HOST_CHANNEL = 'frameModelWorkerHost';

export const IFrameModelWorkerHostMainService = createDecorator<IFrameModelWorkerHostMainService>('frameModelWorkerHostMainService');

export interface IFrameModelWorkerHostSpawnResult {
	readonly pid: number | null;
	readonly workerId: string;
	readonly entryPath: string;
}

/**
 * Main-process host that forks `tools/frame-model-worker` and relays IPC.
 * Renderer cannot call child_process in the Electron sandbox.
 */
export interface IFrameModelWorkerHostMainService {
	readonly _serviceBrand: undefined;

	readonly onDidReceiveMessage: Event<unknown>;
	readonly onDidExit: Event<{ readonly code: number | null; readonly signal: string | null }>;

	spawn(options?: { readonly entryPath?: string }): Promise<IFrameModelWorkerHostSpawnResult>;
	post(message: unknown): Promise<void>;
	terminate(graceMs?: number): Promise<{ readonly code: number | null; readonly signal: string | null }>;
	isRunning(): Promise<boolean>;
}
