/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IFrameModelWorkerProcessSpawner,
	IFrameModelWorkerSpawnResult,
} from '../runtime/worker/frameModelWorkerProcessSpawner.js';
import { FrameModelWorkerHostClient } from './frameModelWorkerHostClient.js';

class MainProcessFrameModelWorkerProcessSpawner implements IFrameModelWorkerProcessSpawner {
	declare readonly _serviceBrand: undefined;

	private _client: FrameModelWorkerHostClient | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async trySpawn(options?: { readonly entryPath?: string; readonly readyTimeoutMs?: number }): Promise<IFrameModelWorkerSpawnResult | undefined> {
		if (!this._client) {
			this._client = this.instantiationService.createInstance(FrameModelWorkerHostClient);
		}
		return this._client.spawnFrameModelWorkerProcess(options);
	}
}

registerSingleton(IFrameModelWorkerProcessSpawner, MainProcessFrameModelWorkerProcessSpawner, InstantiationType.Delayed);
