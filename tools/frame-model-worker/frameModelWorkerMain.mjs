/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone Frame Model Worker process entry (Node child_process).
 * Streaming stub with simulated tool calling — no weights, no inference.
 *
 *   node tools/frame-model-worker/frameModelWorkerMain.mjs
 */

const FRAME_MODEL_RUNTIME_NOT_CONNECTED = 'MODEL_RUNTIME_NOT_CONNECTED';

/** @type {Map<string, { cancelled: boolean }>} */
const active = new Map();
/** @type {Map<string, (msg: any) => void>} */
const pendingToolResults = new Map();
let initializedModelId = null;
let initializedModelPath = null;
let shuttingDown = false;
let messagesReceived = 0;
let messagesSent = 0;
let toolCallCounter = 0;

function isInbound(msg) {
	if (!msg || typeof msg !== 'object') {
		return false;
	}
	return msg.type === 'initialize'
		|| msg.type === 'generate'
		|| msg.type === 'cancel'
		|| msg.type === 'health'
		|| msg.type === 'shutdown'
		|| msg.type === 'toolResult';
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
 * @param {string} requestId
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {{ cancelled: boolean }} slot
 */
async function requestTool(requestId, tool, args, slot) {
	if (slot.cancelled || shuttingDown) {
		return { success: false, error: 'cancelled', callId: '' };
	}
	toolCallCounter += 1;
	const callId = `stub-call-${toolCallCounter}`;
	const resultPromise = new Promise(resolve => {
		pendingToolResults.set(callId, resolve);
	});
	send({ type: 'toolRequest', requestId, callId, tool, args });
	const timeout = setTimeout(() => {
		const fn = pendingToolResults.get(callId);
		if (fn) {
			pendingToolResults.delete(callId);
			fn({ type: 'toolResult', requestId, callId, success: false, error: 'tool timeout' });
		}
	}, 15_000);

	const result = await resultPromise;
	clearTimeout(timeout);
	return result;
}

/**
 * @param {any} message
 */
async function handle(message) {
	messagesReceived++;
	switch (message.type) {
		case 'initialize': {
			initializedModelId = typeof message.modelId === 'string' ? message.modelId : null;
			initializedModelPath = message.modelPath ?? null;
			send({ type: 'ready' });
			return;
		}
		case 'health': {
			send({
				type: 'health',
				requestId: message.requestId,
				ok: true,
				pid: process.pid,
				pending: active.size,
			});
			return;
		}
		case 'toolResult': {
			const callId = typeof message.callId === 'string' ? message.callId : '';
			const resolve = pendingToolResults.get(callId);
			if (resolve) {
				pendingToolResults.delete(callId);
				resolve(message);
			}
			return;
		}
		case 'cancel': {
			const slot = active.get(message.requestId);
			if (slot) {
				slot.cancelled = true;
			}
			for (const [callId, resolve] of pendingToolResults) {
				pendingToolResults.delete(callId);
				resolve({
					type: 'toolResult',
					requestId: message.requestId,
					callId,
					success: false,
					error: 'cancelled',
				});
			}
			send({
				type: 'streamEnd',
				requestId: message.requestId,
				text: '',
				status: 'cancelled',
				cancelled: true,
			});
			return;
		}
		case 'generate': {
			const requestId = typeof message.requestId === 'string' ? message.requestId : '';
			const slot = { cancelled: false };
			active.set(requestId, slot);
			send({ type: 'streamStart', requestId });

			const context = message.context && typeof message.context === 'object' ? message.context : {};
			const activePath = typeof context.activeRelativePath === 'string' && context.activeRelativePath
				? context.activeRelativePath
				: 'README.md';
			const prompt = typeof context.request === 'string' ? context.request : '';

			const parts = [];
			const pushToken = async (token) => {
				if (slot.cancelled || shuttingDown) {
					return;
				}
				parts.push(token);
				send({ type: 'streamToken', requestId, token });
				await delay(20);
			};

			await pushToken('Stub tool loop: ');

			const readResult = await requestTool(requestId, 'readFile', { path: activePath, maxBytes: 4000 }, slot);
			await pushToken(readResult && readResult.success
				? `readFile(${activePath}) ok. `
				: `readFile(${activePath}) failed. `);

			const searchQuery = (prompt.trim().split(/\s+/).find(w => w.length > 3) || 'frame').slice(0, 40);
			const searchResult = await requestTool(requestId, 'searchWorkspace', { query: searchQuery, limit: 10 }, slot);
			const matchCount = searchResult && searchResult.success && searchResult.data && Array.isArray(searchResult.data.matches)
				? searchResult.data.matches.length
				: 0;
			await pushToken(`searchWorkspace("${searchQuery}") → ${matchCount} file(s). `);

			await pushToken(`(MODEL_RUNTIME_NOT_CONNECTED — no inference).`);

			const text = parts.join('');
			const cancelled = slot.cancelled;
			active.delete(requestId);
			send({
				type: 'streamEnd',
				requestId,
				text,
				status: cancelled ? 'cancelled' : FRAME_MODEL_RUNTIME_NOT_CONNECTED,
				cancelled,
			});
			if (!cancelled) {
				send({
					type: 'response',
					requestId,
					text: text || [
						'[Frame Model Worker Process]',
						`pid: ${process.pid}`,
						`status: ${FRAME_MODEL_RUNTIME_NOT_CONNECTED}`,
						`modelId: ${initializedModelId ?? '(none)'}`,
						`modelPath: ${initializedModelPath ?? '(none)'}`,
						'tools: readFile → searchWorkspace → final',
					].join('\n'),
					status: FRAME_MODEL_RUNTIME_NOT_CONNECTED,
				});
			}
			return;
		}
		case 'shutdown': {
			shuttingDown = true;
			for (const slot of active.values()) {
				slot.cancelled = true;
			}
			active.clear();
			for (const [callId, resolve] of pendingToolResults) {
				pendingToolResults.delete(callId);
				resolve({ type: 'toolResult', callId, success: false, error: 'shutdown' });
			}
			send({ type: 'ready' });
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
	void handle(raw).catch(err => {
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

send({ type: 'ready', pid: process.pid, worker: 'frame-model-worker' });

if (typeof process.send !== 'function') {
	process.stderr.write('[frame-model-worker] started without IPC parent — exiting after ready\n');
	process.exit(0);
}
