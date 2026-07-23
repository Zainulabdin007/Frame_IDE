/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameConversationSummary,
	IFrameDecisionMemory,
	IFrameMemoryExportBundle,
	IFramePersistentMemoryRecord,
	IFramePersistentMemorySearchQuery,
	IFrameProjectMemory,
	IFrameUserPreference,
	FramePersistentMemoryKind,
} from '../common/models.js';

export const IFramePersistentMemoryService = createDecorator<IFramePersistentMemoryService>('framePersistentMemoryService');

/**
 * Durable local memory under `.frame/memory/`.
 * Survives restarts. No cloud. No database server.
 */
export interface IFramePersistentMemoryService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Load from disk (idempotent). */
	load(folder?: URI): Promise<void>;

	/** Persist current in-memory snapshot to disk. */
	save(folder?: URI): Promise<void>;

	get(id: string): IFramePersistentMemoryRecord | undefined;

	saveProject(partial: Omit<IFrameProjectMemory, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameProjectMemory>;
	savePreference(partial: Omit<IFrameUserPreference, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameUserPreference>;
	saveDecision(partial: Omit<IFrameDecisionMemory, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameDecisionMemory>;
	saveConversationSummary(partial: Omit<IFrameConversationSummary, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameConversationSummary>;

	update(id: string, patch: Partial<IFramePersistentMemoryRecord>): Promise<IFramePersistentMemoryRecord | undefined>;

	search(query: IFramePersistentMemorySearchQuery): Promise<readonly IFramePersistentMemoryRecord[]>;

	delete(id: string): Promise<boolean>;

	list(kind?: FramePersistentMemoryKind): readonly IFramePersistentMemoryRecord[];

	exportMemory(folder?: URI): Promise<IFrameMemoryExportBundle>;
	importMemory(bundle: IFrameMemoryExportBundle, options?: { merge?: boolean; folder?: URI }): Promise<number>;
}
