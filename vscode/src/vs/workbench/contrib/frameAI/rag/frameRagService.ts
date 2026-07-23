/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	IFrameRagChunk,
	IFrameRagIndexStatus,
	IFrameRagQuery,
	IFrameRagResult,
	IFrameWorkspaceFileInfo,
} from '../common/models.js';
import { chunkSource } from './codeChunker.js';
import { IFrameRagService } from './frameRag.js';
import { FrameRagIndexStore } from './ragIndexStore.js';
import { rankChunks } from './ragRetrieval.js';
import { FrameWorkspaceScanner } from './workspaceScanner.js';

/**
 * Fully local workspace RAG: scan → chunk → store under `.frame/rag/` → lexical query.
 * No embeddings, no cloud, no external APIs.
 */
export class FrameRagService extends Disposable implements IFrameRagService {

	declare readonly _serviceBrand: undefined;

	private _status: IFrameRagIndexStatus = {
		ready: false,
		documentCount: 0,
		chunkCount: 0,
		message: 'RAG index not built yet.',
	};

	private _chunks: IFrameRagChunk[] = [];
	private _files: IFrameWorkspaceFileInfo[] = [];
	private _indexedAt: number | undefined;
	private _reindexPromise: Promise<IFrameRagIndexStatus> | undefined;
	/** Bumped on folder change so in-flight reindexes discard stale results. */
	private _indexGeneration = 0;

	private readonly store: FrameRagIndexStore;
	private readonly scanner: FrameWorkspaceScanner;

	private readonly _onDidChangeIndex = this._register(new Emitter<IFrameRagIndexStatus>());
	readonly onDidChangeIndex: Event<IFrameRagIndexStatus> = this._onDidChangeIndex.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.store = new FrameRagIndexStore(this.fileService, this.logService);
		this.scanner = new FrameWorkspaceScanner(this.fileService, this.workspaceService, this.logService);
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._indexGeneration++;
			this._chunks = [];
			this._files = [];
			this._indexedAt = undefined;
			this._status = {
				ready: false,
				documentCount: 0,
				chunkCount: 0,
				message: 'Workspace folders changed — RAG index will rebuild on next query.',
			};
			this._onDidChangeIndex.fire(this._status);
			void this.tryLoadExistingIndex();
		}));
		void this.tryLoadExistingIndex();
	}

	getStatus(): IFrameRagIndexStatus {
		return this._status;
	}

	getIndexedFiles(): readonly IFrameWorkspaceFileInfo[] {
		return this._files;
	}

	async reindex(folders?: readonly URI[]): Promise<IFrameRagIndexStatus> {
		if (this._reindexPromise) {
			return this._reindexPromise;
		}
		this._reindexPromise = this.doReindex(folders).finally(() => {
			this._reindexPromise = undefined;
		});
		return this._reindexPromise;
	}

	async query(query: IFrameRagQuery): Promise<IFrameRagResult> {
		if (!this._chunks.length) {
			await this.ensureIndex(query.workspaceFolders);
		}

		const result = rankChunks(query, this._chunks);
		return {
			...result,
			indexedAt: this._indexedAt,
		};
	}

	private async ensureIndex(folders?: readonly URI[]): Promise<void> {
		if (this._chunks.length) {
			return;
		}
		const loaded = await this.tryLoadExistingIndex(folders);
		if (loaded) {
			return;
		}
		await this.reindex(folders);
	}

	private async tryLoadExistingIndex(folders?: readonly URI[]): Promise<boolean> {
		const generation = this._indexGeneration;
		const roots = folders?.length
			? folders
			: this.workspaceService.getWorkspace().folders.map(f => f.uri);

		if (!roots.length) {
			return false;
		}

		const allChunks: IFrameRagChunk[] = [];
		const allFiles: IFrameWorkspaceFileInfo[] = [];
		let lastIndexed = 0;
		let any = false;

		for (const folder of roots) {
			if (generation !== this._indexGeneration) {
				return false;
			}
			const stored = await this.store.load(folder);
			if (!stored) {
				continue;
			}
			any = true;
			allChunks.push(...this.store.toRagChunks(stored.chunks));
			for (const f of stored.workspace.files) {
				allFiles.push({
					uri: URI.joinPath(folder, ...f.path.split(/[/\\]/).filter(Boolean)),
					relativePath: f.path,
					language: f.language,
					size: f.size,
					symbols: f.symbols,
				});
			}
			lastIndexed = Math.max(lastIndexed, stored.meta.updatedAt);
			this._status = {
				ready: true,
				documentCount: stored.meta.documentCount,
				chunkCount: stored.meta.chunkCount,
				lastIndexedAt: stored.meta.updatedAt,
				message: `Loaded local index from .frame/rag/ (${stored.meta.chunkCount} chunks)`,
				indexRoot: this.store.indexRoot(folder).toString(),
			};
		}

		if (!any || generation !== this._indexGeneration) {
			return false;
		}

		this._chunks = allChunks;
		this._files = allFiles;
		this._indexedAt = lastIndexed || Date.now();
		this._status = {
			ready: true,
			documentCount: allFiles.length,
			chunkCount: allChunks.length,
			lastIndexedAt: this._indexedAt,
			message: `Loaded local index (${allFiles.length} files, ${allChunks.length} chunks)`,
		};
		this._onDidChangeIndex.fire(this._status);
		return true;
	}

	private async doReindex(folders?: readonly URI[]): Promise<IFrameRagIndexStatus> {
		const generation = this._indexGeneration;
		const scans = await this.scanner.scan(folders);
		if (generation !== this._indexGeneration) {
			return this._status;
		}
		if (!scans.length) {
			this._status = {
				ready: false,
				documentCount: 0,
				chunkCount: 0,
				message: 'No workspace folder open — nothing to index.',
			};
			this._chunks = [];
			this._files = [];
			this._onDidChangeIndex.fire(this._status);
			return this._status;
		}

		const allChunks: IFrameRagChunk[] = [];
		const allFiles: IFrameWorkspaceFileInfo[] = [];
		let lastStatus: IFrameRagIndexStatus = this._status;

		for (const scan of scans) {
			if (generation !== this._indexGeneration) {
				return this._status;
			}
			const fileInfos: IFrameWorkspaceFileInfo[] = [];
			const folderChunks: IFrameRagChunk[] = [];

			for (const file of scan.files) {
				try {
					const raw = await this.fileService.readFile(file.uri);
					const text = raw.value.toString();
					if (text.includes('\u0000')) {
						continue;
					}
					const chunks = chunkSource({
						uri: file.uri,
						relativePath: file.relativePath,
						language: file.language,
						text,
					});
					const symbols = [...new Set(chunks.map(c => c.symbolName).filter((s): s is string => !!s))];
					const enriched: IFrameWorkspaceFileInfo = { ...file, symbols };
					fileInfos.push(enriched);
					folderChunks.push(...chunks);
				} catch (err) {
					this.logService.trace('[FrameRAG] skip during chunk', file.uri.toString(), err);
				}
			}

			lastStatus = await this.store.save(scan.folder, fileInfos, folderChunks);
			allFiles.push(...fileInfos);
			allChunks.push(...folderChunks);
		}

		if (generation !== this._indexGeneration) {
			return this._status;
		}

		this._chunks = allChunks;
		this._files = allFiles;
		this._indexedAt = Date.now();
		this._status = {
			...lastStatus,
			ready: true,
			documentCount: allFiles.length,
			chunkCount: allChunks.length,
			lastIndexedAt: this._indexedAt,
			message: `Indexed ${allFiles.length} files into .frame/rag/ (${allChunks.length} chunks)`,
		};
		this._onDidChangeIndex.fire(this._status);
		this.logService.info(`[FrameRAG] ${this._status.message}`);
		return this._status;
	}
}
