/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * Ensure `.frame/.gitignore` ignores all Frame local state (chat, logs, models, adapters).
 * Prevents accidental git commits of prompts, weights, and tool payloads.
 */
export async function ensureFrameDotGitignore(fileService: IFileService, folder: URI): Promise<void> {
	const gi = joinPath(folder, '.frame', '.gitignore');
	try {
		if (!(await fileService.exists(gi))) {
			await fileService.createFolder(joinPath(folder, '.frame'));
			await fileService.writeFile(gi, VSBuffer.fromString('*\n'));
		}
	} catch {
		// best-effort
	}
}

/** Truncate user/model text before writing under `.frame/` (privacy at rest). */
export function truncateForLocalPersistence(text: string, maxChars: number): string {
	if (typeof text !== 'string' || text.length <= maxChars) {
		return text;
	}
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n…[truncated ${omitted} chars — privacy]`;
}

/** Redact common secret-bearing keys before logging tool arguments. */
export function redactSensitiveRecord(value: unknown, depth = 0): unknown {
	if (depth > 6 || value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'string') {
		return truncateForLocalPersistence(value, 240);
	}
	if (Array.isArray(value)) {
		return value.slice(0, 32).map(v => redactSensitiveRecord(v, depth + 1));
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const key = k.toLowerCase();
			if (/password|secret|token|apikey|api_key|authorization|cookie|private[_-]?key|credential/.test(key)) {
				out[k] = '[redacted]';
			} else if (/content|text|body|prompt|source|data|filecontents?/.test(key) && typeof v === 'string') {
				out[k] = truncateForLocalPersistence(v, 120);
			} else {
				out[k] = redactSensitiveRecord(v, depth + 1);
			}
		}
		return out;
	}
	return value;
}
