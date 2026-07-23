/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IFrameGenerationLogService = createDecorator<IFrameGenerationLogService>('frameGenerationLogService');

export interface IFrameGenerationLogEntry {
	readonly id: string;
	readonly timestamp: number;
	readonly taskId: string;
	readonly durationMs: number;
	readonly contextSize: number;
	readonly ragDocumentsUsed: number;
	readonly memoryEntriesUsed: number;
	readonly activeAdapters: readonly string[];
	readonly selectedModel: string | null;
	readonly workerId: string | null;
	readonly runtimeBackend: string;
	readonly promptPreview: string;
	readonly responseChars: number;
	readonly status: string;
}

export interface IFrameGenerationLogService {
	readonly _serviceBrand: undefined;

	logGeneration(entry: Omit<IFrameGenerationLogEntry, 'id' | 'timestamp'> & { readonly id?: string; readonly timestamp?: number }): Promise<IFrameGenerationLogEntry>;
}
