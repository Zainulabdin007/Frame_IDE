/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IFrameBackgroundIntelligence = createDecorator<IFrameBackgroundIntelligence>('frameBackgroundIntelligence');

export interface IFrameBackgroundIntelligenceStatus {
	readonly running: boolean;
	readonly lastRunAt: number | null;
	readonly lastAction?: string;
}

/**
 * Idle-time local maintenance: knowledge index, stale RAG reindex, preference candidates.
 * Never calls cloud APIs.
 */
export interface IFrameBackgroundIntelligence {
	readonly _serviceBrand: undefined;

	getStatus(): IFrameBackgroundIntelligenceStatus;

	/** Kick an idle pass immediately (still local-only). */
	runIdlePass(): Promise<void>;
}
