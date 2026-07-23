/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FramePersistentMemoryKind,
	IFrameConversationSummary,
	IFrameDecisionMemory,
	IFrameMemoryExportBundle,
	IFramePersistentMemoryRecord,
	IFramePersistentMemorySearchQuery,
	IFrameProjectMemory,
	IFrameUserPreference,
} from '../common/models.js';
import { FrameMemoryDiskStore, FRAME_MEMORY_STORE_VERSION } from './memoryDiskStore.js';
import { IFramePersistentMemoryService } from './persistentMemory.js';

/**
 * Persistent local memory: project / preferences / decisions / conversation summaries.
 * Files live under `<workspace>/.frame/memory/`.
 */
export class FramePersistentMemoryService extends Disposable implements IFramePersistentMemoryService {

	declare readonly _serviceBrand: undefined;

	private readonly store: FrameMemoryDiskStore;
	private readonly _records = new Map<string, IFramePersistentMemoryRecord>();
	private _folder: URI | undefined;
	private _metaCreatedAt: number | undefined;
	private _loadPromise: Promise<void> | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.store = new FrameMemoryDiskStore(fileService, logService);
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._loadPromise = undefined;
			this._records.clear();
			this._folder = undefined;
			void this.load();
		}));
		void this.load();
	}

	async load(folder?: URI): Promise<void> {
		if (this._loadPromise && !folder) {
			return this._loadPromise;
		}
		const pending = this.doLoad(folder).finally(() => {
			if (this._loadPromise === pending) {
				this._loadPromise = undefined;
			}
		});
		this._loadPromise = pending;
		return pending;
	}

	async save(folder?: URI): Promise<void> {
		await this.load(folder);
		const target = folder ?? this._folder ?? this.primaryFolder();
		if (!target) {
			this.logService.info('[FrameMemory] No workspace folder — skip persist');
			return;
		}
		this._folder = target;
		const snapshot = this.snapshot();
		const meta = await this.store.save(target, {
			...snapshot,
			meta: { createdAt: this._metaCreatedAt },
		});
		this._metaCreatedAt = meta.createdAt;
		this.logService.info(`[FrameMemory] Saved ${meta.counts.project + meta.counts.preferences + meta.counts.decisions + meta.counts.conversationSummaries} records to .frame/memory/`);
	}

	get(id: string): IFramePersistentMemoryRecord | undefined {
		return this._records.get(id);
	}

	async saveProject(partial: Omit<IFrameProjectMemory, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameProjectMemory> {
		await this.load();
		const now = Date.now();
		const existing = partial.id ? this._records.get(partial.id) : undefined;
		const record: IFrameProjectMemory = {
			id: partial.id || generateUuid(),
			kind: FramePersistentMemoryKind.Project,
			title: partial.title,
			content: partial.content,
			category: partial.category,
			relatedFiles: partial.relatedFiles,
			tags: partial.tags,
			createdAt: existing && existing.kind === FramePersistentMemoryKind.Project
				? existing.createdAt
				: (partial.createdAt ?? now),
			updatedAt: now,
		};
		this._records.set(record.id, record);
		await this.persist();
		this._onDidChange.fire();
		return record;
	}

	async savePreference(partial: Omit<IFrameUserPreference, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameUserPreference> {
		await this.load();
		const now = Date.now();
		const existing = partial.id ? this._records.get(partial.id) : undefined;
		const record: IFrameUserPreference = {
			id: partial.id || generateUuid(),
			kind: FramePersistentMemoryKind.Preference,
			preference: partial.preference,
			language: partial.language,
			confidence: clamp01(partial.confidence ?? 0.5),
			observations: Math.max(0, partial.observations ?? 0),
			accepted: Math.max(0, partial.accepted ?? 0),
			rejected: Math.max(0, partial.rejected ?? 0),
			tags: partial.tags,
			createdAt: existing && existing.kind === FramePersistentMemoryKind.Preference
				? existing.createdAt
				: (partial.createdAt ?? now),
			updatedAt: now,
		};
		this._records.set(record.id, record);
		await this.persist();
		this._onDidChange.fire();
		return record;
	}

	async saveDecision(partial: Omit<IFrameDecisionMemory, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameDecisionMemory> {
		await this.load();
		const now = Date.now();
		const existing = partial.id ? this._records.get(partial.id) : undefined;
		const record: IFrameDecisionMemory = {
			id: partial.id || generateUuid(),
			kind: FramePersistentMemoryKind.Decision,
			decision: partial.decision,
			rationale: partial.rationale,
			relatedFiles: partial.relatedFiles,
			tags: partial.tags,
			createdAt: existing && existing.kind === FramePersistentMemoryKind.Decision
				? existing.createdAt
				: (partial.createdAt ?? now),
			updatedAt: now,
		};
		this._records.set(record.id, record);
		await this.persist();
		this._onDidChange.fire();
		return record;
	}

	async saveConversationSummary(partial: Omit<IFrameConversationSummary, 'kind' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }): Promise<IFrameConversationSummary> {
		await this.load();
		const now = Date.now();
		const existing = partial.id ? this._records.get(partial.id) : undefined;
		const record: IFrameConversationSummary = {
			id: partial.id || generateUuid(),
			kind: FramePersistentMemoryKind.ConversationSummary,
			topic: partial.topic,
			summary: partial.summary,
			relatedFiles: partial.relatedFiles ?? [],
			sessionId: partial.sessionId,
			createdAt: existing && existing.kind === FramePersistentMemoryKind.ConversationSummary
				? existing.createdAt
				: (partial.createdAt ?? now),
			updatedAt: now,
		};
		this._records.set(record.id, record);
		await this.persist();
		this._onDidChange.fire();
		return record;
	}

	async update(id: string, patch: Partial<IFramePersistentMemoryRecord>): Promise<IFramePersistentMemoryRecord | undefined> {
		await this.load();
		const existing = this._records.get(id);
		if (!existing) {
			return undefined;
		}
		const now = Date.now();
		let next: IFramePersistentMemoryRecord;
		switch (existing.kind) {
			case FramePersistentMemoryKind.Project: {
				const p = patch as Partial<IFrameProjectMemory>;
				next = {
					...existing,
					title: p.title ?? existing.title,
					content: p.content ?? existing.content,
					category: p.category ?? existing.category,
					relatedFiles: p.relatedFiles ?? existing.relatedFiles,
					tags: p.tags ?? existing.tags,
					updatedAt: now,
				};
				break;
			}
			case FramePersistentMemoryKind.Preference: {
				const p = patch as Partial<IFrameUserPreference>;
				next = {
					...existing,
					preference: p.preference ?? existing.preference,
					language: p.language ?? existing.language,
					confidence: p.confidence !== undefined ? clamp01(p.confidence) : existing.confidence,
					observations: p.observations ?? existing.observations,
					accepted: p.accepted ?? existing.accepted,
					rejected: p.rejected ?? existing.rejected,
					tags: p.tags ?? existing.tags,
					updatedAt: now,
				};
				break;
			}
			case FramePersistentMemoryKind.Decision: {
				const p = patch as Partial<IFrameDecisionMemory>;
				next = {
					...existing,
					decision: p.decision ?? existing.decision,
					rationale: p.rationale ?? existing.rationale,
					relatedFiles: p.relatedFiles ?? existing.relatedFiles,
					tags: p.tags ?? existing.tags,
					updatedAt: now,
				};
				break;
			}
			case FramePersistentMemoryKind.ConversationSummary: {
				const p = patch as Partial<IFrameConversationSummary>;
				next = {
					...existing,
					topic: p.topic ?? existing.topic,
					summary: p.summary ?? existing.summary,
					relatedFiles: p.relatedFiles ?? existing.relatedFiles,
					sessionId: p.sessionId ?? existing.sessionId,
					updatedAt: now,
				};
				break;
			}
		}
		this._records.set(id, next);
		await this.persist();
		this._onDidChange.fire();
		return next;
	}

	async search(query: IFramePersistentMemorySearchQuery): Promise<readonly IFramePersistentMemoryRecord[]> {
		await this.load();
		const limit = query.limit ?? 50;
		const text = query.text?.toLowerCase();
		const results: IFramePersistentMemoryRecord[] = [];

		for (const record of this._records.values()) {
			if (query.kind !== undefined && record.kind !== query.kind) {
				continue;
			}
			if (query.sessionId !== undefined) {
				if (record.kind !== FramePersistentMemoryKind.ConversationSummary || record.sessionId !== query.sessionId) {
					continue;
				}
			}
			if (query.language !== undefined) {
				if (record.kind !== FramePersistentMemoryKind.Preference || (record.language ?? '').toLowerCase() !== query.language.toLowerCase()) {
					continue;
				}
			}
			if (query.tags?.length) {
				const tags = 'tags' in record ? record.tags ?? [] : [];
				if (!query.tags.every(t => tags.includes(t))) {
					continue;
				}
			}
			if (text && !recordMatchesText(record, text)) {
				continue;
			}
			results.push(record);
			if (results.length >= limit) {
				break;
			}
		}

		results.sort((a, b) => b.updatedAt - a.updatedAt);
		return results;
	}

	async delete(id: string): Promise<boolean> {
		await this.load();
		const ok = this._records.delete(id);
		if (ok) {
			await this.persist();
			this._onDidChange.fire();
		}
		return ok;
	}

	list(kind?: FramePersistentMemoryKind): readonly IFramePersistentMemoryRecord[] {
		const all = [...this._records.values()];
		if (kind === undefined) {
			return all;
		}
		return all.filter(r => r.kind === kind);
	}

	async exportMemory(folder?: URI): Promise<IFrameMemoryExportBundle> {
		await this.load(folder);
		const target = folder ?? this._folder ?? this.primaryFolder();
		const snapshot = {
			meta: {
				version: FRAME_MEMORY_STORE_VERSION,
				createdAt: this._metaCreatedAt ?? Date.now(),
				updatedAt: Date.now(),
				folder: target?.toString(true) ?? '',
				counts: {
					project: this.list(FramePersistentMemoryKind.Project).length,
					preferences: this.list(FramePersistentMemoryKind.Preference).length,
					decisions: this.list(FramePersistentMemoryKind.Decision).length,
					conversationSummaries: this.list(FramePersistentMemoryKind.ConversationSummary).length,
				},
			},
			...this.snapshot(),
		};
		return this.store.toExportBundle(target, snapshot);
	}

	async importMemory(bundle: IFrameMemoryExportBundle, options?: { merge?: boolean; folder?: URI }): Promise<number> {
		await this.load(options?.folder);
		const merge = options?.merge ?? true;
		if (!merge) {
			this._records.clear();
		}
		let count = 0;
		for (const row of [
			...bundle.project,
			...bundle.preferences,
			...bundle.decisions,
			...bundle.conversationSummaries,
		]) {
			this._records.set(row.id, row);
			count++;
		}
		await this.persist(options?.folder);
		this._onDidChange.fire();
		return count;
	}

	private async doLoad(folder?: URI): Promise<void> {
		const target = folder ?? this.primaryFolder();
		if (!target) {
			return;
		}
		this._folder = target;
		const loaded = await this.store.load(target);
		if (!loaded) {
			this.logService.info('[FrameMemory] No existing .frame/memory/ — starting empty');
			return;
		}
		this._metaCreatedAt = loaded.meta.createdAt;
		this._records.clear();
		for (const row of [
			...loaded.project,
			...loaded.preferences,
			...loaded.decisions,
			...loaded.conversationSummaries,
		]) {
			this._records.set(row.id, row);
		}
		this.logService.info(`[FrameMemory] Loaded ${this._records.size} records from .frame/memory/`);
		this._onDidChange.fire();
	}

	private async persist(folder?: URI): Promise<void> {
		await this.save(folder);
	}

	private snapshot() {
		const project: IFrameProjectMemory[] = [];
		const preferences: IFrameUserPreference[] = [];
		const decisions: IFrameDecisionMemory[] = [];
		const conversationSummaries: IFrameConversationSummary[] = [];
		for (const record of this._records.values()) {
			switch (record.kind) {
				case FramePersistentMemoryKind.Project:
					project.push(record);
					break;
				case FramePersistentMemoryKind.Preference:
					preferences.push(record);
					break;
				case FramePersistentMemoryKind.Decision:
					decisions.push(record);
					break;
				case FramePersistentMemoryKind.ConversationSummary:
					conversationSummaries.push(record);
					break;
			}
		}
		return { project, preferences, decisions, conversationSummaries };
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) {
		return 0;
	}
	return Math.min(1, Math.max(0, n));
}

function recordMatchesText(record: IFramePersistentMemoryRecord, text: string): boolean {
	switch (record.kind) {
		case FramePersistentMemoryKind.Project:
			return `${record.title} ${record.content} ${record.category}`.toLowerCase().includes(text);
		case FramePersistentMemoryKind.Preference:
			return `${record.preference} ${record.language ?? ''}`.toLowerCase().includes(text);
		case FramePersistentMemoryKind.Decision:
			return `${record.decision} ${record.rationale ?? ''}`.toLowerCase().includes(text);
		case FramePersistentMemoryKind.ConversationSummary:
			return `${record.topic} ${record.summary} ${record.relatedFiles.join(' ')}`.toLowerCase().includes(text);
	}
}
