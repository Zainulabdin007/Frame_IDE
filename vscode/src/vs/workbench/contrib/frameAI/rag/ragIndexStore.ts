/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFrameRagChunk, IFrameRagIndexStatus, IFrameWorkspaceFileInfo } from '../common/models.js';

export interface IFrameRagStoredIndex {
	readonly meta: IFrameRagMeta;
	readonly workspace: IFrameRagWorkspaceInfo;
	readonly chunks: readonly IFrameStoredChunk[];
}

export interface IFrameRagMeta {
	readonly version: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly documentCount: number;
	readonly chunkCount: number;
	readonly folder: string;
}

export interface IFrameRagWorkspaceInfo {
	readonly folder: string;
	readonly files: readonly {
		readonly path: string;
		readonly language: string;
		readonly size: number;
		readonly symbols: readonly string[];
	}[];
}

export interface IFrameStoredChunk {
	readonly id: string;
	readonly path: string;
	readonly uri: string;
	readonly language?: string;
	readonly kind?: string;
	readonly symbolName?: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export const FRAME_RAG_INDEX_VERSION = 1;

/**
 * Local filesystem index under `<workspace>/.frame/rag/`.
 * No database server — JSON + JSONL only.
 */
export class FrameRagIndexStore {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	indexRoot(folder: URI): URI {
		return joinPath(folder, '.frame', 'rag');
	}

	async load(folder: URI): Promise<IFrameRagStoredIndex | undefined> {
		const root = this.indexRoot(folder);
		try {
			const metaBuf = await this.fileService.readFile(joinPath(root, 'meta.json'));
			const workspaceBuf = await this.fileService.readFile(joinPath(root, 'workspace.json'));
			const chunksBuf = await this.fileService.readFile(joinPath(root, 'chunks.jsonl'));
			const meta = JSON.parse(metaBuf.value.toString()) as IFrameRagMeta;
			const workspace = JSON.parse(workspaceBuf.value.toString()) as IFrameRagWorkspaceInfo;
			const chunks = chunksBuf.value.toString()
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.map(line => JSON.parse(line) as IFrameStoredChunk);
			return { meta, workspace, chunks };
		} catch {
			return undefined;
		}
	}

	async save(folder: URI, files: readonly IFrameWorkspaceFileInfo[], chunks: readonly IFrameRagChunk[]): Promise<IFrameRagIndexStatus> {
		const root = this.indexRoot(folder);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(root);

		const now = Date.now();
		const storedChunks: IFrameStoredChunk[] = chunks.map(c => ({
			id: c.id,
			path: c.relativePath ?? c.uri.path,
			uri: c.uri.toString(true),
			language: c.language,
			kind: c.kind,
			symbolName: c.symbolName,
			startLine: c.startLine,
			endLine: c.endLine,
			text: c.text,
			metadata: c.metadata,
		}));

		const meta: IFrameRagMeta = {
			version: FRAME_RAG_INDEX_VERSION,
			createdAt: now,
			updatedAt: now,
			documentCount: files.length,
			chunkCount: storedChunks.length,
			folder: folder.toString(true),
		};

		const workspace: IFrameRagWorkspaceInfo = {
			folder: folder.toString(true),
			files: files.map(f => ({
				path: f.relativePath,
				language: f.language,
				size: f.size,
				symbols: f.symbols,
			})),
		};

		const jsonl = storedChunks.map(c => JSON.stringify(c)).join('\n') + (storedChunks.length ? '\n' : '');

		await this.fileService.writeFile(joinPath(root, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
		await this.fileService.writeFile(joinPath(root, 'workspace.json'), VSBuffer.fromString(JSON.stringify(workspace, null, 2)));
		await this.fileService.writeFile(joinPath(root, 'chunks.jsonl'), VSBuffer.fromString(jsonl));

		// Keep .frame out of git when possible
		await this.ensureGitignore(folder);

		this.logService.info(`[FrameRAG] Wrote local index to ${root.toString()} (${files.length} files, ${storedChunks.length} chunks)`);

		return {
			ready: true,
			documentCount: files.length,
			chunkCount: storedChunks.length,
			lastIndexedAt: now,
			message: `Indexed ${files.length} files into .frame/rag/`,
			indexRoot: root.toString(),
		};
	}

	toRagChunks(stored: readonly IFrameStoredChunk[]): IFrameRagChunk[] {
		return stored.map(c => ({
			id: c.id,
			uri: URI.parse(c.uri),
			relativePath: c.path,
			language: c.language,
			kind: c.kind as IFrameRagChunk['kind'],
			symbolName: c.symbolName,
			startLine: c.startLine,
			endLine: c.endLine,
			text: c.text,
			metadata: c.metadata,
		}));
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}

	private async ensureGitignore(folder: URI): Promise<void> {
		const gi = joinPath(folder, '.frame', '.gitignore');
		try {
			const exists = await this.fileService.exists(gi);
			if (!exists) {
				await this.fileService.writeFile(gi, VSBuffer.fromString('*\n'));
			}
		} catch (err) {
			this.logService.trace('[FrameRAG] could not write .frame/.gitignore', err);
		}
	}
}
