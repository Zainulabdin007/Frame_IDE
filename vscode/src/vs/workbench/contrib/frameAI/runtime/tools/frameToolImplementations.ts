/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { asNumber, asString, resolveSafeWorkspacePath } from './frameToolPath.js';
import { FrameToolName, IFrameTool } from './frameTools.js';

/**
 * Built-in Frame IDE tools (local only — no cloud).
 */
export function createBuiltinFrameTools(
	fileService: IFileService,
	workspaceService: IWorkspaceContextService,
	logService: ILogService,
): readonly IFrameTool[] {
	const primary = () => workspaceService.getWorkspace().folders[0]?.uri;

	const tool = (
		name: FrameToolName,
		description: string,
		permission: IFrameTool['permission'],
		enabled: boolean,
		execute: IFrameTool['execute'],
	): IFrameTool => ({ name, description, permission, enabled, execute });

	return [
		tool('readFile', 'Read a workspace-relative text file.', 'read', true, async (args) => {
			const folder = primary();
			if (!folder) {
				return { error: 'No workspace folder open.' };
			}
			const resolved = resolveSafeWorkspacePath(folder, args.path ?? args.relativePath);
			if (!resolved.ok) {
				return { error: resolved.error };
			}
			if (!(await fileService.exists(resolved.uri))) {
				return { error: `File not found: ${resolved.relative}` };
			}
			const maxBytes = Math.min(Math.max(asNumber(args.maxBytes, 256_000), 1), 1_048_576);
			const buf = await fileService.readFile(resolved.uri, { length: maxBytes + 1 });
			const truncated = buf.value.byteLength > maxBytes;
			const sliced = truncated ? buf.value.slice(0, maxBytes) : buf.value;
			let content = sliced.toString();
			if (truncated) {
				// Byte-slicing can split a multi-byte UTF-8 sequence; drop the replacement char.
				content = content.replace(/\uFFFD+$/, '');
			}
			return {
				data: {
					path: resolved.relative,
					content,
					truncated,
					bytes: VSBuffer.fromString(content).byteLength,
				},
			};
		}),

		tool('writeFile', 'Write a workspace-relative text file (disabled by default — use edit Accept).', 'write', false, async (args) => {
			const folder = primary();
			if (!folder) {
				return { error: 'No workspace folder open.' };
			}
			const resolved = resolveSafeWorkspacePath(folder, args.path ?? args.relativePath);
			if (!resolved.ok) {
				return { error: resolved.error };
			}
			const content = asString(args.content, asString(args.text));
			const parent = dirname(resolved.uri);
			try {
				await fileService.createFolder(parent);
			} catch {
				// exists
			}
			await fileService.writeFile(resolved.uri, VSBuffer.fromString(content));
			return { data: { path: resolved.relative, bytes: content.length } };
		}),

		tool('listFiles', 'List files under a workspace-relative directory.', 'read', true, async (args) => {
			const folder = primary();
			if (!folder) {
				return { error: 'No workspace folder open.' };
			}
			const rel = asString(args.path ?? args.relativePath, '.').trim() || '.';
			const resolved = resolveSafeWorkspacePath(folder, rel);
			if (!resolved.ok) {
				return { error: resolved.error };
			}
			const target = rel === '.' ? folder : resolved.uri;
			if (!(await fileService.exists(target))) {
				return { error: `Directory not found: ${rel}` };
			}
			const limit = Math.min(asNumber(args.limit, 100), 500);
			const children = await fileService.resolve(target);
			const entries = (children.children ?? []).slice(0, limit).map(c => ({
				name: c.name,
				isDirectory: !!c.isDirectory,
				path: rel === '.' ? c.name : `${resolved.relative.replace(/\/$/, '')}/${c.name}`,
			}));
			return { data: { path: rel, entries, truncated: (children.children?.length ?? 0) > limit } };
		}),

		tool('searchWorkspace', 'Search workspace file names for a query string.', 'search', true, async (args) => {
			const folder = primary();
			if (!folder) {
				return { error: 'No workspace folder open.' };
			}
			const query = asString(args.query ?? args.text).toLowerCase();
			if (!query) {
				return { error: 'query is required.' };
			}
			const limit = Math.min(asNumber(args.limit, 40), 200);
			const matches: string[] = [];
			await walkFiles(fileService, folder, folder, async (rel) => {
				if (rel.toLowerCase().includes(query)) {
					matches.push(rel);
				}
				return matches.length < limit;
			}, 800);
			return { data: { query, matches, truncated: matches.length >= limit } };
		}),

		tool('renameSymbol', 'Rename a symbol (not implemented).', 'refactor', true, async (args) => {
			return {
				error: `renameSymbol is not implemented in this build (requested ${asString(args.from ?? args.oldName) || '?'} -> ${asString(args.to ?? args.newName) || '?'}). Use the editor rename (F2) instead.`,
			};
		}),

		tool('formatDocument', 'Format a document (not implemented).', 'refactor', true, async (args) => {
			return {
				error: `formatDocument is not implemented in this build (requested path: ${asString(args.path) || '?'}). Use the editor Format Document command instead.`,
			};
		}),

		tool('terminalRun', 'Run a terminal command (disabled by default).', 'execute', false, async (args) => {
			logService.info(`[FrameTools] terminalRun blocked (execute permission off): ${asString(args.command)}`);
			return { error: 'terminalRun is disabled (execute permission).' };
		}),

		tool('taskRun', 'Run a VS Code task (disabled by default).', 'execute', false, async (args) => {
			logService.info(`[FrameTools] taskRun blocked (execute permission off): ${asString(args.task)}`);
			return { error: 'taskRun is disabled (execute permission).' };
		}),
	];
}

async function walkFiles(
	fileService: IFileService,
	root: URI,
	dir: URI,
	visit: (relative: string, uri: URI) => Promise<boolean>,
	budget: number,
): Promise<void> {
	let remaining = budget;
	const queue: URI[] = [dir];
	while (queue.length && remaining > 0) {
		const current = queue.shift()!;
		let resolved;
		try {
			resolved = await fileService.resolve(current);
		} catch {
			continue;
		}
		for (const child of resolved.children ?? []) {
			remaining--;
			if (remaining <= 0) {
				return;
			}
			const name = child.name;
			if (name === '.git' || name === 'node_modules' || name === 'out' || name === '.build') {
				continue;
			}
			const childUri = child.resource;
			const rel = relativeFrom(root, childUri);
			if (child.isDirectory) {
				queue.push(childUri);
			} else {
				const cont = await visit(rel, childUri);
				if (!cont) {
					return;
				}
			}
		}
	}
}

function relativeFrom(root: URI, file: URI): string {
	const rootPath = root.path.replace(/\/$/, '');
	const filePath = file.path;
	if (filePath.startsWith(rootPath + '/')) {
		return filePath.slice(rootPath.length + 1);
	}
	return filePath;
}
