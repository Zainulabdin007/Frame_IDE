/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { FrameAdapterScope, IFrameAdapterContext, IFrameAdapterDescriptor } from '../common/models.js';

/**
 * Adapter injection contract for the isolated model worker.
 *
 * Future composition:
 *   Qwen base model
 *     + LoRA.python   (language)
 *     + LoRA.project  (project)
 *     + LoRA.user     (user)
 *
 * Labels always travel in initialize; optional {@link adapterPaths} carry
 * absolute local weight files when present (worker attempts LoRA apply).
 */
export interface IFrameRuntimeAdapters {
	readonly baseModel: string;
	readonly languageAdapters: string[];
	readonly projectAdapters: string[];
	readonly userAdapters: string[];
	/** Absolute filesystem paths to LoRA weight files (optional). */
	readonly adapterPaths?: readonly IFrameAdapterRuntimePath[];
}

export interface IFrameAdapterRuntimePath {
	readonly id: string;
	readonly scope: FrameAdapterScope | string;
	readonly path: string;
	readonly rank?: number;
}

/** @deprecated Prefer {@link IFrameRuntimeAdapters}. */
export interface IFrameAdapterRuntimeBundle extends IFrameRuntimeAdapters {
	readonly adapters: readonly string[];
	readonly adapterPaths?: readonly IFrameAdapterRuntimePath[];
}

export interface IFrameAdapterRuntimeResolver {
	resolveForGenerate(baseModelId: string | null, context?: IFrameAdapterContext): IFrameRuntimeAdapters;
}

/**
 * Build {@link IFrameRuntimeAdapters} from active adapter descriptors.
 * Includes absolute weight paths when `path` is set on an entry (or via options).
 * No tensor load in the IDE process.
 */
export function buildRuntimeAdapters(
	baseModel: string,
	adapters: readonly Pick<IFrameAdapterDescriptor, 'id' | 'name' | 'scope'>[] | readonly {
		readonly id: string;
		readonly name?: string;
		readonly scope?: FrameAdapterScope | string;
		readonly path?: string;
		readonly rank?: number;
	}[],
	context?: IFrameAdapterContext,
): IFrameRuntimeAdapters {
	const label = (a: { id: string; name?: string }) => a.name?.trim() || a.id;

	const adapterPaths = adapters
		.filter((a): a is typeof a & { path: string } => typeof (a as { path?: string }).path === 'string' && !!(a as { path?: string }).path)
		.map(a => ({
			id: a.id,
			scope: a.scope ?? 'user',
			path: a.path,
			rank: (a as { rank?: number }).rank,
		}));

	const withPaths = (runtime: IFrameRuntimeAdapters): IFrameRuntimeAdapters => (
		adapterPaths.length ? { ...runtime, adapterPaths } : runtime
	);

	if (context) {
		return withPaths({
			baseModel: baseModel || 'none',
			languageAdapters: [
				...(context.languageAdapter ? [label(context.languageAdapter)] : []),
				...adapters.filter(a => a.scope === FrameAdapterScope.Language).map(label),
			].filter(unique),
			projectAdapters: [
				...(context.projectAdapter ? [label(context.projectAdapter)] : []),
				...adapters.filter(a => a.scope === FrameAdapterScope.Project).map(label),
			].filter(unique),
			userAdapters: [
				...(context.userAdapter ? [label(context.userAdapter)] : []),
				...adapters.filter(a => a.scope === FrameAdapterScope.User || !a.scope).map(label),
			].filter(unique),
		});
	}

	return withPaths({
		baseModel: baseModel || 'none',
		languageAdapters: adapters.filter(a => a.scope === FrameAdapterScope.Language).map(label),
		projectAdapters: adapters.filter(a => a.scope === FrameAdapterScope.Project).map(label),
		userAdapters: adapters.filter(a => a.scope === FrameAdapterScope.User || a.scope === 'user' || !a.scope).map(label),
	});
}

/** Flatten for initialize protocol / legacy callers. */
export function flattenRuntimeAdapters(adapters: IFrameRuntimeAdapters): string[] {
	return [
		...adapters.languageAdapters,
		...adapters.projectAdapters,
		...adapters.userAdapters,
	];
}

/**
 * @deprecated Prefer {@link buildRuntimeAdapters}.
 */
export function buildAdapterRuntimeBundle(
	baseModel: string,
	adapters: readonly { readonly id: string; readonly name?: string; readonly scope?: FrameAdapterScope | string; readonly path?: string; readonly rank?: number }[],
): IFrameAdapterRuntimeBundle {
	const runtime = buildRuntimeAdapters(baseModel, adapters);
	const flat = flattenRuntimeAdapters(runtime);
	const adapterPaths = adapters
		.filter(a => !!a.path)
		.map(a => ({
			id: a.id,
			scope: a.scope ?? 'user',
			path: a.path!,
			rank: a.rank,
		}));
	return {
		...runtime,
		adapters: flat,
		adapterPaths: adapterPaths.length ? adapterPaths : undefined,
	};
}

function unique(value: string, index: number, all: string[]): boolean {
	return all.indexOf(value) === index;
}

/**
 * Basename-only weight file under `.frame/adapters/<id>/` (blocks `..` / absolute escapes).
 */
export function sanitizeAdapterWeightFileName(weightFileName: string | undefined | null): string | undefined {
	if (typeof weightFileName !== 'string' || !weightFileName.trim()) {
		return undefined;
	}
	const base = weightFileName.trim().replace(/\\/g, '/').split('/').pop() ?? '';
	if (!base || base === '.' || base === '..' || base.includes('\0') || base.includes('..')) {
		return undefined;
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(base)) {
		return undefined;
	}
	if (!/\.(gguf|safetensors)$/i.test(base)) {
		return undefined;
	}
	return base.slice(0, 120);
}

/**
 * Resolve absolute LoRA weight path for a descriptor when localPath + weightFileName exist.
 * Rejects path traversal: localPath must stay under `.frame/adapters/`, weight is basename-only.
 * `joinAbsolute` should typically be `(relParts) => joinPath(folder, ...relParts).fsPath`.
 */
export function resolveAdapterWeightAbsolutePath(
	adapter: Pick<IFrameAdapterDescriptor, 'id' | 'localPath' | 'weightFileName'>,
	joinAbsolute: (...parts: string[]) => string,
): string | undefined {
	const weight = sanitizeAdapterWeightFileName(adapter.weightFileName);
	if (!weight) {
		return undefined;
	}
	const localRaw = adapter.localPath?.trim().replace(/\\/g, '/') ?? '';
	const expected = `.frame/adapters/${adapter.id}`;
	const local = localRaw && !localRaw.includes('..') && !localRaw.startsWith('/') && !/^[a-zA-Z]:/.test(localRaw)
		? localRaw.replace(/\/+$/, '')
		: expected;
	if (!local.startsWith('.frame/adapters/') || local.includes('..')) {
		return undefined;
	}
	// Weight must resolve under the adapter directory (no nested escapes via localPath).
	const parts = [...local.split('/').filter(Boolean), weight];
	const abs = joinAbsolute(...parts);
	const adapterRoot = joinAbsolute(...expected.split('/').filter(Boolean));
	const normAbs = abs.replace(/\\/g, '/');
	const normRoot = adapterRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	if (normAbs !== normRoot && !normAbs.startsWith(normRoot + '/')) {
		return undefined;
	}
	return abs;
}

/** Annotate active adapters with absolute weight paths for worker initialize. */
export function withResolvedAdapterPaths(
	baseModel: string,
	active: readonly IFrameAdapterDescriptor[],
	context: IFrameAdapterContext | undefined,
	joinAbsolute: (...parts: string[]) => string,
): IFrameRuntimeAdapters {
	const annotated = active.map(a => {
		const path = resolveAdapterWeightAbsolutePath(a, joinAbsolute);
		return path ? { id: a.id, name: a.name, scope: a.scope, path, rank: a.rank } : { id: a.id, name: a.name, scope: a.scope, rank: a.rank };
	});
	return buildRuntimeAdapters(baseModel, annotated, context);
}
