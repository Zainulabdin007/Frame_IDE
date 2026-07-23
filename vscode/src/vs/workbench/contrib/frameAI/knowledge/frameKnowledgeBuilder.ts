/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds knowledge-graph nodes/edges from workspace files.
 * Uses Monaco outline / language services when available; otherwise deterministic heuristics.
 * No AI, no inference.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IOutlineModelService } from '../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { detectLanguage } from '../rag/ragIgnore.js';
import {
	FrameKnowledgeGraph,
	FrameKnowledgeNodeKind,
	IFrameKnowledgeNode,
	IFrameKnowledgeRange,
	knowledgeEdgeId,
	knowledgeNodeId,
} from './frameKnowledgeGraph.js';

export interface IFrameKnowledgeFileInput {
	readonly uri: URI;
	readonly path: string;
	readonly languageId?: string;
	readonly size?: number;
}

/**
 * Incremental file indexer for the workspace knowledge graph.
 */
export class FrameKnowledgeBuilder {

	constructor(
		private readonly fileService: IFileService,
		private readonly textModelService: ITextModelService,
		private readonly outlineModelService: IOutlineModelService | undefined,
		private readonly languageFeatures: ILanguageFeaturesService | undefined,
		private readonly logService: ILogService,
	) { }

	ensureWorkspaceRoot(graph: FrameKnowledgeGraph, folder: URI, folderName?: string): string {
		const id = knowledgeNodeId('workspace', folder.toString());
		graph.upsertNode({
			id,
			kind: 'workspace',
			name: folderName || folder.path.split('/').pop() || 'workspace',
			path: '.',
			uri: folder.toString(),
		});
		return id;
	}

	ensureFolderChain(graph: FrameKnowledgeGraph, workspaceId: string, relativePath: string): string {
		const parts = relativePath.split('/').filter(Boolean);
		if (parts.length <= 1) {
			return workspaceId;
		}
		let parentId = workspaceId;
		let accum = '';
		for (let i = 0; i < parts.length - 1; i++) {
			accum = accum ? `${accum}/${parts[i]}` : parts[i];
			const id = knowledgeNodeId('folder', accum);
			graph.upsertNode({
				id,
				kind: 'folder',
				name: parts[i],
				path: accum,
			});
			graph.upsertEdge({
				id: knowledgeEdgeId('contains', parentId, id),
				kind: 'contains',
				from: parentId,
				to: id,
			});
			parentId = id;
		}
		return parentId;
	}

	async indexFile(
		graph: FrameKnowledgeGraph,
		workspaceId: string,
		folder: URI,
		file: IFrameKnowledgeFileInput,
	): Promise<void> {
		graph.removeFileSubtree(file.path);
		const parentId = this.ensureFolderChain(graph, workspaceId, file.path);
		const languageId = file.languageId || detectLanguage(file.path);
		const fileId = knowledgeNodeId('file', file.path);
		graph.upsertNode({
			id: fileId,
			kind: 'file',
			name: file.path.split('/').pop() || file.path,
			path: file.path,
			languageId,
			uri: file.uri.toString(),
			metadata: file.size !== undefined ? { size: file.size } : undefined,
		});
		graph.upsertEdge({
			id: knowledgeEdgeId('contains', parentId, fileId),
			kind: 'contains',
			from: parentId,
			to: fileId,
		});

		let text = '';
		try {
			const buf = await this.fileService.readFile(file.uri);
			text = buf.value.toString();
		} catch (err) {
			this.logService.trace('[FrameKnowledge] skip unreadable', file.path, err);
			return;
		}

		const symbols = await this.collectSymbols(file.uri, text, languageId);
		for (const sym of symbols) {
			this.addSymbol(graph, fileId, file.path, languageId, sym);
		}

		this.addImportExportEdges(graph, folder, fileId, file.path, text, languageId);
		this.addHeritageEdges(graph, fileId, symbols, text);
		this.addCallEdges(graph, fileId, symbols, text);
	}

	private addSymbol(
		graph: FrameKnowledgeGraph,
		fileId: string,
		filePath: string,
		languageId: string,
		sym: { name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange; detail?: string },
	): string {
		const id = knowledgeNodeId(sym.kind, `${filePath}#${sym.name}@${sym.range?.startLine ?? 0}`);
		const node: IFrameKnowledgeNode = {
			id,
			kind: sym.kind,
			name: sym.name,
			path: filePath,
			languageId,
			range: sym.range,
			detail: sym.detail,
		};
		graph.upsertNode(node);
		graph.upsertEdge({
			id: knowledgeEdgeId('contains', fileId, id),
			kind: 'contains',
			from: fileId,
			to: id,
		});
		graph.upsertEdge({
			id: knowledgeEdgeId('declares', fileId, id),
			kind: 'declares',
			from: fileId,
			to: id,
		});
		return id;
	}

	private async collectSymbols(
		uri: URI,
		text: string,
		languageId: string,
	): Promise<Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange; detail?: string }>> {
		const fromOutline = await this.tryOutlineSymbols(uri);
		if (fromOutline.length) {
			return fromOutline;
		}
		return heuristicSymbols(text, languageId);
	}

	private async tryOutlineSymbols(
		uri: URI,
	): Promise<Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange; detail?: string }>> {
		if (!this.outlineModelService && !this.languageFeatures) {
			return [];
		}
		try {
			const ref = await this.textModelService.createModelReference(uri);
			try {
				const model = ref.object.textEditorModel;
				if (this.outlineModelService) {
					const outline = await this.outlineModelService.getOrCreate(model, CancellationToken.None);
					return flattenDocumentSymbols(outline.asListOfDocumentSymbols());
				}
				if (this.languageFeatures?.documentSymbolProvider.has(model)) {
					const providers = this.languageFeatures.documentSymbolProvider.ordered(model);
					for (const provider of providers) {
						const result = await provider.provideDocumentSymbols(model, CancellationToken.None);
						if (result?.length) {
							return flattenDocumentSymbols(result);
						}
					}
				}
			} finally {
				ref.dispose();
			}
		} catch (err) {
			this.logService.trace('[FrameKnowledge] outline unavailable', uri.toString(), err);
		}
		return [];
	}

	private addImportExportEdges(
		graph: FrameKnowledgeGraph,
		_folder: URI,
		fileId: string,
		filePath: string,
		text: string,
		languageId: string,
	): void {
		const imports = extractImports(text, languageId);
		for (const imp of imports) {
			const targetPath = resolveImportPath(filePath, imp, path => !!graph.getNodeByPath(path));
			const target = targetPath ? graph.getNodeByPath(targetPath) : undefined;
			const toId = target?.id ?? knowledgeNodeId('module', imp);
			if (!target) {
				graph.upsertNode({
					id: toId,
					kind: 'module',
					name: imp,
					path: targetPath,
					detail: 'external-or-unresolved',
				});
			}
			graph.upsertEdge({
				id: knowledgeEdgeId('imports', fileId, toId),
				kind: 'imports',
				from: fileId,
				to: toId,
				metadata: { specifier: imp },
			});
			graph.upsertEdge({
				id: knowledgeEdgeId('uses', fileId, toId),
				kind: 'uses',
				from: fileId,
				to: toId,
			});
		}

		const exports = extractExports(text, languageId);
		for (const name of exports) {
			const exportId = knowledgeNodeId('export', `${filePath}#${name}`);
			graph.upsertNode({
				id: exportId,
				kind: 'export',
				name,
				path: filePath,
				languageId,
			});
			graph.upsertEdge({
				id: knowledgeEdgeId('exports', fileId, exportId),
				kind: 'exports',
				from: fileId,
				to: exportId,
			});
			const declared = [...graph.outgoing(fileId, 'declares')].map(e => graph.getNode(e.to)).find(n => n?.name === name);
			if (declared) {
				graph.upsertEdge({
					id: knowledgeEdgeId('references', exportId, declared.id),
					kind: 'references',
					from: exportId,
					to: declared.id,
				});
			}
		}
	}

	private addHeritageEdges(
		graph: FrameKnowledgeGraph,
		fileId: string,
		symbols: Array<{ name: string; kind: FrameKnowledgeNodeKind }>,
		text: string,
	): void {
		const byName = new Map(symbols.map(s => [s.name, s]));
		const classExtends = /(?:class|interface)\s+(\w+)\s+extends\s+(\w+)/g;
		let m: RegExpExecArray | null;
		while ((m = classExtends.exec(text))) {
			const child = [...graph.outgoing(fileId, 'declares')].map(e => graph.getNode(e.to)).find(n => n?.name === m![1]);
			const parent = [...graph.nodes()].find(n => n.name === m![2] && (n.kind === 'class' || n.kind === 'interface'));
			if (child && parent) {
				graph.upsertEdge({
					id: knowledgeEdgeId('inherits', child.id, parent.id),
					kind: 'inherits',
					from: child.id,
					to: parent.id,
				});
			} else if (child && byName.has(m[2])) {
				// parent may be same-file later; skip unresolved
			}
		}
		const impl = /class\s+(\w+)[^{]*\bimplements\s+([^{]+)/g;
		while ((m = impl.exec(text))) {
			const child = [...graph.outgoing(fileId, 'declares')].map(e => graph.getNode(e.to)).find(n => n?.name === m![1]);
			if (!child) {
				continue;
			}
			for (const iface of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
				const parent = [...graph.nodes()].find(n => n.name === iface && n.kind === 'interface');
				if (parent) {
					graph.upsertEdge({
						id: knowledgeEdgeId('implements', child.id, parent.id),
						kind: 'implements',
						from: child.id,
						to: parent.id,
					});
				}
			}
		}
	}

	private addCallEdges(
		graph: FrameKnowledgeGraph,
		fileId: string,
		symbols: Array<{ name: string; kind: FrameKnowledgeNodeKind }>,
		text: string,
	): void {
		const functions = symbols.filter(s => s.kind === 'function');
		const declared = [...graph.outgoing(fileId, 'declares')].map(e => graph.getNode(e.to)).filter((n): n is IFrameKnowledgeNode => !!n);
		for (const caller of declared.filter(n => n.kind === 'function' || n.kind === 'class')) {
			for (const callee of functions) {
				if (callee.name === caller.name) {
					continue;
				}
				const re = new RegExp(`\\b${escapeRegExp(callee.name)}\\s*\\(`, 'g');
				if (re.test(text)) {
					const calleeNode = declared.find(n => n.name === callee.name);
					if (calleeNode) {
						graph.upsertEdge({
							id: knowledgeEdgeId('calls', caller.id, calleeNode.id),
							kind: 'calls',
							from: caller.id,
							to: calleeNode.id,
						});
					}
				}
			}
		}
	}
}

function flattenDocumentSymbols(symbols: DocumentSymbol[]): Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange; detail?: string }> {
	const out: Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange; detail?: string }> = [];
	const walk = (list: DocumentSymbol[]) => {
		for (const s of list) {
			out.push({
				name: s.name,
				kind: mapSymbolKind(s.kind),
				range: {
					startLine: s.range.startLineNumber,
					startColumn: s.range.startColumn,
					endLine: s.range.endLineNumber,
					endColumn: s.range.endColumn,
				},
				detail: s.detail || undefined,
			});
			if (s.children?.length) {
				walk(s.children);
			}
		}
	};
	walk(symbols);
	return out;
}

function mapSymbolKind(kind: SymbolKind): FrameKnowledgeNodeKind {
	switch (kind) {
		case SymbolKind.Class:
			return 'class';
		case SymbolKind.Interface:
			return 'interface';
		case SymbolKind.Enum:
		case SymbolKind.EnumMember:
			return 'enum';
		case SymbolKind.Function:
		case SymbolKind.Method:
		case SymbolKind.Constructor:
			return 'function';
		case SymbolKind.Variable:
		case SymbolKind.Constant:
		case SymbolKind.Field:
		case SymbolKind.Property:
			return 'variable';
		case SymbolKind.Module:
		case SymbolKind.Namespace:
		case SymbolKind.Package:
			return 'module';
		default:
			return 'symbol';
	}
}

function heuristicSymbols(text: string, _languageId: string): Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange }> {
	const out: Array<{ name: string; kind: FrameKnowledgeNodeKind; range?: IFrameKnowledgeRange }> = [];
	const lines = text.split(/\r?\n/);
	const patterns: Array<{ re: RegExp; kind: FrameKnowledgeNodeKind }> = [
		{ re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
		{ re: /^\s*(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
		{ re: /^\s*(?:export\s+)?enum\s+(\w+)/, kind: 'enum' },
		{ re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function' },
		{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: 'function' },
		{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/, kind: 'variable' },
		{ re: /^\s*def\s+(\w+)\s*\(/, kind: 'function' },
		{ re: /^\s*class\s+(\w+)\s*[:(]/, kind: 'class' },
	];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const p of patterns) {
			const m = p.re.exec(line);
			if (m) {
				out.push({
					name: m[1],
					kind: p.kind,
					range: { startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: line.length + 1 },
				});
				break;
			}
		}
	}
	return out.slice(0, 200);
}

function extractImports(text: string, languageId: string): string[] {
	const out = new Set<string>();
	const ts = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
	const req = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
	const py = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
	let m: RegExpExecArray | null;
	if (!languageId.startsWith('python')) {
		while ((m = ts.exec(text))) {
			out.add(m[1]);
		}
		while ((m = req.exec(text))) {
			out.add(m[1]);
		}
	} else {
		while ((m = py.exec(text))) {
			out.add(m[1] || m[2]);
		}
	}
	return [...out].slice(0, 100);
}

function extractExports(text: string, _languageId: string): string[] {
	const out = new Set<string>();
	const re = /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|interface|enum|const|let|var|type)\s+(\w+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out.add(m[1]);
	}
	const named = /export\s*\{\s*([^}]+)\s*\}/g;
	while ((m = named.exec(text))) {
		for (const part of m[1].split(',')) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name) {
				out.add(name);
			}
		}
	}
	return [...out].slice(0, 100);
}

function resolveImportPath(fromPath: string, specifier: string, hasPath?: (path: string) => boolean): string | undefined {
	if (!specifier.startsWith('.')) {
		return undefined;
	}
	const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
	const joined = (fromDir ? `${fromDir}/` : '') + specifier;
	const parts = joined.split('/');
	const stack: string[] = [];
	for (const p of parts) {
		if (p === '.' || p === '') {
			continue;
		}
		if (p === '..') {
			stack.pop();
		} else {
			stack.push(p);
		}
	}
	const resolved = stack.join('/');
	if (/\.[a-zA-Z0-9]+$/.test(resolved)) {
		return resolved;
	}
	const candidates = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js'];
	if (hasPath) {
		for (const ext of candidates) {
			const candidate = `${resolved}${ext}`;
			if (hasPath(candidate)) {
				return candidate;
			}
		}
	}
	return `${resolved}.ts`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
