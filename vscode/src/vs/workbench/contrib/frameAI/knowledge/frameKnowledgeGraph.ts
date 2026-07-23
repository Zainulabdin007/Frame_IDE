/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workspace Knowledge Graph — structural layer on top of RAG.
 * Deterministic nodes/edges only. No AI, no inference, no cloud.
 */

export type FrameKnowledgeNodeKind =
	| 'workspace'
	| 'folder'
	| 'file'
	| 'symbol'
	| 'function'
	| 'class'
	| 'interface'
	| 'enum'
	| 'variable'
	| 'module'
	| 'import'
	| 'export';

export type FrameKnowledgeEdgeKind =
	| 'contains'
	| 'imports'
	| 'exports'
	| 'inherits'
	| 'implements'
	| 'calls'
	| 'references'
	| 'declares'
	| 'uses';

export interface IFrameKnowledgeRange {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

export interface IFrameKnowledgeNode {
	readonly id: string;
	readonly kind: FrameKnowledgeNodeKind;
	readonly name: string;
	readonly path?: string;
	readonly languageId?: string;
	readonly range?: IFrameKnowledgeRange;
	readonly detail?: string;
	readonly uri?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface IFrameKnowledgeEdge {
	readonly id: string;
	readonly kind: FrameKnowledgeEdgeKind;
	readonly from: string;
	readonly to: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface IFrameKnowledgeGraphSnapshot {
	readonly nodes: readonly IFrameKnowledgeNode[];
	readonly edges: readonly IFrameKnowledgeEdge[];
	readonly metadata: IFrameKnowledgeMetadata;
	readonly version: IFrameKnowledgeVersion;
}

export interface IFrameKnowledgeMetadata {
	readonly folder: string;
	readonly nodeCount: number;
	readonly edgeCount: number;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly classCount: number;
	readonly functionCount: number;
	readonly lastIndexedAt: number | null;
	readonly health: FrameKnowledgeGraphHealth;
	readonly lastError?: string;
}

export type FrameKnowledgeGraphHealth = 'empty' | 'healthy' | 'stale' | 'error' | 'indexing';

export interface IFrameKnowledgeVersion {
	readonly format: 'frame-knowledge';
	readonly formatVersion: number;
	readonly schemaVersion: number;
	readonly builtAt: number;
}

export const FRAME_KNOWLEDGE_FORMAT = 'frame-knowledge' as const;
export const FRAME_KNOWLEDGE_FORMAT_VERSION = 1;
export const FRAME_KNOWLEDGE_SCHEMA_VERSION = 1;

export interface IFrameKnowledgeContextSlice {
	readonly summary: IFrameKnowledgeMetadata;
	readonly relatedSymbols: readonly IFrameKnowledgeNode[];
	readonly callHierarchy: readonly IFrameKnowledgeEdge[];
	readonly dependencyGraph: readonly IFrameKnowledgeEdge[];
	readonly affectedFiles: readonly string[];
}

/** In-memory mutable graph used by builder + query. */
export class FrameKnowledgeGraph {
	private readonly _nodes = new Map<string, IFrameKnowledgeNode>();
	private readonly _edges = new Map<string, IFrameKnowledgeEdge>();
	private readonly _out = new Map<string, Set<string>>();
	private readonly _in = new Map<string, Set<string>>();
	private readonly _byPath = new Map<string, string>();
	private readonly _fileNodeIds = new Set<string>();

	clear(): void {
		this._nodes.clear();
		this._edges.clear();
		this._out.clear();
		this._in.clear();
		this._byPath.clear();
		this._fileNodeIds.clear();
	}

	upsertNode(node: IFrameKnowledgeNode): void {
		this._nodes.set(node.id, node);
		// Path index is for file nodes only — symbols share the same path string.
		if (node.path && node.kind === 'file') {
			this._byPath.set(node.path, node.id);
		}
		if (node.kind === 'file') {
			this._fileNodeIds.add(node.id);
		}
	}

	upsertEdge(edge: IFrameKnowledgeEdge): void {
		this._edges.set(edge.id, edge);
		let outs = this._out.get(edge.from);
		if (!outs) {
			outs = new Set();
			this._out.set(edge.from, outs);
		}
		outs.add(edge.id);
		let ins = this._in.get(edge.to);
		if (!ins) {
			ins = new Set();
			this._in.set(edge.to, ins);
		}
		ins.add(edge.id);
	}

	removeNode(id: string): void {
		const node = this._nodes.get(id);
		if (!node) {
			return;
		}
		this._nodes.delete(id);
		if (node.path && node.kind === 'file' && this._byPath.get(node.path) === id) {
			this._byPath.delete(node.path);
		}
		this._fileNodeIds.delete(id);
		const edgeIds = new Set<string>([
			...(this._out.get(id) ?? []),
			...(this._in.get(id) ?? []),
		]);
		for (const edgeId of edgeIds) {
			this.removeEdge(edgeId);
		}
	}

	removeEdge(id: string): void {
		const edge = this._edges.get(id);
		if (!edge) {
			return;
		}
		this._edges.delete(id);
		this._out.get(edge.from)?.delete(id);
		this._in.get(edge.to)?.delete(id);
	}

	/** Remove a file node and all symbol nodes it contains (and related edges). */
	removeFileSubtree(path: string): void {
		const fileId = this._byPath.get(path);
		if (!fileId) {
			return;
		}
		const toRemove = new Set<string>([fileId]);
		for (const edge of this.outgoing(fileId, 'contains')) {
			toRemove.add(edge.to);
		}
		for (const edge of this.outgoing(fileId, 'declares')) {
			toRemove.add(edge.to);
		}
		for (const id of toRemove) {
			this.removeNode(id);
		}
	}

	getNode(id: string): IFrameKnowledgeNode | undefined {
		return this._nodes.get(id);
	}

	getNodeByPath(path: string): IFrameKnowledgeNode | undefined {
		const id = this._byPath.get(path);
		return id ? this._nodes.get(id) : undefined;
	}

	nodes(): readonly IFrameKnowledgeNode[] {
		return [...this._nodes.values()];
	}

	edges(): readonly IFrameKnowledgeEdge[] {
		return [...this._edges.values()];
	}

	outgoing(from: string, kind?: FrameKnowledgeEdgeKind): readonly IFrameKnowledgeEdge[] {
		const ids = this._out.get(from);
		if (!ids) {
			return [];
		}
		const out: IFrameKnowledgeEdge[] = [];
		for (const id of ids) {
			const e = this._edges.get(id);
			if (e && (!kind || e.kind === kind)) {
				out.push(e);
			}
		}
		return out;
	}

	incoming(to: string, kind?: FrameKnowledgeEdgeKind): readonly IFrameKnowledgeEdge[] {
		const ids = this._in.get(to);
		if (!ids) {
			return [];
		}
		const out: IFrameKnowledgeEdge[] = [];
		for (const id of ids) {
			const e = this._edges.get(id);
			if (e && (!kind || e.kind === kind)) {
				out.push(e);
			}
		}
		return out;
	}

	filePaths(): readonly string[] {
		const paths: string[] = [];
		for (const id of this._fileNodeIds) {
			const n = this._nodes.get(id);
			if (n?.path) {
				paths.push(n.path);
			}
		}
		return paths;
	}

	counts(): { nodeCount: number; edgeCount: number; fileCount: number; symbolCount: number; classCount: number; functionCount: number } {
		let symbolCount = 0;
		let classCount = 0;
		let functionCount = 0;
		for (const n of this._nodes.values()) {
			if (n.kind === 'class') {
				classCount++;
				symbolCount++;
			} else if (n.kind === 'function') {
				functionCount++;
				symbolCount++;
			} else if (n.kind === 'interface' || n.kind === 'enum' || n.kind === 'variable' || n.kind === 'symbol' || n.kind === 'module') {
				symbolCount++;
			}
		}
		return {
			nodeCount: this._nodes.size,
			edgeCount: this._edges.size,
			fileCount: this._fileNodeIds.size,
			symbolCount,
			classCount,
			functionCount,
		};
	}

	snapshot(folder: string, health: FrameKnowledgeGraphHealth, lastIndexedAt: number | null, lastError?: string): IFrameKnowledgeGraphSnapshot {
		const c = this.counts();
		return {
			nodes: this.nodes(),
			edges: this.edges(),
			metadata: {
				folder,
				nodeCount: c.nodeCount,
				edgeCount: c.edgeCount,
				fileCount: c.fileCount,
				symbolCount: c.symbolCount,
				classCount: c.classCount,
				functionCount: c.functionCount,
				lastIndexedAt,
				health,
				lastError,
			},
			version: {
				format: FRAME_KNOWLEDGE_FORMAT,
				formatVersion: FRAME_KNOWLEDGE_FORMAT_VERSION,
				schemaVersion: FRAME_KNOWLEDGE_SCHEMA_VERSION,
				builtAt: Date.now(),
			},
		};
	}

	loadSnapshot(snapshot: IFrameKnowledgeGraphSnapshot): void {
		this.clear();
		for (const n of snapshot.nodes) {
			this.upsertNode(n);
		}
		for (const e of snapshot.edges) {
			this.upsertEdge(e);
		}
	}
}

export function knowledgeNodeId(kind: FrameKnowledgeNodeKind, key: string): string {
	return `${kind}:${key}`;
}

export function knowledgeEdgeId(kind: FrameKnowledgeEdgeKind, from: string, to: string): string {
	return `${kind}:${from}->${to}`;
}

export function emptyKnowledgeMetadata(folder = ''): IFrameKnowledgeMetadata {
	return {
		folder,
		nodeCount: 0,
		edgeCount: 0,
		fileCount: 0,
		symbolCount: 0,
		classCount: 0,
		functionCount: 0,
		lastIndexedAt: null,
		health: 'empty',
	};
}
