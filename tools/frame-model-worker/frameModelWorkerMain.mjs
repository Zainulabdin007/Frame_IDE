/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone Frame Model Worker process entry (Node child_process).
 * Loads GGUF via node-llama-cpp and streams tokens over existing IPC protocol.
 *
 *   node tools/frame-model-worker/frameModelWorkerMain.mjs
 */

import { existsSync } from 'node:fs';
import { collectAdapterWeightEntries, loadModel, unloadModel } from './frameModelLoader.mjs';
import { runInference } from './frameInferenceEngine.mjs';
import { FRAME_WORKER_TOOLS } from './frameContextMapper.mjs';

const FRAME_MODEL_RUNTIME_NOT_CONNECTED = 'MODEL_RUNTIME_NOT_CONNECTED';
/** Soft cap on inbound IPC JSON (bytes as UTF-16 code units ≈ length). */
const MAX_IPC_CHARS = 2_000_000;
const MAX_CONTEXT_CHARS = 500_000;

/** @type {Map<string, { cancelled: boolean }>} */
const active = new Map();
/** @type {Map<string, { requestId: string, resolve: (msg: any) => void }>} */
const pendingToolResults = new Map();
let toolCallCounter = 0;

/** @type {{
 *   loaded: boolean,
 *   model: any,
 *   context: any,
 *   session: any,
 *   llama?: any,
 *   modelPath: string | null,
 *   metalEnabled?: boolean,
 *   gpuLayers?: number,
 * } | null} */
let runtimeState = {
	loaded: false,
	model: null,
	context: null,
	session: null,
	modelPath: null,
};

let initializedModelId = null;
let initializedModelPath = null;
let initializedAdapterKey = '';
let shuttingDown = false;
let messagesReceived = 0;
let messagesSent = 0;

/** Serialize initialize / generate / shutdown so they never share one llama session. */
let chain = Promise.resolve();

function isInbound(msg) {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
		return false;
	}
	return msg.type === 'initialize'
		|| msg.type === 'generate'
		|| msg.type === 'cancel'
		|| msg.type === 'health'
		|| msg.type === 'shutdown'
		|| msg.type === 'toolResult';
}

/**
 * @param {any} msg
 * @returns {string | null} error message or null if ok
 */
function validateInbound(msg) {
	try {
		const size = JSON.stringify(msg).length;
		if (size > MAX_IPC_CHARS) {
			return `IPC message too large (${size} > ${MAX_IPC_CHARS}).`;
		}
	} catch {
		return 'IPC message is not JSON-serializable.';
	}
	if (msg.type === 'generate') {
		if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
			return 'generate requires string requestId.';
		}
		if (msg.context !== undefined && msg.context !== null) {
			if (typeof msg.context !== 'object' || Array.isArray(msg.context)) {
				return 'generate.context must be an object.';
			}
			try {
				if (JSON.stringify(msg.context).length > MAX_CONTEXT_CHARS) {
					return `generate.context too large (> ${MAX_CONTEXT_CHARS}).`;
				}
			} catch {
				return 'generate.context is not JSON-serializable.';
			}
		}
	}
	if (msg.type === 'initialize') {
		if (msg.modelPath !== undefined && msg.modelPath !== null && typeof msg.modelPath !== 'string') {
			return 'initialize.modelPath must be a string or null.';
		}
		if (msg.adapters !== undefined && msg.adapters !== null && (typeof msg.adapters !== 'object' || Array.isArray(msg.adapters))) {
			return 'initialize.adapters must be an object.';
		}
	}
	if (msg.type === 'toolResult') {
		if (typeof msg.callId !== 'string' || !msg.callId.trim()) {
			return 'toolResult requires string callId.';
		}
	}
	if (msg.type === 'cancel' && msg.requestId !== undefined && typeof msg.requestId !== 'string') {
		return 'cancel.requestId must be a string.';
	}
	return null;
}

function send(msg) {
	messagesSent++;
	if (typeof process.send === 'function') {
		process.send(msg);
	} else {
		process.stdout.write(JSON.stringify(msg) + '\n');
	}
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Emit toolRequest and wait for matching toolResult (existing IPC shape).
 * @param {string} requestId
 * @param {string} tool
 * @param {Readonly<Record<string, unknown>>} args
 * @param {{ cancelled: boolean }} slot
 * @returns {Promise<{ success: boolean, data?: unknown, error?: string }>}
 */
async function requestTool(requestId, tool, args, slot) {
	if (slot.cancelled || shuttingDown) {
		return { success: false, error: 'cancelled' };
	}
	toolCallCounter++;
	const callId = `call-${toolCallCounter}`;
	const resultPromise = new Promise(resolve => {
		pendingToolResults.set(callId, { requestId, resolve });
	});
	send({
		type: 'toolRequest',
		requestId,
		callId,
		tool,
		args: args ?? {},
	});
	const toolTimeoutMs = Number(process.env.FRAME_TOOL_TIMEOUT_MS) || 45_000;
	const msg = await Promise.race([
		resultPromise,
		delay(toolTimeoutMs).then(() => {
			if (pendingToolResults.has(callId)) {
				pendingToolResults.delete(callId);
				return { success: false, error: `tool timeout after ${toolTimeoutMs}ms` };
			}
			return undefined;
		}),
	]);
	if (!msg) {
		return { success: false, error: 'tool cancelled' };
	}
	return {
		success: !!msg?.success,
		data: msg?.data,
		error: typeof msg?.error === 'string' ? msg.error : undefined,
	};
}

/**
 * @param {any} message
 */
async function handleInitialize(message) {
	const nextId = typeof message.modelId === 'string' ? message.modelId : null;
	const nextPath = message.modelPath ?? null;
	const adapterEntries = collectAdapterWeightEntries(message.adapters);
	const nextAdapterKey = adapterEntries.map(a => a.path).sort().join('|');

	// Skip reload when the same model + adapter set is already loaded.
	if (
		runtimeState?.loaded
		&& runtimeState.modelPath
		&& nextPath
		&& runtimeState.modelPath === nextPath
		&& initializedModelId === nextId
		&& initializedAdapterKey === nextAdapterKey
	) {
		initializedModelId = nextId;
		initializedModelPath = nextPath;
		initializedAdapterKey = nextAdapterKey;
		send({
			type: 'ready',
			modelLoaded: true,
			modelPath: runtimeState.modelPath,
			metalEnabled: runtimeState.metalEnabled ?? false,
			gpuLayers: runtimeState.gpuLayers ?? 0,
		});
		return;
	}

	initializedModelId = nextId;
	initializedModelPath = nextPath;
	initializedAdapterKey = nextAdapterKey;

	if (runtimeState?.loaded) {
		try {
			await unloadModel(runtimeState);
		} catch (err) {
			console.warn('[Frame Worker] unload before reload failed:', err instanceof Error ? err.message : String(err));
		}
		runtimeState = {
			loaded: false,
			model: null,
			context: null,
			sequence: null,
			session: null,
			modelPath: null,
		};
	}

	const modelPath = typeof initializedModelPath === 'string' ? initializedModelPath : null;
	if (!modelPath || !existsSync(modelPath)) {
		console.log('[Frame Worker] No usable modelPath — MODEL_RUNTIME_NOT_CONNECTED');
		send({ type: 'ready', modelLoaded: false, modelPath: null });
		return;
	}

	try {
		const loaded = await loadModel(modelPath, adapterEntries);
		runtimeState = {
			loaded: true,
			model: loaded.model,
			context: loaded.context,
			sequence: loaded.sequence,
			session: loaded.session,
			llama: loaded.llama,
			modelPath: loaded.modelPath,
			metalEnabled: loaded.metalEnabled,
			gpuLayers: loaded.gpuLayers,
		};
		console.log(`[Frame Worker] Model loaded: ${modelPath}`);
		send({
			type: 'ready',
			modelLoaded: true,
			modelPath: loaded.modelPath,
			metalEnabled: loaded.metalEnabled,
			gpuLayers: loaded.gpuLayers,
		});
	} catch (err) {
		const messageText = err instanceof Error ? err.message : String(err);
		console.error('[Frame Worker] initialize failed:', messageText);
		runtimeState = {
			loaded: false,
			model: null,
			context: null,
			sequence: null,
			session: null,
			modelPath: null,
		};
		// Soft failure: ready with modelLoaded=false so IDE falls back to stub stream
		// without treating initialize as a fatal session error.
		send({
			type: 'ready',
			modelLoaded: false,
			modelPath: null,
			initError: messageText,
		});
	}
}

/**
 * @param {any} message
 */
async function handleGenerate(message) {
	const requestId = typeof message.requestId === 'string' ? message.requestId : '';
	const slot = { cancelled: false };
	active.set(requestId, slot);
	send({ type: 'streamStart', requestId });

	try {
		if (!runtimeState?.loaded || !runtimeState.context || !runtimeState.sequence) {
			await emitNotConnected(requestId, slot, message);
			return;
		}

		const result = await runInference(runtimeState, message.context, {
			onToken: (token) => {
				if (!slot.cancelled && !shuttingDown) {
					send({ type: 'streamToken', requestId, token });
				}
			},
			isCancelled: () => slot.cancelled || shuttingDown,
			timeoutMs: Number(process.env.FRAME_GENERATE_TIMEOUT_MS) || 180_000,
			// Full modify/create plans can exceed 1k tokens. Concise append/prepend
			// ops remain preferred, but the safety fallback must not cut JSON mid-plan.
			maxTokens: Number(process.env.FRAME_GENERATE_MAX_TOKENS) || 4096,
			enableTools: message.enableTools !== false && process.env.FRAME_ENABLE_TOOLS !== '0',
			tools: FRAME_WORKER_TOOLS,
			maxToolRounds: Math.min(Number(process.env.FRAME_MAX_TOOL_ROUNDS) || 4, 8),
			requestTool: (tool, args) => requestTool(requestId, tool, args, slot),
		});

		active.delete(requestId);
		if (slot.cancelled || shuttingDown) {
			send({
				type: 'streamEnd',
				requestId,
				text: result.text || '',
				status: 'cancelled',
				cancelled: true,
			});
			return;
		}
		send({
			type: 'streamEnd',
			requestId,
			text: result.text,
			status: result.status,
			cancelled: false,
		});
		send({
			type: 'response',
			requestId,
			text: result.text,
			status: result.status,
		});
	} catch (err) {
		active.delete(requestId);
		const errorMessage = err instanceof Error ? err.message : String(err);
		console.error('[Frame Worker] generate failed:', errorMessage);
		send({
			type: 'streamEnd',
			requestId,
			text: '',
			status: slot.cancelled ? 'cancelled' : 'error',
			cancelled: slot.cancelled,
			error: slot.cancelled ? undefined : errorMessage,
		});
	}
}

/**
 * Existing stub path when no GGUF is loaded.
 * Do not stream fake "success" tokens — return a clear not-connected failure.
 * @param {string} requestId
 * @param {{ cancelled: boolean }} slot
 * @param {any} _message
 */
async function emitNotConnected(requestId, slot, _message) {
	const cancelled = slot.cancelled;
	active.delete(requestId);
	const error = 'MODEL_RUNTIME_NOT_CONNECTED — set modelPath in .frame/config/runtime.json';
	send({
		type: 'streamEnd',
		requestId,
		text: '',
		status: cancelled ? 'cancelled' : FRAME_MODEL_RUNTIME_NOT_CONNECTED,
		cancelled,
		error: cancelled ? undefined : error,
	});
	if (!cancelled) {
		send({
			type: 'response',
			requestId,
			text: '',
			status: FRAME_MODEL_RUNTIME_NOT_CONNECTED,
			error,
		});
	}
}

/**
 * @param {any} message
 */
async function handle(message) {
	messagesReceived++;
	switch (message.type) {
		case 'initialize':
			await handleInitialize(message);
			return;
		case 'health': {
			send({
				type: 'health',
				requestId: message.requestId,
				ok: true,
				pid: process.pid,
				pending: active.size,
				modelLoaded: !!runtimeState?.loaded,
				modelPath: runtimeState?.modelPath ?? null,
				metalEnabled: runtimeState?.metalEnabled ?? false,
			});
			return;
		}
		case 'toolResult': {
			const callId = typeof message.callId === 'string' ? message.callId : '';
			const entry = pendingToolResults.get(callId);
			if (entry) {
				pendingToolResults.delete(callId);
				entry.resolve(message);
			}
			return;
		}
		case 'cancel': {
			// Only mark cancelled — in-flight handleGenerate emits the sole streamEnd.
			const slot = active.get(message.requestId);
			if (slot) {
				slot.cancelled = true;
			}
			for (const [callId, entry] of pendingToolResults) {
				if (entry.requestId !== message.requestId) {
					continue;
				}
				pendingToolResults.delete(callId);
				entry.resolve({
					type: 'toolResult',
					requestId: message.requestId,
					callId,
					success: false,
					error: 'cancelled',
				});
			}
			// If nothing is active, acknowledge cancel so IDE waiters do not hang.
			if (!slot) {
				send({
					type: 'streamEnd',
					requestId: message.requestId,
					text: '',
					status: 'cancelled',
					cancelled: true,
				});
			}
			return;
		}
		case 'generate':
			await handleGenerate(message);
			return;
		case 'shutdown': {
			shuttingDown = true;
			for (const slot of active.values()) {
				slot.cancelled = true;
			}
			active.clear();
			for (const [callId, entry] of pendingToolResults) {
				pendingToolResults.delete(callId);
				entry.resolve({ type: 'toolResult', callId, success: false, error: 'shutdown' });
			}
			await unloadModel(runtimeState);
			runtimeState = {
				loaded: false,
				model: null,
				context: null,
				session: null,
				modelPath: null,
			};
			send({ type: 'ready', modelLoaded: false });
			setImmediate(() => process.exit(0));
			return;
		}
		default:
			send({ type: 'error', message: `Unknown message type: ${String(message.type)}` });
	}
}

function onMessage(raw) {
	if (!isInbound(raw)) {
		send({ type: 'error', message: 'Invalid worker protocol message.' });
		return;
	}
	const validationError = validateInbound(raw);
	if (validationError) {
		send({
			type: 'error',
			message: validationError,
			requestId: raw && typeof raw === 'object' ? raw.requestId : undefined,
		});
		return;
	}
	// cancel / toolResult / health can run concurrently; serialize the rest.
	if (raw.type === 'cancel' || raw.type === 'toolResult' || raw.type === 'health') {
		void handle(raw).catch(err => {
			send({
				type: 'error',
				message: err instanceof Error ? err.message : String(err),
				requestId: raw && typeof raw === 'object' ? raw.requestId : undefined,
			});
		});
		return;
	}
	chain = chain.then(() => handle(raw)).catch(err => {
		send({
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
			requestId: raw && typeof raw === 'object' ? raw.requestId : undefined,
		});
	});
}

process.on('message', onMessage);
process.on('disconnect', () => {
	if (!shuttingDown) {
		process.exit(0);
	}
});

send({ type: 'ready', pid: process.pid, worker: 'frame-model-worker', modelLoaded: false });

if (typeof process.send !== 'function') {
	process.stderr.write('[frame-model-worker] started without IPC parent — exiting after ready\n');
	process.exit(0);
}
