/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService, resultIsMatch } from '../../../../services/search/common/search.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { IFrameKnowledgeService } from '../../knowledge/frameKnowledgeService.js';
import { IFrameRagService } from '../../rag/frameRag.js';
import { redactSensitiveRecord } from '../../common/frameWorkspaceIgnore.js';
import { asNumber, asString, resolveSafeWorkspacePath } from './frameToolPath.js';
import {
	FrameToolName,
	IFrameTool,
	IFrameToolActivityEntry,
	IFrameToolCall,
	IFrameToolContext,
	IFrameToolResult,
	isFrameToolName,
} from './frameTools.js';
import { FrameToolRegistry } from './frameToolRegistry.js';
import { IFrameToolLogService } from './frameToolLog.js';

const TOOL_CALL_TIMEOUT_MS = 30_000;

export const IFrameToolExecutionService = createDecorator<IFrameToolExecutionService>('frameToolExecutionService');

export interface IFrameToolExecutionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeActivity: Event<void>;

	readonly registry: FrameToolRegistry;

	validateCall(call: Pick<IFrameToolCall, 'name' | 'arguments'>): { ok: boolean; error?: string };

	executeCall(call: IFrameToolCall): Promise<IFrameToolResult>;

	/** Handle a worker toolRequest payload. */
	executeWorkerRequest(request: {
		readonly requestId: string;
		readonly callId: string;
		readonly tool: string;
		readonly args?: Readonly<Record<string, unknown>>;
		readonly conversationId?: string | null;
		readonly workerId?: string | null;
	}): Promise<IFrameToolResult>;

	getCurrentTool(): IFrameToolActivityEntry | undefined;

	getRecentCalls(limit?: number): readonly IFrameToolActivityEntry[];
}

/**
 * Validates and executes Frame tool calls from the worker protocol.
 */
export class FrameToolExecutionService extends Disposable implements IFrameToolExecutionService {

	declare readonly _serviceBrand: undefined;

	readonly registry: FrameToolRegistry;

	/** Running calls keyed by callId (concurrent worker requests are possible). */
	private readonly _running = new Map<string, IFrameToolActivityEntry>();
	private readonly _recent: IFrameToolActivityEntry[] = [];

	private readonly _onDidChangeActivity = this._register(new Emitter<void>());
	readonly onDidChangeActivity: Event<void> = this._onDidChangeActivity.event;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFrameToolLogService private readonly toolLog: IFrameToolLogService,
		@IFrameKnowledgeService private readonly knowledge: IFrameKnowledgeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISearchService private readonly searchService: ISearchService,
		@IFrameRagService private readonly ragService: IFrameRagService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ISCMService private readonly scmService: ISCMService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super();
		this.registry = new FrameToolRegistry(fileService, workspaceService, logService);
		this.registerKnowledgeTools();
		this.registerSearchTools();
		this.registerDiagnosticsTools();
		this.registerGitTools();
		this.logService.info('[FrameTools] Execution service ready (worker toolRequest bridge)');
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private workspaceFolders(): URI[] {
		return this.workspaceService.getWorkspace().folders.map(f => f.uri);
	}

	/** Workspace-relative path for a URI ('.' for a workspace root itself). */
	private toRelativePath(resource: URI): string {
		for (const folder of this.workspaceFolders()) {
			const root = folder.path.replace(/\/$/, '');
			if (resource.path === root) {
				return '.';
			}
			if (resource.path.startsWith(root + '/')) {
				return resource.path.slice(root.length + 1);
			}
		}
		return resource.path;
	}

	/** CancellationTokenSource linked to the per-call abort signal. */
	private linkedTokenSource(context: IFrameToolContext): CancellationTokenSource {
		const cts = new CancellationTokenSource();
		const signal = context.signal;
		if (signal) {
			if (signal.aborted) {
				cts.cancel();
			} else {
				signal.addEventListener('abort', () => cts.cancel(), { once: true });
			}
		}
		return cts;
	}

	private registerKnowledgeTools(): void {
		const tool = (
			name: FrameToolName,
			description: string,
			execute: IFrameTool['execute'],
		): IFrameTool => ({
			name,
			description,
			permission: 'search',
			enabled: true,
			execute,
		});

		this.registry.register(tool('findSymbol', 'Find symbols in the workspace knowledge graph.', async (args) => {
			await this.knowledge.ensureIndexed();
			const name = String(args.name ?? args.query ?? args.symbol ?? '');
			if (!name) {
				return { error: 'name is required' };
			}
			return { data: { symbols: this.knowledge.getQuery().findSymbol(name, Number(args.limit) || 40) } };
		}));

		this.registry.register(tool('findReferences', 'Find references to a symbol via the knowledge graph.', async (args) => {
			await this.knowledge.ensureIndexed();
			const name = String(args.name ?? args.symbol ?? args.query ?? '');
			if (!name) {
				return { error: 'name is required' };
			}
			return { data: { references: this.knowledge.getQuery().findReferences(name, Number(args.limit) || 40) } };
		}));

		this.registry.register(tool('findDependencies', 'Find import dependencies for a file.', async (args) => {
			await this.knowledge.ensureIndexed();
			const path = String(args.path ?? args.file ?? args.relativePath ?? '');
			if (!path) {
				return { error: 'path is required' };
			}
			const q = this.knowledge.getQuery();
			return {
				data: {
					dependencies: q.findDependencies(path, Number(args.limit) || 40),
					dependents: q.findDependents(path, Number(args.limit) || 40),
				},
			};
		}));

		this.registry.register(tool('findCallers', 'Find callers of a function/symbol in the knowledge graph.', async (args) => {
			await this.knowledge.ensureIndexed();
			const name = String(args.name ?? args.symbol ?? args.query ?? '');
			if (!name) {
				return { error: 'name is required' };
			}
			return { data: { callers: this.knowledge.getQuery().findCallers(name, Number(args.limit) || 40) } };
		}));

		this.registry.register(tool('findImplementations', 'Find implementations / derived types for a symbol.', async (args) => {
			await this.knowledge.ensureIndexed();
			const name = String(args.name ?? args.symbol ?? args.query ?? '');
			if (!name) {
				return { error: 'name is required' };
			}
			const q = this.knowledge.getQuery();
			return {
				data: {
					implementations: q.findImplementations(name, Number(args.limit) || 40),
					derived: q.findDerivedTypes(name, Number(args.limit) || 40),
				},
			};
		}));
	}

	private makeTool(
		name: FrameToolName,
		description: string,
		permission: IFrameTool['permission'],
		execute: IFrameTool['execute'],
	): IFrameTool {
		return { name, description, permission, enabled: true, execute };
	}

	private registerSearchTools(): void {
		this.registry.register(this.makeTool('grepWorkspace', 'Regex content search over workspace files (ripgrep-backed).', 'search', async (args, context) => {
			const folders = this.workspaceFolders();
			if (!folders.length) {
				return { error: 'No workspace folder open.' };
			}
			const pattern = asString(args.pattern ?? args.query ?? args.text);
			if (!pattern) {
				return { error: 'pattern is required.' };
			}
			try {
				new RegExp(pattern);
			} catch (err) {
				return { error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}` };
			}
			const limit = Math.min(Math.max(asNumber(args.limit, 30), 1), 100);
			const glob = asString(args.glob).trim();
			const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
			const query = queryBuilder.text({ pattern, isRegExp: true }, folders, {
				_reason: 'frameTool.grepWorkspace',
				maxResults: limit,
				includePattern: glob || undefined,
				expandPatterns: true,
				previewOptions: { matchLines: 1, charsPerLine: 200 },
			});
			const cts = this.linkedTokenSource(context);
			try {
				const complete = await this.searchService.textSearch(query, cts.token);
				const hits: { path: string; line: number; preview: string }[] = [];
				for (const fileMatch of complete.results) {
					const rel = this.toRelativePath(fileMatch.resource);
					for (const result of fileMatch.results ?? []) {
						if (!resultIsMatch(result)) {
							continue;
						}
						// Search ranges are 0-based; report 1-based lines.
						const line = (result.rangeLocations[0]?.source.startLineNumber ?? 0) + 1;
						hits.push({ path: rel, line, preview: result.previewText.split('\n', 1)[0].slice(0, 200) });
						if (hits.length >= limit) {
							break;
						}
					}
					if (hits.length >= limit) {
						break;
					}
				}
				return { data: { pattern, glob: glob || undefined, hits, truncated: !!complete.limitHit || hits.length >= limit } };
			} finally {
				cts.dispose();
			}
		}));

		this.registry.register(this.makeTool('globFiles', 'Find workspace files matching a glob pattern (e.g. "src/**/*.ts").', 'search', async (args, context) => {
			const folders = this.workspaceFolders();
			if (!folders.length) {
				return { error: 'No workspace folder open.' };
			}
			const pattern = asString(args.pattern ?? args.glob ?? args.query);
			if (!pattern) {
				return { error: 'pattern is required.' };
			}
			const limit = Math.min(Math.max(asNumber(args.limit, 50), 1), 200);
			const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
			const query = queryBuilder.file(folders, {
				_reason: 'frameTool.globFiles',
				includePattern: pattern,
				maxResults: limit,
				expandPatterns: true,
			});
			const cts = this.linkedTokenSource(context);
			try {
				const complete = await this.searchService.fileSearch(query, cts.token);
				const files = complete.results.slice(0, limit).map(r => this.toRelativePath(r.resource)).sort();
				return { data: { pattern, files, truncated: !!complete.limitHit || complete.results.length > limit } };
			} finally {
				cts.dispose();
			}
		}));

		this.registry.register(this.makeTool('codebaseSearch', 'Relevance-ranked search over indexed workspace code (local RAG).', 'search', async (args) => {
			const queryText = asString(args.query ?? args.text ?? args.pattern);
			if (!queryText) {
				return { error: 'query is required.' };
			}
			const limit = Math.min(Math.max(asNumber(args.limit, 8), 1), 50);
			// query() auto-indexes when no index exists yet.
			const result = await this.ragService.query({ text: queryText, limit });
			if (!result.chunks.length) {
				const status = this.ragService.getStatus();
				if (!status.ready) {
					return { error: `Codebase index unavailable: ${status.message ?? 'RAG index not built yet.'}` };
				}
				return { data: { query: queryText, results: [], message: 'No relevant code found for this query.' } };
			}
			const results = result.chunks.slice(0, limit).map(chunk => ({
				path: chunk.relativePath ?? this.toRelativePath(chunk.uri),
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				snippet: chunk.text.length > 1200 ? chunk.text.slice(0, 1200) + '…' : chunk.text,
				score: chunk.score ?? 0,
			}));
			return { data: { query: queryText, results } };
		}));
	}

	private registerDiagnosticsTools(): void {
		this.registry.register(this.makeTool('readLints', 'Read current workspace diagnostics (errors and warnings).', 'read', async (args) => {
			const limit = Math.min(Math.max(asNumber(args.limit, 50), 1), 200);
			const relPath = asString(args.path ?? args.relativePath).trim();
			let resource: URI | undefined;
			if (relPath) {
				const folder = this.primaryFolder();
				if (!folder) {
					return { error: 'No workspace folder open.' };
				}
				const resolved = resolveSafeWorkspacePath(folder, relPath);
				if (!resolved.ok) {
					return { error: resolved.error };
				}
				resource = resolved.uri;
			}
			const markers = this.markerService.read({
				resource,
				severities: MarkerSeverity.Error | MarkerSeverity.Warning,
			});
			const sorted = [...markers].sort((a, b) =>
				(b.severity - a.severity)
				|| a.resource.path.localeCompare(b.resource.path)
				|| (a.startLineNumber - b.startLineNumber));
			const entries = sorted.slice(0, limit).map(m => ({
				path: this.toRelativePath(m.resource),
				line: m.startLineNumber,
				column: m.startColumn,
				severity: m.severity === MarkerSeverity.Error ? 'error' : 'warning',
				message: m.message,
				source: m.source,
			}));
			return {
				data: {
					path: relPath || undefined,
					total: markers.length,
					entries,
					truncated: markers.length > limit,
				},
			};
		}));
	}

	private registerGitTools(): void {
		this.registry.register(this.makeTool('gitStatus', 'Report source control status (repositories, branch, changed files).', 'git', async () => {
			const repos = [...this.scmService.repositories];
			if (!repos.length) {
				return { data: { repositories: [], message: 'No source control repositories detected (not a git repository, or the git extension has not activated yet).' } };
			}
			const repositories = repos.map(repo => {
				const provider = repo.provider;
				const branch = provider.historyProvider.get()?.historyItemRef.get()?.name;
				const changes: { path: string; group: string; state: string }[] = [];
				for (const group of provider.groups) {
					for (const resourceEntry of group.resources) {
						changes.push({
							path: this.toRelativePath(resourceEntry.sourceUri),
							group: group.label,
							state: resourceEntry.decorations.tooltip ?? resourceEntry.contextValue ?? 'unknown',
						});
					}
				}
				return {
					repository: provider.rootUri ? this.toRelativePath(provider.rootUri) : provider.label,
					label: provider.label,
					...(branch ? { branch } : {}),
					changes,
				};
			});
			return { data: { repositories } };
		}));

		this.registry.register(this.makeTool('gitDiff', 'Unified diff of a file against its git HEAD version.', 'git', async (args) => {
			const relPath = asString(args.path ?? args.relativePath).trim();
			if (!relPath) {
				return { error: 'gitDiff requires a workspace-relative "path" argument (whole-repository diff is not supported).' };
			}
			const folder = this.primaryFolder();
			if (!folder) {
				return { error: 'No workspace folder open.' };
			}
			const resolved = resolveSafeWorkspacePath(folder, relPath);
			if (!resolved.ok) {
				return { error: resolved.error };
			}
			const fileUri = resolved.uri;
			// Same query format the built-in git extension's content provider expects
			// (see vscode/extensions/git/src/uri.ts toGitUri).
			const headUri = fileUri.with({
				scheme: 'git',
				path: fileUri.path + '.git',
				query: JSON.stringify({ path: fileUri.fsPath, ref: 'HEAD' }),
			});
			let headText: string;
			let workingText: string;
			try {
				const headRef = await this.textModelService.createModelReference(headUri);
				try {
					headText = headRef.object.textEditorModel.getValue();
				} finally {
					headRef.dispose();
				}
			} catch (err) {
				return { error: `Could not resolve git HEAD content for '${resolved.relative}' — the git extension may not be active or the file is not tracked in a git repository. (${err instanceof Error ? err.message : String(err)})` };
			}
			try {
				const workRef = await this.textModelService.createModelReference(fileUri);
				try {
					workingText = workRef.object.textEditorModel.getValue();
				} finally {
					workRef.dispose();
				}
			} catch (err) {
				return { error: `Could not read working copy of '${resolved.relative}': ${err instanceof Error ? err.message : String(err)}` };
			}
			if (headText === workingText) {
				return { data: { path: resolved.relative, diff: '', message: 'No changes against HEAD.' } };
			}
			const diff = computeUnifiedDiff(headText, workingText, resolved.relative);
			return { data: { path: resolved.relative, diff } };
		}));
	}

	validateCall(call: Pick<IFrameToolCall, 'name' | 'arguments'>): { ok: boolean; error?: string } {
		if (!isFrameToolName(call.name)) {
			return { ok: false, error: `Unknown tool: ${String(call.name)}` };
		}
		const tool = this.registry.lookup(call.name);
		if (!tool) {
			return { ok: false, error: `Tool not registered: ${call.name}` };
		}
		if (!this.registry.isAllowed(tool)) {
			return { ok: false, error: `Tool not permitted: ${call.name}` };
		}
		if (call.arguments && typeof call.arguments !== 'object') {
			return { ok: false, error: 'Tool arguments must be an object.' };
		}
		const pathLikes = [call.arguments?.path, call.arguments?.relativePath, call.arguments?.fromPath, call.arguments?.toPath];
		for (const pathLike of pathLikes) {
			if (typeof pathLike === 'string') {
				if (pathLike.includes('..') || pathLike.startsWith('/') || /^[a-zA-Z]:/.test(pathLike)) {
					return { ok: false, error: 'Invalid path (workspace escape blocked).' };
				}
			}
		}
		return { ok: true };
	}

	async executeWorkerRequest(request: {
		readonly requestId: string;
		readonly callId: string;
		readonly tool: string;
		readonly args?: Readonly<Record<string, unknown>>;
		readonly conversationId?: string | null;
		readonly workerId?: string | null;
	}): Promise<IFrameToolResult> {
		const name = isFrameToolName(request.tool) ? request.tool : undefined;
		if (!name) {
			return {
				callId: request.callId,
				name: 'readFile',
				success: false,
				error: `Unknown tool: ${request.tool}`,
				durationMs: 0,
				requestId: request.requestId,
			};
		}
		return this.executeCall({
			id: request.callId || generateUuid(),
			name,
			arguments: request.args ?? {},
			requestId: request.requestId,
			conversationId: request.conversationId,
			workerId: request.workerId,
			createdAt: Date.now(),
		});
	}

	async executeCall(call: IFrameToolCall): Promise<IFrameToolResult> {
		const validation = this.validateCall(call);
		const startedAt = Date.now();
		const running: IFrameToolActivityEntry = {
			callId: call.id,
			tool: call.name,
			arguments: call.arguments,
			startedAt,
			requestId: call.requestId,
			conversationId: call.conversationId,
			workerId: call.workerId,
			status: 'running',
		};
		this._running.set(running.callId, running);
		this.pushRecent(running);
		this._onDidChangeActivity.fire();

		if (!validation.ok) {
			const failed = this.finish(running, false, undefined, validation.error, Date.now() - startedAt);
			return {
				callId: call.id,
				name: call.name,
				success: false,
				error: validation.error,
				durationMs: failed.durationMs ?? 0,
				requestId: call.requestId,
			};
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error(`Tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`)), TOOL_CALL_TIMEOUT_MS);
		let outcome: { readonly success: boolean; readonly data?: unknown; readonly error?: string };
		try {
			outcome = await this.registry.execute(call.name, call.arguments, {
				requestId: call.requestId,
				conversationId: call.conversationId,
				workerId: call.workerId,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
		const durationMs = Date.now() - startedAt;
		const entry = this.finish(running, outcome.success, outcome.data, outcome.error, durationMs);

		void this.toolLog.logToolInvocation({
			tool: call.name,
			arguments: (redactSensitiveRecord(call.arguments) ?? {}) as Readonly<Record<string, unknown>>,
			durationMs,
			success: outcome.success,
			resultPreview: previewResult(outcome.data),
			error: outcome.error,
			conversationId: call.conversationId ?? null,
			workerId: call.workerId ?? null,
			requestId: call.requestId,
			callId: call.id,
		});

		return {
			callId: call.id,
			name: call.name as FrameToolName,
			success: outcome.success,
			data: outcome.data,
			error: outcome.error,
			durationMs: entry.durationMs ?? durationMs,
			requestId: call.requestId,
		};
	}

	getCurrentTool(): IFrameToolActivityEntry | undefined {
		let latest: IFrameToolActivityEntry | undefined;
		for (const entry of this._running.values()) {
			if (entry.status === 'running' && (!latest || entry.startedAt >= latest.startedAt)) {
				latest = entry;
			}
		}
		return latest;
	}

	getRecentCalls(limit = 20): readonly IFrameToolActivityEntry[] {
		return this._recent.slice(0, Math.max(1, limit));
	}

	private finish(
		running: IFrameToolActivityEntry,
		success: boolean,
		_data: unknown,
		error: string | undefined,
		durationMs: number,
	): IFrameToolActivityEntry {
		const done: IFrameToolActivityEntry = {
			...running,
			success,
			error,
			durationMs,
			status: success ? 'success' : 'failure',
		};
		this._running.delete(running.callId);
		const idx = this._recent.findIndex(r => r.callId === running.callId);
		if (idx >= 0) {
			this._recent[idx] = done;
		} else {
			this.pushRecent(done);
		}
		this._onDidChangeActivity.fire();
		return done;
	}

	private pushRecent(entry: IFrameToolActivityEntry): void {
		this._recent.unshift(entry);
		if (this._recent.length > 50) {
			this._recent.length = 50;
		}
	}
}

const MAX_DIFF_OUTPUT_LINES = 600;
const MAX_LCS_CELLS = 4_000_000;

/**
 * Simple line-based unified diff (single hunk spanning first→last change).
 * Common prefix/suffix are trimmed; very large middles degrade to one
 * remove-all/add-all hunk instead of an exact LCS.
 */
function computeUnifiedDiff(originalText: string, modifiedText: string, path: string): string {
	const a = originalText.split('\n');
	const b = modifiedText.split('\n');

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);

	let body: string[];
	if (aMid.length * bMid.length > MAX_LCS_CELLS) {
		body = [...aMid.map(l => `-${l}`), ...bMid.map(l => `+${l}`)];
	} else {
		body = lcsDiffLines(aMid, bMid);
	}

	let truncatedNote = '';
	if (body.length > MAX_DIFF_OUTPUT_LINES) {
		body = body.slice(0, MAX_DIFF_OUTPUT_LINES);
		truncatedNote = `\n… diff truncated at ${MAX_DIFF_OUTPUT_LINES} lines`;
	}

	const header = [
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -${aMid.length ? prefix + 1 : prefix},${aMid.length} +${bMid.length ? prefix + 1 : prefix},${bMid.length} @@`,
	];
	return header.concat(body).join('\n') + truncatedNote;
}

/** Classic LCS edit script over line arrays: ' ' keep, '-' delete, '+' insert. */
function lcsDiffLines(a: string[], b: string[]): string[] {
	const n = a.length;
	const m = b.length;
	// dp[i][j] = LCS length of a[i..] and b[j..], flattened.
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] = a[i] === b[j]
				? dp[(i + 1) * width + j + 1] + 1
				: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push(` ${a[i]}`);
			i++; j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			out.push(`-${a[i]}`);
			i++;
		} else {
			out.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < n) {
		out.push(`-${a[i++]}`);
	}
	while (j < m) {
		out.push(`+${b[j++]}`);
	}
	return out;
}

function previewResult(data: unknown): string | undefined {
	if (data === undefined) {
		return undefined;
	}
	try {
		const text = JSON.stringify(data);
		return text.length > 400 ? text.slice(0, 400) + '…' : text;
	} catch {
		return String(data).slice(0, 400);
	}
}
