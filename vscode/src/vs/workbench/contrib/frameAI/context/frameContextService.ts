/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor, EditorsOrder, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { FrameAdapterState, FrameMemoryScope, FramePersistentMemoryKind, FrameRagChunkKind, IFrameAdapterContext, IFrameAdapterDescriptor, IFrameContextBuildRequest, IFrameInferenceContext, IFrameMemoryEntry, IFrameOpenFileRef, IFramePersistentMemoryRecord, IFrameRagChunk } from '../common/models.js';
import { IFrameAdapterService } from '../adapters/frameAdapters.js';
import { IFrameMemoryService } from '../memory/frameMemory.js';
import { mapPersistentToEntry } from '../memory/frameMemoryService.js';
import { IFramePersistentMemoryService } from '../memory/persistentMemory.js';
import { IFrameRagService } from '../rag/frameRag.js';
import { relativePathFromFolder } from '../rag/ragIgnore.js';
import { IFrameKnowledgeService } from '../knowledge/frameKnowledgeService.js';
import { IFrameContextService } from './frameContext.js';

const DEFAULT_SYSTEM_PROMPT = 'You are Frame, a local coding assistant. Read workspace files with tools before editing. Prefer precise, minimal changes. When the user asks about an attached or active file, use the provided Active file contents.';

function truncateActiveFile(full: string): string {
	return full.length > 256_000
		? `${full.slice(0, 256_000)}\n…[truncated ${full.length - 256_000} chars]`
		: full;
}

/**
 * Collects request + editor + RAG + persistent memory + adapters into IFrameInferenceContext.
 * Local-only — no model, no network.
 */
export class FrameContextService extends Disposable implements IFrameContextService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFrameRagService private readonly ragService: IFrameRagService,
		@IFrameMemoryService private readonly memoryService: IFrameMemoryService,
		@IFramePersistentMemoryService private readonly persistentMemory: IFramePersistentMemoryService,
		@IFrameAdapterService private readonly adapterService: IFrameAdapterService,
		@IFrameKnowledgeService private readonly knowledgeService: IFrameKnowledgeService,
	) {
		super();
		this.logService.info('[FrameAI] Context Engine ready (persistent memory + local gather)');
	}

	async build(request: IFrameContextBuildRequest): Promise<IFrameInferenceContext> {
		const folders = request.workspaceFolders?.length
			? request.workspaceFolders
			: this.workspaceService.getWorkspace().folders.map(f => f.uri);

		const editor = await this.collectEditorContext(request.activeUri, request.selectionText, folders);
		const rag = await this.collectRagContext(request.request, editor.activeFile, editor.selectedCode, folders);
		const attachmentChunks = await this.collectAttachmentChunks(request.attachedUris ?? [], editor.activeFile, folders);
		const memoryBundle = await this.collectMemoryContext(request.request, request.sessionId);
		const adapters = this.collectAdapterContext(editor.languageId);
		await this.knowledgeService.ensureIndexed();
		const knowledge = this.knowledgeService.buildContextSlice(request.request, editor.activeRelativePath);

		const affectedFiles = [...new Set([
			...attachmentChunks.map(chunk => chunk.relativePath).filter((path): path is string => !!path),
			...rag.relatedFiles,
			...knowledge.affectedFiles,
		])].slice(0, 12);

		const context: IFrameInferenceContext = {
			taskId: request.taskId,
			request: request.request,
			workspace: {
				folders,
				name: this.workspaceService.getWorkspace().name,
			},
			activeFile: editor.activeFile,
			activeRelativePath: editor.activeRelativePath,
			languageId: editor.languageId,
			selectedCode: editor.selectedCode,
			activeFileContent: editor.activeFileContent,
			cursor: editor.cursor,
			openFiles: editor.openFiles,
			relatedFiles: [...new Set([...attachmentChunks.map(chunk => chunk.relativePath).filter((path): path is string => !!path), ...rag.relatedFiles])],
			relatedChunks: [...attachmentChunks, ...rag.relatedChunks],
			documentationChunks: rag.documentationChunks,
			knowledgeGraph: knowledge.summary,
			relatedSymbols: knowledge.relatedSymbols,
			callHierarchy: knowledge.callHierarchy,
			dependencyGraph: knowledge.dependencyGraph,
			affectedFiles,
			memories: memoryBundle.memories,
			preferences: memoryBundle.preferences,
			adapters,
			systemPrompt: request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			messages: request.messages ?? [],
			builtAt: Date.now(),
			// legacy aliases
			memory: memoryBundle.memories,
			rag: rag.relatedChunks,
			files: rag.relatedFiles,
			activeAdapters: adapters.active,
		};

		this.logService.info(
			`[FrameAI] Context built: files=${context.relatedFiles.length} chunks=${context.relatedChunks.length} docs=${context.documentationChunks.length} symbols=${knowledge.relatedSymbols.length} memories=${context.memories.length} prefs=${context.preferences.length} adapters=${adapters.active.length}/${adapters.available.length} active=${editor.activeRelativePath ?? '(none)'}`,
		);

		return context;
	}

	private async collectAttachmentChunks(
		uris: readonly URI[],
		activeFile: URI | undefined,
		folders: readonly URI[],
	): Promise<IFrameRagChunk[]> {
		const chunks: IFrameRagChunk[] = [];
		const seen = new Set<string>(activeFile ? [activeFile.toString()] : []);
		for (const uri of uris) {
			const key = uri.toString();
			if (seen.has(key) || uri.scheme !== 'file' || chunks.length >= 8) {
				continue;
			}
			seen.add(key);
			const loaded = await this.loadFileForContext(uri);
			if (!loaded) {
				continue;
			}
			const text = loaded.content.slice(0, 8_000);
			chunks.push({
				id: `attachment:${key}`,
				uri,
				relativePath: this.relativeToWorkspace(uri, folders),
				language: loaded.languageId,
				kind: FrameRagChunkKind.Module,
				startLine: 1,
				endLine: Math.max(1, text.split(/\r?\n/).length),
				text,
				score: Number.MAX_SAFE_INTEGER,
				metadata: { attached: true, truncated: loaded.content.length > text.length },
			});
		}
		return chunks;
	}

	private async collectEditorContext(
		overrideUri: URI | undefined,
		overrideSelection: string | undefined,
		folders: readonly URI[],
	): Promise<{
		activeFile?: URI;
		activeRelativePath?: string;
		languageId?: string;
		selectedCode?: string;
		activeFileContent?: string;
		cursor?: { lineNumber: number; column: number };
		openFiles: IFrameOpenFileRef[];
	}> {
		const editor = this.codeEditorService.getActiveCodeEditor();
		let activeFile = overrideUri;
		let languageId: string | undefined;
		let selectedCode = overrideSelection;
		let activeFileContent: string | undefined;
		let cursor: { lineNumber: number; column: number } | undefined;

		if (editor && isCodeEditor(editor)) {
			const model = editor.getModel();
			if (!activeFile) {
				activeFile = model?.uri;
			}
			const position = editor.getPosition();
			if (position) {
				cursor = { lineNumber: position.lineNumber, column: position.column };
			}
			// Only use the focused editor buffer when it is the file we care about.
			if (model && (!overrideUri || model.uri.toString() === overrideUri.toString())) {
				languageId = model.getLanguageId();
				const full = model.getValue();
				activeFileContent = truncateActiveFile(full);
				if (selectedCode === undefined) {
					const selection = editor.getSelection();
					if (selection && !selection.isEmpty()) {
						selectedCode = model.getValueInRange(selection);
						if (selectedCode.length > 3_000) {
							selectedCode = selectedCode.slice(0, 3_000);
						}
					}
				}
			}
		}

		// Chat attachments / #file often point at a URI that is not the focused editor.
		if (activeFile && activeFileContent === undefined) {
			const loaded = await this.loadFileForContext(activeFile);
			if (loaded) {
				activeFileContent = loaded.content;
				languageId = languageId ?? loaded.languageId;
			}
		}

		const openFiles = this.collectOpenFiles(activeFile, folders);
		const activeRelativePath = activeFile
			? this.relativeToWorkspace(activeFile, folders)
			: undefined;

		return {
			activeFile,
			activeRelativePath,
			languageId,
			selectedCode,
			activeFileContent,
			cursor,
			openFiles,
		};
	}

	private async loadFileForContext(uri: URI): Promise<{ content: string; languageId?: string } | undefined> {
		try {
			const ref = await this.textModelService.createModelReference(uri);
			try {
				const model = ref.object.textEditorModel;
				return {
					content: truncateActiveFile(model.getValue()),
					languageId: model.getLanguageId(),
				};
			} finally {
				ref.dispose();
			}
		} catch (err) {
			this.logService.trace('[FrameAI] Could not load attached file for context', uri.toString(), err);
			return undefined;
		}
	}

	private collectOpenFiles(activeFile: URI | undefined, folders: readonly URI[]): IFrameOpenFileRef[] {
		const seen = new Set<string>();
		const refs: IFrameOpenFileRef[] = [];

		const push = (uri: URI | undefined, isActive: boolean) => {
			if (!uri || uri.scheme === 'untitled') {
				return;
			}
			const key = uri.toString();
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			refs.push({
				uri,
				relativePath: this.relativeToWorkspace(uri, folders),
				isActive,
			});
		};

		push(activeFile, true);

		for (const input of this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			const uri = EditorResourceAccessor.getOriginalUri(input.editor, { supportSideBySide: SideBySideEditor.PRIMARY });
			push(uri, !!(activeFile && uri && uri.toString() === activeFile.toString()));
			if (refs.length >= 24) {
				break;
			}
		}

		return refs;
	}

	private async collectRagContext(
		prompt: string,
		activeFile: URI | undefined,
		selectedCode: string | undefined,
		folders: readonly URI[],
	): Promise<{
		relatedFiles: string[];
		relatedChunks: IFrameRagChunk[];
		documentationChunks: IFrameRagChunk[];
	}> {
		if (!prompt.trim()) {
			return { relatedFiles: [], relatedChunks: [], documentationChunks: [] };
		}

		const result = await this.ragService.query({
			text: prompt,
			workspaceFolders: folders,
			activeUri: activeFile,
			selectionText: selectedCode,
			// Token optimizer: smaller retrieval for 7B Q4 latency.
			limit: 8,
			maxChars: 12_000,
		});

		const relatedChunks: IFrameRagChunk[] = [];
		const documentationChunks: IFrameRagChunk[] = [];

		for (const chunk of result.chunks) {
			if (isDocumentationChunk(chunk)) {
				documentationChunks.push(chunk);
			} else {
				relatedChunks.push(chunk);
			}
		}

		// Dedicated doc pass when the primary query returned few docs
		if (documentationChunks.length < 2) {
			const docQuery = await this.ragService.query({
				text: `${prompt} README documentation docs guide`,
				workspaceFolders: folders,
				activeUri: activeFile,
				limit: 8,
				maxChars: 12_000,
			});
			for (const chunk of docQuery.chunks) {
				if (!isDocumentationChunk(chunk)) {
					continue;
				}
				if (documentationChunks.some(d => d.id === chunk.id)) {
					continue;
				}
				documentationChunks.push(chunk);
			}
		}

		return {
			relatedFiles: [...(result.files ?? [])],
			relatedChunks,
			documentationChunks,
		};
	}

	private async collectMemoryContext(prompt: string, sessionId?: string): Promise<{
		memories: IFrameMemoryEntry[];
		preferences: IFrameMemoryEntry[];
	}> {
		await this.persistentMemory.load();
		const text = prompt.trim() || undefined;

		const [prefs, decisions, projects, summaries] = await Promise.all([
			this.persistentMemory.search({ kind: FramePersistentMemoryKind.Preference, text, language: undefined, limit: 32 }),
			this.persistentMemory.search({ kind: FramePersistentMemoryKind.Decision, text, limit: 24 }),
			this.persistentMemory.search({ kind: FramePersistentMemoryKind.Project, text, limit: 24 }),
			this.persistentMemory.search({
				kind: FramePersistentMemoryKind.ConversationSummary,
				text,
				sessionId,
				limit: 16,
			}),
		]);

		// Only approved/active preferences enter inference context (accepted >= 1 or active tag).
		let preferences = prefs.filter(isActivePreference);
		if (!preferences.length) {
			preferences = [...await this.persistentMemory.search({ kind: FramePersistentMemoryKind.Preference, limit: 32 })]
				.filter(isActivePreference);
		}

		const memories = dedupeById([
			...mapRecords(decisions),
			...mapRecords(projects),
			...mapRecords(summaries),
		]);

		// Ephemeral session scratch still available via facade
		const sessionScratch = sessionId
			? await this.memoryService.query({ sessionId, scope: FrameMemoryScope.Session, limit: 16 })
			: [];
		for (const entry of sessionScratch) {
			if (!entry.tags?.includes('conversationSummary') && !memories.some(m => m.id === entry.id)) {
				memories.push(entry);
			}
		}

		return {
			memories,
			preferences: mapRecords(preferences),
		};
	}

	private collectAdapterContext(languageId: string | undefined): IFrameAdapterContext {
		const available = this.adapterService.listAdapters();
		const active = available.filter(a => a.state === FrameAdapterState.Active);

		const languageAdapter = active.find(a => a.scope === 'language' && (!languageId || !a.language || normalizeLang(a.language) === normalizeLang(languageId)))
			?? pickAdapter(active, 'language', languageId)
			?? pickAdapter(active, 'lang', languageId);
		const projectAdapter = active.find(a => a.scope === 'project')
			?? pickAdapter(active, 'project');
		const userAdapter = active.find(a => a.scope === 'user')
			?? pickAdapter(active, 'user')
			?? pickAdapter(active, 'style')
			?? pickAdapter(active, 'personal');

		return {
			available,
			active,
			languageAdapter,
			projectAdapter,
			userAdapter,
		};
	}

	private relativeToWorkspace(uri: URI, folders: readonly URI[]): string | undefined {
		for (const folder of folders) {
			const rel = relativePathFromFolder(folder, uri);
			if (rel && !rel.startsWith('..')) {
				return rel;
			}
			if (uri.path.startsWith(folder.path)) {
				return relativePathFromFolder(folder, uri);
			}
		}
		return undefined;
	}
}

function isDocumentationChunk(chunk: IFrameRagChunk): boolean {
	const path = (chunk.relativePath ?? chunk.uri.path).toLowerCase();
	if (/\breadme\b/i.test(path) || path.includes('/docs/') || path.startsWith('docs/')) {
		return true;
	}
	if (path.endsWith('.md') || path.endsWith('.mdx') || path.endsWith('.rst')) {
		return true;
	}
	if (chunk.language === 'markdown' || (chunk.kind === FrameRagChunkKind.Module && path.endsWith('.md'))) {
		return true;
	}
	return false;
}

function dedupeById(entries: readonly IFrameMemoryEntry[]): IFrameMemoryEntry[] {
	const seen = new Set<string>();
	const out: IFrameMemoryEntry[] = [];
	for (const e of entries) {
		if (seen.has(e.id)) {
			continue;
		}
		seen.add(e.id);
		out.push(e);
	}
	return out;
}

function mapRecords(records: readonly IFramePersistentMemoryRecord[]): IFrameMemoryEntry[] {
	const out: IFrameMemoryEntry[] = [];
	for (const record of records) {
		const entry = mapPersistentToEntry(record);
		if (entry) {
			out.push(entry);
		}
	}
	return out;
}

function isActivePreference(record: IFramePersistentMemoryRecord): boolean {
	if (record.kind !== FramePersistentMemoryKind.Preference) {
		return false;
	}
	const pref = record as { accepted?: number; tags?: readonly string[] };
	if ((pref.accepted ?? 0) >= 1) {
		return true;
	}
	return !!pref.tags?.some(t => t.toLowerCase() === 'active');
}

function pickAdapter(
	active: readonly IFrameAdapterDescriptor[],
	tag: string,
	languageId?: string,
): IFrameAdapterDescriptor | undefined {
	const tagLower = tag.toLowerCase();
	const langLower = languageId?.toLowerCase();

	const tagged = active.filter(a => a.tags?.some(t => t.toLowerCase() === tagLower) || a.scope === tagLower);
	if (langLower && tagged.length) {
		const langMatch = tagged.find(a =>
			a.tags?.some(t => t.toLowerCase() === langLower)
			|| a.language?.toLowerCase() === langLower
			|| a.name.toLowerCase().includes(langLower)
			|| a.id.toLowerCase().includes(langLower),
		);
		if (langMatch) {
			return langMatch;
		}
	}
	if (tagged[0]) {
		return tagged[0];
	}

	return active.find(a => {
		const hay = `${a.id} ${a.name} ${a.scope} ${(a.tags ?? []).join(' ')}`.toLowerCase();
		if (!hay.includes(tagLower)) {
			return false;
		}
		if (langLower && tagLower === 'language') {
			return hay.includes(langLower);
		}
		return true;
	});
}

function normalizeLang(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
