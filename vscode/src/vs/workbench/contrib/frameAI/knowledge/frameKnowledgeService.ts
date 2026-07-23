/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workspace Knowledge Graph service — index, incremental update, query, tool registration.
 * Structural layer alongside RAG. No AI, no inference, no cloud.
 */

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IOutlineModelService } from '../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FRAME_RAG_MAX_FILES,
	detectLanguage,
	isTextLikePath,
	relativePathFromFolder,
	shouldIgnoreDirName,
	shouldIgnoreFilePath,
} from '../rag/ragIgnore.js';
import { FrameKnowledgeBuilder } from './frameKnowledgeBuilder.js';
import {
	FrameKnowledgeGraph,
	FrameKnowledgeGraphHealth,
	IFrameKnowledgeContextSlice,
	IFrameKnowledgeMetadata,
	emptyKnowledgeMetadata,
} from './frameKnowledgeGraph.js';
import { FrameKnowledgeQuery } from './frameKnowledgeQuery.js';
import { FrameKnowledgeStore } from './frameKnowledgeStore.js';

export const IFrameKnowledgeService = createDecorator<IFrameKnowledgeService>('frameKnowledgeService');

export interface IFrameKnowledgeService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeGraph: Event<IFrameKnowledgeMetadata>;

	getMetadata(): IFrameKnowledgeMetadata;

	getGraph(): FrameKnowledgeGraph;

	getQuery(): FrameKnowledgeQuery;

	ensureIndexed(): Promise<IFrameKnowledgeMetadata>;

	rebuildIndex(): Promise<IFrameKnowledgeMetadata>;

	indexPaths(relativePaths: readonly string[]): Promise<IFrameKnowledgeMetadata>;

	buildContextSlice(request: string, activePath?: string, limit?: number): IFrameKnowledgeContextSlice;

	getKnowledgeRoot(): URI | undefined;
}

export class FrameKnowledgeService extends Disposable implements IFrameKnowledgeService {

	declare readonly _serviceBrand: undefined;

	private readonly graph = new FrameKnowledgeGraph();
	private readonly query = new FrameKnowledgeQuery(this.graph);
	private readonly store: FrameKnowledgeStore;
	private readonly builder: FrameKnowledgeBuilder;

	private _metadata: IFrameKnowledgeMetadata = emptyKnowledgeMetadata();
	private _indexing = false;
	private _rebuildQueued = false;
	private readonly _pending = new Set<string>();
	private _loaded = false;
	private _bootstrapPromise: Promise<void> | undefined;

	private readonly _onDidChangeGraph = this._register(new Emitter<IFrameKnowledgeMetadata>());
	readonly onDidChangeGraph: Event<IFrameKnowledgeMetadata> = this._onDidChangeGraph.event;

	private readonly persistScheduler: RunOnceScheduler;
	private readonly incrementalScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITextModelService textModelService: ITextModelService,
		@IOutlineModelService outlineModelService: IOutlineModelService,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.store = new FrameKnowledgeStore(fileService, logService);
		this.builder = new FrameKnowledgeBuilder(
			fileService,
			textModelService,
			outlineModelService,
			languageFeatures,
			logService,
		);
		this.persistScheduler = this._register(new RunOnceScheduler(() => void this.persist(), 800));
		this.incrementalScheduler = this._register(new RunOnceScheduler(() => void this.flushPending(), 400));

		this._register(this.fileService.onDidFilesChange(e => this.onFilesChanged(e)));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			// Drop prior workspace snapshot immediately so queries never serve the old graph.
			this._loaded = false;
			this._bootstrapPromise = undefined;
			this._pending.clear();
			this.graph.clear();
			this._metadata = emptyKnowledgeMetadata();
			this.fire();
			void this.rebuildIndex();
		}));

		this.logService.info('[FrameKnowledge] Service ready (structural graph, no inference)');
		void this.bootstrap();
	}

	getMetadata(): IFrameKnowledgeMetadata {
		return this._metadata;
	}

	getGraph(): FrameKnowledgeGraph {
		return this.graph;
	}

	getQuery(): FrameKnowledgeQuery {
		return this.query;
	}

	getKnowledgeRoot(): URI | undefined {
		const folder = this.primaryFolder();
		return folder ? this.store.root(folder) : undefined;
	}

	async ensureIndexed(): Promise<IFrameKnowledgeMetadata> {
		await this.bootstrap();
		if (this._metadata.fileCount > 0 && this._metadata.health === 'healthy') {
			return this._metadata;
		}
		return this.rebuildIndex();
	}

	async rebuildIndex(): Promise<IFrameKnowledgeMetadata> {
		const folder = this.primaryFolder();
		if (!folder) {
			this.graph.clear();
			this._metadata = emptyKnowledgeMetadata();
			this._rebuildQueued = false;
			this.fire();
			return this._metadata;
		}
		if (this._indexing) {
			// Folder may have changed mid-index — rebuild again when the current pass finishes.
			this._rebuildQueued = true;
			return this._metadata;
		}
		this._indexing = true;
		this.setHealth('indexing');
		try {
			this.graph.clear();
			const workspaceId = this.builder.ensureWorkspaceRoot(this.graph, folder, this.workspaceService.getWorkspace().name);
			const files = await this.scanSourceFiles(folder);
			let indexed = 0;
			for (const file of files) {
				await this.builder.indexFile(this.graph, workspaceId, folder, file);
				indexed++;
			}
			this._metadata = this.graph.snapshot(folder.toString(), 'healthy', Date.now()).metadata;
			await this.persist();
			this.logService.info(`[FrameKnowledge] Rebuilt index: files=${indexed} nodes=${this._metadata.nodeCount} edges=${this._metadata.edgeCount}`);
			this.fire();
			return this._metadata;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._metadata = {
				...this.graph.snapshot(folder.toString(), 'error', this._metadata.lastIndexedAt, message).metadata,
			};
			this.fire();
			return this._metadata;
		} finally {
			this._indexing = false;
			if (this._rebuildQueued) {
				this._rebuildQueued = false;
				void this.rebuildIndex();
			} else if (this._pending.size) {
				this.incrementalScheduler.schedule();
			}
		}
	}

	async indexPaths(relativePaths: readonly string[]): Promise<IFrameKnowledgeMetadata> {
		const folder = this.primaryFolder();
		if (!folder || !relativePaths.length) {
			return this._metadata;
		}
		await this.bootstrap();
		const workspaceId = this.builder.ensureWorkspaceRoot(this.graph, folder, this.workspaceService.getWorkspace().name);
		for (const rel of relativePaths) {
			const path = rel.replace(/\\/g, '/');
			if (shouldIgnoreFilePath(path) || !isTextLikePath(path)) {
				this.graph.removeFileSubtree(path);
				continue;
			}
			const uri = joinPath(folder, ...path.split('/').filter(Boolean));
			if (!(await this.fileService.exists(uri))) {
				this.graph.removeFileSubtree(path);
				continue;
			}
			let size: number | undefined;
			try {
				const stat = await this.fileService.stat(uri);
				size = stat.size;
			} catch {
				// ignore
			}
			await this.builder.indexFile(this.graph, workspaceId, folder, {
				uri,
				path,
				languageId: detectLanguage(path),
				size,
			});
		}
		this._metadata = this.graph.snapshot(folder.toString(), 'healthy', Date.now()).metadata;
		this.persistScheduler.schedule();
		this.fire();
		return this._metadata;
	}

	buildContextSlice(request: string, activePath?: string, limit = 12): IFrameKnowledgeContextSlice {
		const keywords = extractKeywords(request);
		const relatedSymbols = [];
		for (const kw of keywords) {
			relatedSymbols.push(...this.query.findSymbol(kw, 6));
			if (relatedSymbols.length >= limit) {
				break;
			}
		}
		const focus = relatedSymbols[0]?.name ?? keywords[0] ?? (activePath ? activePath.split('/').pop() ?? '' : '');
		const callHierarchy = focus ? this.query.callHierarchy(focus, limit) : [];
		const dependencyGraph = activePath
			? this.query.dependencyEdges(activePath, limit)
			: relatedSymbols[0]?.path
				? this.query.dependencyEdges(relatedSymbols[0].path, limit)
				: [];
		const affected = new Set<string>();
		if (activePath) {
			affected.add(activePath);
		}
		for (const s of relatedSymbols) {
			if (s.path) {
				affected.add(s.path);
			}
		}
		for (const f of this.query.affectedFiles(focus, limit)) {
			affected.add(f);
		}
		return {
			summary: this._metadata,
			relatedSymbols: relatedSymbols.slice(0, limit),
			callHierarchy,
			dependencyGraph,
			affectedFiles: [...affected].slice(0, limit),
		};
	}

	private async bootstrap(): Promise<void> {
		if (this._bootstrapPromise) {
			return this._bootstrapPromise;
		}
		if (this._loaded) {
			return;
		}
		this._bootstrapPromise = this.doBootstrap().finally(() => {
			this._bootstrapPromise = undefined;
		});
		return this._bootstrapPromise;
	}

	private async doBootstrap(): Promise<void> {
		if (this._loaded) {
			return;
		}
		const folder = this.primaryFolder();
		if (!folder) {
			this._loaded = true;
			return;
		}
		const snapshot = await this.store.load(folder);
		if (snapshot) {
			this.graph.loadSnapshot(snapshot);
			this._metadata = snapshot.metadata.health === 'indexing'
				? { ...snapshot.metadata, health: 'stale' }
				: snapshot.metadata;
			this.fire();
		}
		this._loaded = true;
	}

	private async persist(): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const snapshot = this.graph.snapshot(
			folder.toString(),
			this._metadata.health === 'indexing' ? 'healthy' : this._metadata.health,
			this._metadata.lastIndexedAt ?? Date.now(),
			this._metadata.lastError,
		);
		await this.store.save(folder, snapshot);
	}

	private onFilesChanged(e: FileChangesEvent): void {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const candidates = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
		for (const change of candidates) {
			if (!this.isUnderFolder(change, folder)) {
				continue;
			}
			const rel = relativePathFromFolder(folder, change);
			if (!rel || rel.startsWith('.frame/') || shouldIgnoreFilePath(rel)) {
				continue;
			}
			if (!isTextLikePath(rel) && !e.rawDeleted.some(u => u.toString() === change.toString())) {
				continue;
			}
			this._pending.add(rel.replace(/\\/g, '/'));
		}
		// Always enqueue; flushPending waits if a full index is in progress.
		if (this._pending.size && !this._indexing) {
			this.incrementalScheduler.schedule();
		}
	}

	private async flushPending(): Promise<void> {
		if (!this._pending.size || this._indexing) {
			return;
		}
		const paths = [...this._pending];
		this._pending.clear();
		await this.indexPaths(paths);
	}

	private async scanSourceFiles(folder: URI): Promise<Array<{ uri: URI; path: string; languageId: string; size?: number }>> {
		const files: Array<{ uri: URI; path: string; languageId: string; size?: number }> = [];
		const queue: URI[] = [folder];
		while (queue.length && files.length < FRAME_RAG_MAX_FILES) {
			const dir = queue.shift()!;
			let children;
			try {
				const stat = await this.fileService.resolve(dir);
				children = stat.children ?? [];
			} catch {
				continue;
			}
			for (const child of children) {
				if (files.length >= FRAME_RAG_MAX_FILES) {
					break;
				}
				if (child.isDirectory) {
					if (shouldIgnoreDirName(child.name)) {
						continue;
					}
					queue.push(child.resource);
					continue;
				}
				const path = relativePathFromFolder(folder, child.resource);
				if (!path || shouldIgnoreFilePath(path) || !isTextLikePath(path)) {
					continue;
				}
				files.push({
					uri: child.resource,
					path: path.replace(/\\/g, '/'),
					languageId: detectLanguage(path),
					size: child.size,
				});
			}
		}
		return files;
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private isUnderFolder(resource: URI, folder: URI): boolean {
		const a = folder.toString().replace(/\/$/, '');
		const b = resource.toString();
		return b === a || b.startsWith(a + '/');
	}

	private setHealth(health: FrameKnowledgeGraphHealth): void {
		this._metadata = { ...this._metadata, health };
		this.fire();
	}

	private fire(): void {
		this._onDidChangeGraph.fire(this._metadata);
	}
}

function extractKeywords(prompt: string): string[] {
	const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'please', 'a', 'an', 'to', 'of', 'in', 'on', 'find', 'analyze']);
	return prompt
		.toLowerCase()
		.replace(/[^a-z0-9_\-\s]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 2 && !stop.has(w))
		.slice(0, 8);
}
