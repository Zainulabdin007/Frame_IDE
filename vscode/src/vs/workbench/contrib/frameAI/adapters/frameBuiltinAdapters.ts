/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { basename, join } from '../../../../base/common/path.js';
import {
	FrameAdapterKind,
	FrameAdapterScope,
	FrameAdapterState,
	IFrameAdapterDescriptor,
	IFrameRegisterAdapterInput,
} from '../common/models.js';
import { IFrameAdapterRuntimePath, IFrameRuntimeAdapters } from '../runtime/frameAdapterRuntime.js';

/** Product foundation LoRA — always on for every Frame install. */
export const FRAME_BUILTIN_ADAPTER_ID = 'frame-agent-v1';

export const FRAME_BUILTIN_ADAPTER_NAME = 'Frame agent LoRA v1';

export const FRAME_BUILTIN_ADAPTER_VERSION = '0.1.0';

export const FRAME_BUILTIN_WEIGHT_BASENAME = 'adapters.gguf';

export const FRAME_BUILTIN_BASE_MODEL = 'qwen-coder-7b-q4';

/** Env override for packaged / custom GGUF LoRA path. */
export const FRAME_BUILTIN_ADAPTER_PATH_ENV = 'FRAME_BUILTIN_ADAPTER_PATH';

/** Basename of the builtin adapter metadata written by install_fused_base_model.py. */
export const FRAME_BUILTIN_ADAPTER_METADATA_BASENAME = 'metadata.json';

export function isFrameBuiltinAdapterId(id: string | undefined | null): boolean {
	return !!id && id === FRAME_BUILTIN_ADAPTER_ID;
}

/**
 * Filename heuristic for a base GGUF that already contains the builtin adapter
 * (install_fused_base_model.py names it e.g. frame-agent-v1-fused-q4_k_m.gguf).
 * Prefer the metadata.json `fusedModelPath` check when available; this is the fallback.
 */
export function frameModelPathLooksFused(modelPath: string | null | undefined): boolean {
	if (!modelPath) {
		return false;
	}
	return basename(modelPath.replace(/\\/g, '/')).toLowerCase().includes('fused');
}

export function isFrameBuiltinAdapter(adapter: Pick<IFrameAdapterDescriptor, 'id' | 'builtin' | 'tags'> | undefined | null): boolean {
	if (!adapter) {
		return false;
	}
	if (adapter.builtin || isFrameBuiltinAdapterId(adapter.id)) {
		return true;
	}
	const tags = adapter.tags ?? [];
	return tags.includes('frame-builtin') || tags.includes('builtin');
}

/**
 * Candidate absolute paths for the shipped foundation GGUF (first existing wins).
 * Weights are not committed to git — release Resources + local convert output.
 */
export function getFrameBuiltinAdapterWeightCandidates(cwd?: string): readonly string[] {
	const roots: string[] = [];
	const envPath = typeof process !== 'undefined' ? process.env?.[FRAME_BUILTIN_ADAPTER_PATH_ENV]?.trim() : undefined;
	if (envPath) {
		roots.push(envPath);
	}

	const base = cwd
		?? (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '');
	if (base) {
		roots.push(
			join(base, 'resources', 'frame-adapters', FRAME_BUILTIN_ADAPTER_ID, FRAME_BUILTIN_WEIGHT_BASENAME),
			join(base, '..', 'resources', 'frame-adapters', FRAME_BUILTIN_ADAPTER_ID, FRAME_BUILTIN_WEIGHT_BASENAME),
			join(base, 'tools', 'frame-lora-train', 'adapters', 'frame-agent-v1-gguf', FRAME_BUILTIN_WEIGHT_BASENAME),
			join(base, '..', 'tools', 'frame-lora-train', 'adapters', 'frame-agent-v1-gguf', FRAME_BUILTIN_WEIGHT_BASENAME),
		);
	}

	// Dedupe while preserving order
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of roots) {
		const norm = p.replace(/\\/g, '/');
		if (!norm || seen.has(norm)) {
			continue;
		}
		seen.add(norm);
		out.push(p);
	}
	return out;
}

export function createBuiltinFrameAgentRegisterInput(): IFrameRegisterAdapterInput {
	return {
		id: FRAME_BUILTIN_ADAPTER_ID,
		name: FRAME_BUILTIN_ADAPTER_NAME,
		scope: FrameAdapterScope.Project,
		language: 'frame',
		version: FRAME_BUILTIN_ADAPTER_VERSION,
		baseModelId: FRAME_BUILTIN_BASE_MODEL,
		kind: FrameAdapterKind.LoRA,
		state: FrameAdapterState.Active,
		description: 'Built-in Frame agent behavior LoRA (edit plans, tools, small edits). Always on.',
		rank: 16,
		tags: ['frame-agent', 'frame-builtin', 'builtin', 'default'],
		// weightFileName omitted — v1 is fused into the base GGUF; only set when a separate adapters.gguf ships
	};
}

export function createBuiltinFrameAgentDescriptor(now = Date.now()): IFrameAdapterDescriptor {
	const input = createBuiltinFrameAgentRegisterInput();
	return {
		id: FRAME_BUILTIN_ADAPTER_ID,
		name: input.name,
		kind: FrameAdapterKind.LoRA,
		state: FrameAdapterState.Active,
		scope: FrameAdapterScope.Project,
		baseModelId: input.baseModelId!,
		language: input.language,
		version: input.version!,
		trainingExamples: 0,
		description: input.description,
		createdAt: now,
		updatedAt: now,
		localPath: `.frame/adapters/${FRAME_BUILTIN_ADAPTER_ID}`,
		rank: input.rank,
		tags: input.tags,
		builtin: true,
	};
}

/**
 * Ensure foundation LoRA is present in adapterPaths when a GGUF file exists.
 */
export function mergeBuiltinAdapterPaths(
	adapters: IFrameRuntimeAdapters,
	absoluteGgufPath: string | undefined,
): IFrameRuntimeAdapters {
	if (!absoluteGgufPath) {
		return adapters;
	}
	const entry: IFrameAdapterRuntimePath = {
		id: FRAME_BUILTIN_ADAPTER_ID,
		scope: FrameAdapterScope.Project,
		path: absoluteGgufPath,
		rank: 16,
	};
	const existing = adapters.adapterPaths ?? [];
	const without = existing.filter(p => p.id !== FRAME_BUILTIN_ADAPTER_ID);
	const projectAdapters = adapters.projectAdapters.includes(FRAME_BUILTIN_ADAPTER_NAME)
		|| adapters.projectAdapters.includes(FRAME_BUILTIN_ADAPTER_ID)
		? adapters.projectAdapters
		: [...adapters.projectAdapters, FRAME_BUILTIN_ADAPTER_NAME];
	return {
		...adapters,
		projectAdapters,
		adapterPaths: [entry, ...without],
	};
}
