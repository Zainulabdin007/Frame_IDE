/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * GGUF model loader for the Frame model worker (node-llama-cpp).
 * Local only — no downloads, no cloud.
 *
 * LoRA limitation: node-llama-cpp applies adapters via `createContext({ lora })`.
 * Placeholder / non-GGUF adapter files are skipped with a clear log; initialize
 * still succeeds with the base model alone when LoRA apply fails.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { getLlama } from 'node-llama-cpp';

/**
 * Reject relative paths, `..` segments, and non-weight extensions.
 * @param {string} filePath
 * @param {{ allowSafetensors?: boolean }} [opts]
 */
export function assertSafeLocalWeightPath(filePath, opts = {}) {
	if (typeof filePath !== 'string' || !filePath.trim()) {
		throw new Error('Weight path is required.');
	}
	const trimmed = filePath.trim();
	if (!isAbsolute(trimmed)) {
		throw new Error(`Refusing non-absolute weight path: ${trimmed}`);
	}
	if (trimmed.includes('\0') || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(trimmed)) {
		throw new Error(`Refusing path traversal in weight path: ${trimmed}`);
	}
	const normalized = normalize(resolve(trimmed));
	if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(normalized)) {
		throw new Error(`Refusing path traversal in weight path: ${trimmed}`);
	}
	const lower = normalized.toLowerCase();
	const okExt = lower.endsWith('.gguf') || (opts.allowSafetensors && lower.endsWith('.safetensors'));
	if (!okExt) {
		throw new Error(`Unsupported weight format (expected .gguf): ${trimmed}`);
	}
	return normalized;
}

/**
 * @typedef {object} FrameLoadedModel
 * @property {Awaited<ReturnType<typeof getLlama>>} llama
 * @property {any} model
 * @property {any} context
 * @property {any} sequence
 * @property {null} session
 * @property {string} modelPath
 * @property {boolean} metalEnabled
 * @property {number} gpuLayers
 * @property {string[]} appliedLoraPaths
 */

/**
 * @param {unknown} adapters
 * @returns {{ id: string, path: string, scale?: number }[]}
 */
export function collectAdapterWeightEntries(adapters) {
	/** @type {{ id: string, path: string, scale?: number }[]} */
	const out = [];
	if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
		return out;
	}
	const paths = adapters.adapterPaths;
	if (!Array.isArray(paths)) {
		return out;
	}
	for (const entry of paths) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const path = typeof entry.path === 'string' ? entry.path : '';
		if (!path) {
			continue;
		}
		out.push({
			id: typeof entry.id === 'string' ? entry.id : path,
			path,
		});
	}
	return out;
}

/**
 * Filter to existing, non-tiny files that look like real adapter weights
 * (skip Frame text placeholders under ~1KB that start with "# Frame LoRA").
 *
 * @param {{ id: string, path: string }[]} entries
 */
function usableLoraFiles(entries) {
	/** @type {{ filePath: string, scale?: number }[]} */
	const adapters = [];
	for (const entry of entries) {
		let safePath;
		try {
			safePath = assertSafeLocalWeightPath(entry.path, { allowSafetensors: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[Frame Worker] Adapter path rejected (${message}), skipping: ${entry.id}`);
			continue;
		}
		if (!existsSync(safePath)) {
			console.warn(`[Frame Worker] Adapter weight missing, skipping: ${entry.id} → ${safePath}`);
			continue;
		}
		try {
			const st = statSync(safePath);
			if (st.size < 64) {
				console.warn(`[Frame Worker] Adapter weight too small (placeholder?), skipping: ${entry.id}`);
				continue;
			}
		} catch {
			console.warn(`[Frame Worker] Adapter weight unreadable, skipping: ${entry.id}`);
			continue;
		}
		adapters.push({ filePath: safePath, scale: 1 });
	}
	return adapters;
}

/**
 * Load a local GGUF with Metal on Apple Silicon when available.
 * Optionally apply LoRA adapters via createContext({ lora }) when supported.
 *
 * @param {string} modelPath
 * @param {{ id: string, path: string }[]} [adapterEntries]
 * @returns {Promise<FrameLoadedModel>}
 */
export async function loadModel(modelPath, adapterEntries = []) {
	const safeModelPath = assertSafeLocalWeightPath(modelPath, { allowSafetensors: false });
	if (!existsSync(safeModelPath)) {
		throw new Error(`Model file not found: ${safeModelPath}`);
	}

	let llama;
	try {
		llama = await getLlama({
			gpu: 'auto', // Metal on Apple Silicon, CPU elsewhere
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[Frame Worker] GPU init failed (${message}) — falling back to CPU`);
		llama = await getLlama({ gpu: false });
	}

	let model;
	try {
		model = await llama.loadModel({
			modelPath: safeModelPath,
			// Prefer maximum offload on M-series; library clamps to hardware.
			gpuLayers: llama.gpu ? 'max' : 0,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await llama?.dispose?.();
		} catch {
			// ignore dispose errors
		}
		if (/memory|oom|alloc/i.test(message)) {
			throw new Error(`Insufficient memory to load model. Try a lower quantization tier. (${message})`);
		}
		if (/format|gguf|corrupt|invalid/i.test(message)) {
			throw new Error(`Unsupported or corrupt GGUF: ${message}`);
		}
		throw err instanceof Error ? err : new Error(message);
	}

	const gpuLayers = typeof model.gpuLayers === 'number' ? model.gpuLayers : 0;
	const metalEnabled = String(llama.gpu).toLowerCase() === 'metal';
	console.log('[Frame Worker] Metal GPU:', metalEnabled);
	console.log('[Frame Worker] GPU backend:', llama.gpu ?? 'cpu', 'gpuLayers:', gpuLayers);

	const loraAdapters = usableLoraFiles(adapterEntries);
	/** @type {string[]} */
	const appliedLoraPaths = [];
	let context;

	// One durable sequence for the life of this context. Reusing it across chat
	// turns avoids "No sequences left" when session.dispose() also frees the sequence.
	const contextOptions = { sequences: 1 };
	if (loraAdapters.length) {
		try {
			// node-llama-cpp applies LoRA on context creation (not loadModel).
			context = await model.createContext({
				...contextOptions,
				lora: { adapters: loraAdapters },
			});
			appliedLoraPaths.push(...loraAdapters.map(a => a.filePath));
			console.log(`[Frame Worker] Applied ${appliedLoraPaths.length} LoRA adapter(s)`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Limitation: if createContext rejects `lora` (older API) or weights are invalid,
			// continue with the base model so initialize does not fail.
			console.warn(
				`[Frame Worker] LoRA apply not supported or failed (${message}) — continuing without adapters`,
			);
			context = await model.createContext(contextOptions);
		}
	} else {
		if (adapterEntries.length) {
			console.log('[Frame Worker] No usable adapter weight files — base model only');
		}
		context = await model.createContext(contextOptions);
	}

	const sequence = context.getSequence();

	return {
		llama,
		model,
		context,
		sequence,
		session: null,
		modelPath: safeModelPath,
		metalEnabled,
		gpuLayers,
		appliedLoraPaths,
	};
}

/**
 * Dispose loaded resources and free memory.
 *
 * @param {Partial<FrameLoadedModel> | null | undefined} loaded
 */
export async function unloadModel(loaded) {
	if (!loaded) {
		return;
	}
	try {
		loaded.session?.dispose?.({ disposeSequence: false });
	} catch {
		// ignore
	}
	try {
		loaded.sequence?.dispose?.();
	} catch {
		// ignore
	}
	try {
		await loaded.context?.dispose?.();
	} catch {
		// ignore
	}
	try {
		await loaded.model?.dispose?.();
	} catch {
		// ignore
	}
	try {
		await loaded.llama?.dispose?.();
	} catch {
		// ignore
	}
	console.log('[Frame Worker] Model memory released');
}
