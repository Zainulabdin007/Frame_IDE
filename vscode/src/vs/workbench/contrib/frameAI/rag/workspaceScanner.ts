/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFrameWorkspaceFileInfo } from '../common/models.js';
import {
	detectLanguage,
	FRAME_RAG_MAX_FILE_BYTES,
	FRAME_RAG_MAX_FILES,
	isTextLikePath,
	relativePathFromFolder,
	shouldIgnoreDirName,
	shouldIgnoreFilePath,
} from './ragIgnore.js';

export interface IFrameWorkspaceScanResult {
	readonly folder: URI;
	readonly files: readonly IFrameWorkspaceFileInfo[];
	readonly skipped: number;
	readonly truncated: boolean;
}

/**
 * Walks opened workspace folders and collects source file metadata.
 * Does not read file contents — indexing reads once for chunking.
 */
export class FrameWorkspaceScanner {

	constructor(
		private readonly fileService: IFileService,
		private readonly workspaceService: IWorkspaceContextService,
		private readonly logService: ILogService,
	) { }

	async scan(folders?: readonly URI[]): Promise<IFrameWorkspaceScanResult[]> {
		const roots = folders?.length
			? folders
			: this.workspaceService.getWorkspace().folders.map(f => f.uri);

		const results: IFrameWorkspaceScanResult[] = [];
		for (const folder of roots) {
			results.push(await this.scanFolder(folder));
		}
		return results;
	}

	private async scanFolder(folder: URI): Promise<IFrameWorkspaceScanResult> {
		const files: IFrameWorkspaceFileInfo[] = [];
		let skipped = 0;
		let truncated = false;

		const queue: URI[] = [folder];
		while (queue.length && files.length < FRAME_RAG_MAX_FILES) {
			const dir = queue.shift()!;
			let stat: IFileStat;
			try {
				stat = await this.fileService.resolve(dir, { resolveMetadata: true });
			} catch (err) {
				this.logService.trace('[FrameRAG] skip unreadable dir', dir.toString(), err);
				skipped++;
				continue;
			}

			if (!stat.isDirectory || !stat.children) {
				continue;
			}

			for (const child of stat.children) {
				if (files.length >= FRAME_RAG_MAX_FILES) {
					truncated = true;
					break;
				}

				if (child.isDirectory) {
					if (shouldIgnoreDirName(child.name)) {
						skipped++;
						continue;
					}
					queue.push(child.resource);
					continue;
				}

				const rel = relativePathFromFolder(folder, child.resource);
				if (!rel || shouldIgnoreFilePath(rel) || !isTextLikePath(rel)) {
					skipped++;
					continue;
				}

				const size = child.size ?? 0;
				if (size <= 0 || size > FRAME_RAG_MAX_FILE_BYTES) {
					skipped++;
					continue;
				}

				files.push({
					uri: child.resource,
					relativePath: rel,
					language: detectLanguage(rel),
					size,
					symbols: [],
				});
			}
		}

		if (files.length >= FRAME_RAG_MAX_FILES) {
			truncated = true;
		}

		this.logService.info(`[FrameRAG] Scanned ${folder.toString()}: ${files.length} files, ${skipped} skipped${truncated ? ' (truncated)' : ''}`);
		return { folder, files, skipped, truncated };
	}
}
