/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IFrameInferenceContext } from '../../common/models.js';
import { IFrameRuntimeAdapters } from '../frameAdapterRuntime.js';

/**
 * Frame Model Worker Protocol (streaming + tool calling).
 *
 * IDE ↔ isolated worker. No inference / weight load in this milestone.
 */

// ---- IDE → Worker -----------------------------------------------------------

export type FrameModelWorkerInboundMessage =
	| IFrameModelWorkerInitializeMessage
	| IFrameModelWorkerGenerateMessage
	| IFrameModelWorkerCancelMessage
	| IFrameModelWorkerHealthMessage
	| IFrameModelWorkerShutdownMessage
	| IFrameModelWorkerToolResultMessage;

export interface IFrameModelWorkerInitializeMessage {
	readonly type: 'initialize';
	readonly modelId: string;
	readonly modelPath: string | null;
	readonly adapters: IFrameRuntimeAdapters | readonly string[];
}

export interface IFrameModelWorkerGenerateMessage {
	readonly type: 'generate';
	readonly requestId: string;
	readonly context: IFrameInferenceContext;
}

export interface IFrameModelWorkerCancelMessage {
	readonly type: 'cancel';
	readonly requestId: string;
}

export interface IFrameModelWorkerHealthMessage {
	readonly type: 'health';
	readonly requestId?: string;
}

export interface IFrameModelWorkerShutdownMessage {
	readonly type: 'shutdown';
}

/** IDE → Worker: result of a toolRequest round-trip. */
export interface IFrameModelWorkerToolResultMessage {
	readonly type: 'toolResult';
	readonly requestId: string;
	readonly callId: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

// ---- Worker → IDE -----------------------------------------------------------

export type FrameModelWorkerOutboundMessage =
	| IFrameModelWorkerReadyMessage
	| IFrameModelWorkerResponseMessage
	| IFrameModelWorkerStreamStartMessage
	| IFrameModelWorkerStreamTokenMessage
	| IFrameModelWorkerStreamEndMessage
	| IFrameModelWorkerToolRequestMessage
	| IFrameModelWorkerHealthResponseMessage
	| IFrameModelWorkerErrorMessage;

export interface IFrameModelWorkerReadyMessage {
	readonly type: 'ready';
	readonly pid?: number;
	readonly worker?: string;
	readonly modelLoaded?: boolean;
	readonly modelPath?: string | null;
	readonly metalEnabled?: boolean;
	readonly gpuLayers?: number;
	readonly initError?: string;
}

export interface IFrameModelWorkerResponseMessage {
	readonly type: 'response';
	readonly requestId: string;
	readonly text: string;
	readonly status: string;
	readonly error?: string;
}

export interface IFrameModelWorkerStreamStartMessage {
	readonly type: 'streamStart';
	readonly requestId: string;
}

export interface IFrameModelWorkerStreamTokenMessage {
	readonly type: 'streamToken';
	readonly requestId: string;
	readonly token: string;
}

export interface IFrameModelWorkerStreamEndMessage {
	readonly type: 'streamEnd';
	readonly requestId: string;
	readonly text: string;
	readonly status: string;
	readonly cancelled?: boolean;
	readonly error?: string;
}

/** Worker → IDE: request IDE to run a tool (mid-generation). */
export interface IFrameModelWorkerToolRequestMessage {
	readonly type: 'toolRequest';
	readonly requestId: string;
	readonly callId: string;
	readonly tool: string;
	readonly args?: Readonly<Record<string, unknown>>;
}

export interface IFrameModelWorkerHealthResponseMessage {
	readonly type: 'health';
	readonly requestId?: string;
	readonly ok: true;
	readonly pid?: number;
	readonly pending?: number;
}

export interface IFrameModelWorkerErrorMessage {
	readonly type: 'error';
	readonly message: string;
	readonly requestId?: string;
}

/** Returned when generate is received but no native runtime is connected. */
export const FRAME_MODEL_RUNTIME_NOT_CONNECTED = 'MODEL_RUNTIME_NOT_CONNECTED';

/** Stub stream tokens — message-passing only, not model output. */
export const FRAME_STUB_STREAM_TOKENS: readonly string[] = [
	'This ',
	'is ',
	'a ',
	'stub ',
	'stream ',
	'from ',
	'Frame ',
	'(MODEL_RUNTIME_NOT_CONNECTED).',
];

export function isWorkerInboundMessage(value: unknown): value is FrameModelWorkerInboundMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const type = (value as { type?: unknown }).type;
	return type === 'initialize'
		|| type === 'generate'
		|| type === 'cancel'
		|| type === 'health'
		|| type === 'shutdown'
		|| type === 'toolResult';
}

/** Mid-flight outbound messages that must not resolve the generate waiter. */
export function isStreamOutboundMessage(value: unknown): value is
	IFrameModelWorkerStreamStartMessage
	| IFrameModelWorkerStreamTokenMessage
	| IFrameModelWorkerStreamEndMessage
	| IFrameModelWorkerToolRequestMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const type = (value as { type?: unknown }).type;
	return type === 'streamStart'
		|| type === 'streamToken'
		|| type === 'streamEnd'
		|| type === 'toolRequest';
}

export function isMidFlightOutboundMessage(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const type = (value as { type?: unknown }).type;
	return type === 'streamStart' || type === 'streamToken' || type === 'toolRequest';
}
