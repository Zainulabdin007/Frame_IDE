/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frame tool calling contracts.
 * Tools run in the IDE; the worker only requests them (no inference).
 */

export const FRAME_TOOL_NAMES = [
	'readFile',
	'writeFile',
	'searchWorkspace',
	'grepWorkspace',
	'globFiles',
	'codebaseSearch',
	'readLints',
	'listFiles',
	'renameSymbol',
	'formatDocument',
	'gitStatus',
	'gitDiff',
	'terminalRun',
	'taskRun',
	'findSymbol',
	'findReferences',
	'findDependencies',
	'findCallers',
	'findImplementations',
] as const;

export type FrameToolName = (typeof FRAME_TOOL_NAMES)[number];

export type FrameToolPermission =
	| 'read'
	| 'write'
	| 'search'
	| 'refactor'
	| 'git'
	| 'execute';

export interface IFrameToolCall {
	readonly id: string;
	readonly name: FrameToolName;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly requestId: string;
	readonly conversationId?: string | null;
	readonly workerId?: string | null;
	readonly createdAt: number;
}

export interface IFrameToolResult {
	readonly callId: string;
	readonly name: FrameToolName;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
	readonly durationMs: number;
	readonly requestId: string;
}

export interface IFrameToolContext {
	readonly requestId: string;
	readonly conversationId?: string | null;
	readonly workerId?: string | null;
	readonly signal?: AbortSignal;
}

export interface IFrameTool {
	readonly name: FrameToolName;
	readonly description: string;
	readonly permission: FrameToolPermission;
	/** When false, registry refuses execution (e.g. terminal by default). */
	readonly enabled: boolean;
	execute(args: Readonly<Record<string, unknown>>, context: IFrameToolContext): Promise<{
		readonly data?: unknown;
		readonly error?: string;
	}>;
}

export interface IFrameToolActivityEntry {
	readonly callId: string;
	readonly tool: FrameToolName;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly startedAt: number;
	readonly durationMs?: number;
	readonly success?: boolean;
	readonly error?: string;
	readonly requestId: string;
	readonly conversationId?: string | null;
	readonly workerId?: string | null;
	readonly status: 'running' | 'success' | 'failure';
}

export function isFrameToolName(value: unknown): value is FrameToolName {
	return typeof value === 'string' && (FRAME_TOOL_NAMES as readonly string[]).includes(value);
}
