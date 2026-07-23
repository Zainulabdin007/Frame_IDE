/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IFrameToolLogService = createDecorator<IFrameToolLogService>('frameToolLogService');

export interface IFrameToolLogEntry {
	readonly id: string;
	readonly timestamp: number;
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly durationMs: number;
	readonly success: boolean;
	readonly resultPreview?: string;
	readonly error?: string;
	readonly conversationId?: string | null;
	readonly workerId?: string | null;
	readonly requestId: string;
	readonly callId: string;
}

export interface IFrameToolLogService {
	readonly _serviceBrand: undefined;

	logToolInvocation(entry: Omit<IFrameToolLogEntry, 'id' | 'timestamp'> & {
		readonly id?: string;
		readonly timestamp?: number;
	}): Promise<IFrameToolLogEntry>;
}
