/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Smoke test for Frame model worker + optional llama.cpp inference.
 *
 * Protocol-only (always):
 *   node tools/frame-model-worker/smoke-test.mjs
 *
 * Real inference (requires a local GGUF):
 *   FRAME_MODEL_PATH=/abs/path/to/model.gguf node tools/frame-model-worker/smoke-test.mjs
 */

import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'frameModelWorkerMain.mjs');
const modelPath = process.env.FRAME_MODEL_PATH || null;
const runInference = !!(modelPath && existsSync(modelPath));

function onceMessage(child, predicate, timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timeout waiting for worker message (${timeoutMs}ms)`));
		}, timeoutMs);

		function onMessage(msg) {
			if (predicate(msg)) {
				cleanup();
				resolve(msg);
			}
		}
		function onExit(code, signal) {
			cleanup();
			reject(new Error(`Worker exited early code=${code} signal=${signal}`));
		}
		function cleanup() {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('exit', onExit);
		}
		child.on('message', onMessage);
		child.on('exit', onExit);
	});
}

function onceExit(child, timeoutMs = 15_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('Timeout waiting for worker exit'));
		}, timeoutMs);
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

async function main() {
	if (!runInference) {
		console.log('SKIP: Set FRAME_MODEL_PATH to run inference smoke test');
		if (modelPath && !existsSync(modelPath)) {
			console.log(`[smoke] FRAME_MODEL_PATH does not exist: ${modelPath}`);
		}
		// Still exercise protocol without loading weights.
		await runProtocolSmoke(null);
		return;
	}

	console.log('[smoke] inference mode model=', modelPath);
	await runProtocolSmoke(modelPath);
}

/**
 * @param {string | null} path
 */
async function runProtocolSmoke(path) {
	console.log('[smoke] forking', entry);
	const child = fork(entry, [], {
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		env: { ...process.env, FRAME_MODEL_WORKER: '1' },
	});

	child.stderr?.on('data', chunk => process.stderr.write(chunk));

	await onceMessage(child, m => m && m.type === 'ready');
	console.log('[smoke] worker online pid=', child.pid);

	const initTimeout = path ? 120_000 : 8_000;
	child.send({
		type: 'initialize',
		modelId: path ? 'smoke-gguf' : 'smoke-model',
		modelPath: path,
		adapters: { baseModel: 'smoke-model', languageAdapters: [], projectAdapters: [], userAdapters: [] },
	});
	await onceMessage(child, m => m && m.type === 'ready', initTimeout);
	console.log('[smoke] initialize → ready');

	const requestId = 'smoke-req-1';
	const tokens = [];
	const endTimeout = path ? 180_000 : 15_000;
	const streamDone = onceMessage(
		child,
		m => m && m.type === 'streamEnd' && m.requestId === requestId,
		endTimeout,
	);
	child.on('message', msg => {
		if (msg && msg.type === 'streamToken' && msg.requestId === requestId) {
			tokens.push(msg.token);
			process.stdout.write(msg.token);
		}
		if (msg && msg.type === 'error') {
			console.error('\n[smoke] worker error:', msg.message);
		}
	});

	const prompt = path
		? 'Write a hello world function in Python'
		: 'hello';

	child.send({
		type: 'generate',
		requestId,
		context: {
			taskId: 'smoke-task',
			request: prompt,
			relatedFiles: [],
			relatedChunks: [],
			documentationChunks: [],
			memories: [],
			preferences: [],
			adapters: { available: [], active: [] },
			openFiles: [],
			workspace: { name: 'smoke' },
			systemPrompt: 'You are Frame, a concise coding assistant.',
			messages: [],
			builtAt: Date.now(),
			memory: [],
			rag: [],
			activeAdapters: [],
		},
	});

	const end = await streamDone;
	console.log('\n[smoke] streamEnd status=', end.status, 'tokens=', tokens.length);

	if (path) {
		if (!tokens.length) {
			throw new Error('Expected streamed tokens from real inference');
		}
		if (end.status === 'MODEL_RUNTIME_NOT_CONNECTED') {
			throw new Error('Expected real inference status, got MODEL_RUNTIME_NOT_CONNECTED');
		}
		if (end.status === 'error') {
			throw new Error('Inference ended with error status');
		}
		console.log('[smoke] full response length=', (end.text || tokens.join('')).length);
	} else {
		// Protocol stub: worker may emit zero tokens and only a terminal status.
		if (end.status !== 'MODEL_RUNTIME_NOT_CONNECTED') {
			throw new Error(`Unexpected status without model: ${end.status}`);
		}
		console.log('[smoke] protocol stub OK (zero tokens allowed when MODEL_RUNTIME_NOT_CONNECTED)');
	}

	// Protocol: toolResult with no waiter must not crash the worker.
	child.send({
		type: 'toolResult',
		requestId,
		callId: 'smoke-orphan-tool',
		success: true,
		result: { ok: true },
	});
	await delay(50);
	console.log('[smoke] toolResult (orphan) accepted without crash');

	const adapterPath = process.env.FRAME_ADAPTER_PATH || null;
	if (path && adapterPath && existsSync(adapterPath)) {
		console.log('[smoke] re-init with adapterPaths=', adapterPath);
		child.send({
			type: 'initialize',
			modelId: 'smoke-gguf-lora',
			modelPath: path,
			adapters: {
				baseModel: 'smoke-model',
				languageAdapters: [],
				projectAdapters: [],
				userAdapters: [],
				adapterPaths: [{ id: 'smoke-lora', scope: 'user', path: adapterPath }],
			},
		});
		await onceMessage(child, m => m && m.type === 'ready', 120_000);
		console.log('[smoke] LoRA initialize → ready (worker soft-fails unsupported formats)');
	} else if (path) {
		console.log('SKIP LoRA: Set FRAME_ADAPTER_PATH to a real GGUF LoRA file to exercise adapterPaths');
	}

	child.send({ type: 'shutdown' });
	await onceMessage(child, m => m && m.type === 'ready', 30_000);
	const exit = await onceExit(child);
	if (exit.code !== 0 && exit.code !== null) {
		throw new Error(`Non-zero exit: ${exit.code}`);
	}
	console.log('[smoke] PASS', path ? '— llama.cpp inference ok' : '— protocol stub ok', exit);
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
	console.error('[smoke] FAIL', err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
