/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameRagIndexStatus, IFrameRagQuery, IFrameRagResult, IFrameWorkspaceFileInfo } from '../common/models.js';

export const IFrameRagService = createDecorator<IFrameRagService>('frameRagService');

/**
 * Local retrieval-augmented generation over the workspace.
 * Indexes into `.frame/rag/` and ranks with lexical scoring (no embeddings).
 */
export interface IFrameRagService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeIndex: Event<IFrameRagIndexStatus>;

	getStatus(): IFrameRagIndexStatus;

	/**
	 * Scan, chunk, and persist a local index under each workspace folder's `.frame/rag/`.
	 */
	reindex(folders?: readonly URI[]): Promise<IFrameRagIndexStatus>;

	/**
	 * Ranked retrieval over local chunks.
	 * Auto-indexes when no index is present yet.
	 */
	query(query: IFrameRagQuery): Promise<IFrameRagResult>;

	/** Files last indexed for the primary workspace folder (empty if never indexed). */
	getIndexedFiles(): readonly IFrameWorkspaceFileInfo[];
}
