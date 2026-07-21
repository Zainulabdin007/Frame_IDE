/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Local SHA-256 of a file — no network. */
export function sha256File(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/** Local SHA-256 of a UTF-8 string — no network. */
export function sha256Text(text) {
	return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export async function sha256FilePrefixed(filePath) {
	return `sha256:${await sha256File(filePath)}`;
}

export async function sha256TextPrefixed(text) {
	return `sha256:${sha256Text(text)}`;
}

/**
 * Build checksums.json entries for listed relative paths.
 * Missing files get a placeholder (developer packages without bundled weights).
 */
export async function buildChecksumMap(packageRoot, relativePaths, { readFileFn = readFile, existsFn } = {}) {
	const files = {};
	for (const rel of relativePaths) {
		const abs = `${packageRoot}/${rel}`.replace(/\/+/g, '/');
		let exists = true;
		if (existsFn) {
			exists = await existsFn(abs);
		} else {
			try {
				await readFileFn(abs);
			} catch {
				exists = false;
			}
		}
		if (!exists) {
			files[rel] = 'sha256:pending-user-weights';
			continue;
		}
		files[rel] = await sha256FilePrefixed(abs);
	}
	return { version: 1, files };
}
