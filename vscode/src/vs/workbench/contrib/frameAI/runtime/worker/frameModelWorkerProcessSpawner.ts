/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { FrameModelWorkerOutboundMessage } from './frameModelWorkerProtocol.js';
import type { IFrameWorkerProcessHandle } from './frameModelWorkerProcessHost.js';

export const IFrameModelWorkerProcessSpawner = createDecorator<IFrameModelWorkerProcessSpawner>('frameModelWorkerProcessSpawner');

export interface IFrameModelWorkerSpawnResult {
	readonly handle: IFrameWorkerProcessHandle;
	readonly ready: FrameModelWorkerOutboundMessage;
}

/**
 * Platform-specific spawner for the Frame model worker child process.
 * Browser/null: returns undefined (manager falls back).
 * Electron: forks via main-process host (renderer cannot use child_process).
 */
export interface IFrameModelWorkerProcessSpawner {
	readonly _serviceBrand: undefined;
	trySpawn(options?: { readonly entryPath?: string; readonly readyTimeoutMs?: number }): Promise<IFrameModelWorkerSpawnResult | undefined>;
}

export class NullFrameModelWorkerProcessSpawner implements IFrameModelWorkerProcessSpawner {
	declare readonly _serviceBrand: undefined;
	async trySpawn(): Promise<IFrameModelWorkerSpawnResult | undefined> {
		return undefined;
	}
}
