/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameMemoryEntry, IFrameMemoryQuery } from '../common/models.js';

export const IFrameMemoryService = createDecorator<IFrameMemoryService>('frameMemoryService');

/**
 * Local memory store for sessions, workspace facts, and user preferences.
 * Durable kinds persist under `.frame/memory/` via {@link IFramePersistentMemoryService}.
 */
export interface IFrameMemoryService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	get(id: string): IFrameMemoryEntry | undefined;
	query(query: IFrameMemoryQuery): Promise<readonly IFrameMemoryEntry[]>;
	upsert(entry: Omit<IFrameMemoryEntry, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): Promise<IFrameMemoryEntry>;
	delete(id: string): Promise<boolean>;
	clear(scope?: IFrameMemoryQuery): Promise<number>;
}
