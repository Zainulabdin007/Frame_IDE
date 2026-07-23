/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deterministic queries over the workspace knowledge graph.
 * No AI, no inference.
 */

import {
	FrameKnowledgeEdgeKind,
	FrameKnowledgeGraph,
	IFrameKnowledgeEdge,
	IFrameKnowledgeNode,
} from './frameKnowledgeGraph.js';

export class FrameKnowledgeQuery {

	constructor(private readonly graph: FrameKnowledgeGraph) { }

	findSymbol(name: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const lower = name.toLowerCase();
		const exact: IFrameKnowledgeNode[] = [];
		const partial: IFrameKnowledgeNode[] = [];
		for (const n of this.graph.nodes()) {
			if (n.kind === 'workspace' || n.kind === 'folder' || n.kind === 'file') {
				continue;
			}
			const nLower = n.name.toLowerCase();
			if (nLower === lower) {
				exact.push(n);
			} else if (nLower.includes(lower)) {
				partial.push(n);
			}
			if (exact.length + partial.length >= limit * 2) {
				break;
			}
		}
		return [...exact, ...partial].slice(0, limit);
	}

	findReferences(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeEdge[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const out: IFrameKnowledgeEdge[] = [];
		for (const id of ids) {
			for (const e of this.graph.incoming(id, 'references')) {
				out.push(e);
			}
			for (const e of this.graph.incoming(id, 'uses')) {
				out.push(e);
			}
			for (const e of this.graph.incoming(id, 'calls')) {
				out.push(e);
			}
			for (const e of this.graph.incoming(id, 'imports')) {
				out.push(e);
			}
		}
		return out.slice(0, limit);
	}

	findCallers(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const nodes: IFrameKnowledgeNode[] = [];
		for (const id of ids) {
			for (const e of this.graph.incoming(id, 'calls')) {
				const n = this.graph.getNode(e.from);
				if (n) {
					nodes.push(n);
				}
			}
		}
		return dedupeNodes(nodes).slice(0, limit);
	}

	findCallees(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const nodes: IFrameKnowledgeNode[] = [];
		for (const id of ids) {
			for (const e of this.graph.outgoing(id, 'calls')) {
				const n = this.graph.getNode(e.to);
				if (n) {
					nodes.push(n);
				}
			}
		}
		return dedupeNodes(nodes).slice(0, limit);
	}

	findImplementations(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const nodes: IFrameKnowledgeNode[] = [];
		for (const id of ids) {
			for (const e of this.graph.incoming(id, 'implements')) {
				const n = this.graph.getNode(e.from);
				if (n) {
					nodes.push(n);
				}
			}
		}
		return dedupeNodes(nodes).slice(0, limit);
	}

	findDerivedTypes(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const nodes: IFrameKnowledgeNode[] = [];
		for (const id of ids) {
			for (const e of this.graph.incoming(id, 'inherits')) {
				const n = this.graph.getNode(e.from);
				if (n) {
					nodes.push(n);
				}
			}
			for (const e of this.graph.incoming(id, 'implements')) {
				const n = this.graph.getNode(e.from);
				if (n) {
					nodes.push(n);
				}
			}
		}
		return dedupeNodes(nodes).slice(0, limit);
	}

	findImports(pathOrFileId: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const file = this.resolveFile(pathOrFileId);
		if (!file) {
			return [];
		}
		const nodes: IFrameKnowledgeNode[] = [];
		for (const e of this.graph.outgoing(file.id, 'imports')) {
			const n = this.graph.getNode(e.to);
			if (n) {
				nodes.push(n);
			}
		}
		return nodes.slice(0, limit);
	}

	findExports(pathOrFileId: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const file = this.resolveFile(pathOrFileId);
		if (!file) {
			return [];
		}
		const nodes: IFrameKnowledgeNode[] = [];
		for (const e of this.graph.outgoing(file.id, 'exports')) {
			const n = this.graph.getNode(e.to);
			if (n) {
				nodes.push(n);
			}
		}
		return nodes.slice(0, limit);
	}

	findDependencies(pathOrFileId: string, limit = 40): readonly IFrameKnowledgeNode[] {
		return this.findImports(pathOrFileId, limit);
	}

	findDependents(pathOrFileId: string, limit = 40): readonly IFrameKnowledgeNode[] {
		const file = this.resolveFile(pathOrFileId);
		if (!file) {
			return [];
		}
		const nodes: IFrameKnowledgeNode[] = [];
		for (const e of this.graph.incoming(file.id, 'imports')) {
			const n = this.graph.getNode(e.from);
			if (n) {
				nodes.push(n);
			}
		}
		// also match module aliases pointing at this path
		for (const e of this.graph.edges()) {
			if (e.kind !== 'imports') {
				continue;
			}
			const to = this.graph.getNode(e.to);
			if (to?.path === file.path) {
				const from = this.graph.getNode(e.from);
				if (from) {
					nodes.push(from);
				}
			}
		}
		return dedupeNodes(nodes).slice(0, limit);
	}

	callHierarchy(symbolIdOrName: string, limit = 40): readonly IFrameKnowledgeEdge[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const out: IFrameKnowledgeEdge[] = [];
		for (const id of ids) {
			out.push(...this.graph.outgoing(id, 'calls'));
			out.push(...this.graph.incoming(id, 'calls'));
		}
		return out.slice(0, limit);
	}

	dependencyEdges(pathOrFileId: string, limit = 40): readonly IFrameKnowledgeEdge[] {
		const file = this.resolveFile(pathOrFileId);
		if (!file) {
			return [];
		}
		const kinds: FrameKnowledgeEdgeKind[] = ['imports', 'uses', 'exports'];
		const out: IFrameKnowledgeEdge[] = [];
		for (const kind of kinds) {
			out.push(...this.graph.outgoing(file.id, kind));
			out.push(...this.graph.incoming(file.id, kind));
		}
		return out.slice(0, limit);
	}

	affectedFiles(symbolIdOrName: string, limit = 40): readonly string[] {
		const ids = this.resolveSymbolIds(symbolIdOrName);
		const files = new Set<string>();
		for (const id of ids) {
			const n = this.graph.getNode(id);
			if (n?.path) {
				files.add(n.path);
			}
			for (const e of this.findReferences(id, 80)) {
				const from = this.graph.getNode(e.from);
				const to = this.graph.getNode(e.to);
				if (from?.path) {
					files.add(from.path);
				}
				if (to?.path) {
					files.add(to.path);
				}
			}
		}
		return [...files].slice(0, limit);
	}

	private resolveSymbolIds(symbolIdOrName: string): string[] {
		if (this.graph.getNode(symbolIdOrName)) {
			return [symbolIdOrName];
		}
		return this.findSymbol(symbolIdOrName, 10).map(n => n.id);
	}

	private resolveFile(pathOrFileId: string): IFrameKnowledgeNode | undefined {
		return this.graph.getNode(pathOrFileId)
			?? this.graph.getNodeByPath(pathOrFileId)
			?? this.graph.getNode(`file:${pathOrFileId}`);
	}
}

function dedupeNodes(nodes: readonly IFrameKnowledgeNode[]): IFrameKnowledgeNode[] {
	const seen = new Set<string>();
	const out: IFrameKnowledgeNode[] = [];
	for (const n of nodes) {
		if (seen.has(n.id)) {
			continue;
		}
		seen.add(n.id);
		out.push(n);
	}
	return out;
}
