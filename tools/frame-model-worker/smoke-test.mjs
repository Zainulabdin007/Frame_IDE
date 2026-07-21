/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Smoke test: streaming worker lifecycle.
 *
 * Start → initialize → generate (stream tokens) → streamEnd → shutdown → exit.
 *
 *   node tools/frame-model-worker/smoke-test.mjs
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'frameModelWorkerMain.mjs');

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

function onceExit(child, timeoutMs = 5000) {
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
	console.log('[smoke] forking', entry);
	const child = fork(entry, [], {
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		env: { ...process.env, FRAME_MODEL_WORKER: '1' },
	});

	await onceMessage(child, m => m && m.type === 'ready');
	console.log('[smoke] worker online pid=', child.pid);

	child.send({
		type: 'initialize',
		modelId: 'smoke-model',
		modelPath: null,
		adapters: { baseModel: 'smoke-model', languageAdapters: [], projectAdapters: [], userAdapters: [] },
	});
	await onceMessage(child, m => m && m.type === 'ready');
	console.log('[smoke] initialize → ready');

	const requestId = 'smoke-req-1';
	const tokens = [];
	const streamDone = onceMessage(child, m => m && m.type === 'streamEnd' && m.requestId === requestId);
	child.on('message', msg => {
		if (msg && msg.type === 'streamToken' && msg.requestId === requestId) {
			tokens.push(msg.token);
			process.stdout.write(msg.token);
		}
	});
	child.send({
		type: 'generate',
		requestId,
		context: {
			taskId: 'smoke-task',
			request: 'hello',
			relatedFiles: [],
			relatedChunks: [],
			documentationChunks: [],
			memories: [],
			preferences: [],
			adapters: { available: [], active: [] },
			openFiles: [],
			workspace: { name: 'smoke' },
			systemPrompt: '',
			messages: [],
			builtAt: Date.now(),
			memory: [],
			rag: [],
			activeAdapters: [],
		},
	});

	const end = await streamDone;
	console.log('\n[smoke] streamEnd status=', end.status, 'tokens=', tokens.length);
	if (!tokens.length) {
		throw new Error('Expected streamed tokens');
	}
	if (end.status !== 'MODEL_RUNTIME_NOT_CONNECTED') {
		throw new Error(`Unexpected status: ${end.status}`);
	}

	child.send({ type: 'shutdown' });
	await onceMessage(child, m => m && m.type === 'ready');
	const exit = await onceExit(child);
	if (exit.code !== 0 && exit.code !== null) {
		throw new Error(`Non-zero exit: ${exit.code}`);
	}
	console.log('[smoke] PASS — streaming pipeline ok', exit);
}

main().catch(err => {
	console.error('[smoke] FAIL', err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
