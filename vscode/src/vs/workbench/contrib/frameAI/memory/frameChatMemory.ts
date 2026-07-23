/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IFrameChatMemoryService = createDecorator<IFrameChatMemoryService>('frameChatMemoryService');

export interface IFrameChatTurnRecord {
	readonly timestamp: number;
	readonly prompt: string;
	readonly response: string;
	readonly modelId: string | null;
	readonly modelDisplayName?: string;
	readonly adapters: readonly string[];
	readonly workspaceId: string | null;
	readonly taskId?: string;
	readonly runtimeId?: string;
	readonly workerId?: string | null;
	readonly status?: string;
}

export interface IFrameChatConversationFile {
	readonly id: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly workspaceId: string | null;
	readonly turns: readonly IFrameChatTurnRecord[];
}

export interface IFrameChatMemoryService {
	readonly _serviceBrand: undefined;

	/** Active conversation id (created lazily). */
	getActiveConversationId(): string | null;

	startConversation(): Promise<string>;

	clearConversation(): Promise<void>;

	appendTurn(turn: Omit<IFrameChatTurnRecord, 'timestamp'> & { readonly timestamp?: number }): Promise<IFrameChatConversationFile>;
}
