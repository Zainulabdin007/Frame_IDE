/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';

/**
 * Resolve a workspace-relative path safely (blocks `..`, absolutes, NUL, and escapes).
 * Note: symlink targets outside the workspace are still a residual risk if the OS
 * follows them at read time; callers should prefer bounded reads.
 */
export function resolveSafeWorkspacePath(
	folder: URI,
	relativePath: unknown,
): { ok: true; uri: URI; relative: string } | { ok: false; error: string } {
	if (typeof relativePath !== 'string' || !relativePath.trim()) {
		return { ok: false, error: 'Path must be a non-empty string.' };
	}
	const trimmed = relativePath.trim().replace(/\\/g, '/');
	if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
		return { ok: false, error: 'Absolute paths are not allowed.' };
	}
	if (trimmed.includes('\0') || trimmed.includes('%00')) {
		return { ok: false, error: 'Invalid path.' };
	}
	const segments = trimmed.split('/').filter(s => s.length > 0 && s !== '.');
	if (segments.some(p => p === '..')) {
		return { ok: false, error: 'Path traversal (..) is not allowed.' };
	}
	if (segments.some(p => p.includes('\0'))) {
		return { ok: false, error: 'Invalid path.' };
	}

	const relative = segments.length === 0 ? '.' : segments.join('/');
	const uri = relative === '.' ? folder : joinPath(folder, ...segments);

	if (!isUriInsideWorkspace(folder, uri)) {
		return { ok: false, error: 'Path escapes workspace.' };
	}
	return { ok: true, uri, relative };
}

/** True when `candidate` is `folder` or a descendant (string-prefix on fsPath / path). */
export function isUriInsideWorkspace(folder: URI, candidate: URI): boolean {
	const root = normalizeFsPath(folder);
	const path = normalizeFsPath(candidate);
	return path === root || path.startsWith(root + '/');
}

function normalizeFsPath(uri: URI): string {
	const raw = (uri.fsPath || uri.path || '').replace(/\\/g, '/');
	// Collapse duplicate slashes; do not resolve ".." here (already rejected).
	return raw.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
