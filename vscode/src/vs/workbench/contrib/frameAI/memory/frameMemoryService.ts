/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FrameMemoryScope, FramePersistentMemoryKind, IFrameMemoryEntry, IFrameMemoryQuery, IFramePersistentMemoryRecord } from '../common/models.js';
import { IFrameMemoryService } from './frameMemory.js';
import { IFramePersistentMemoryService } from './persistentMemory.js';

/**
 * Memory facade: ephemeral session entries + durable `.frame/memory/` via PersistentMemoryService.
 */
export class FrameMemoryService extends Disposable implements IFrameMemoryService {

	declare readonly _serviceBrand: undefined;

	/** Ephemeral session / scratch entries (not written as durable kinds). */
	private readonly _ephemeral = new Map<string, IFrameMemoryEntry>();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFramePersistentMemoryService private readonly persistent: IFramePersistentMemoryService,
	) {
		super();
		this._register(this.persistent.onDidChange(() => this._onDidChange.fire()));
		void this.persistent.load();
	}

	get(id: string): IFrameMemoryEntry | undefined {
		return this._ephemeral.get(id) ?? mapPersistentToEntry(this.persistent.get(id));
	}

	async query(query: IFrameMemoryQuery): Promise<readonly IFrameMemoryEntry[]> {
		await this.persistent.load();
		const limit = query.limit ?? 50;
		const text = query.text?.toLowerCase();
		const results: IFrameMemoryEntry[] = [];

		const consider = (entry: IFrameMemoryEntry) => {
			if (query.scope !== undefined && entry.scope !== query.scope) {
				return;
			}
			if (query.workspaceId !== undefined && entry.workspaceId !== query.workspaceId) {
				return;
			}
			if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) {
				return;
			}
			if (query.tags?.length && !query.tags.every(t => entry.tags?.includes(t))) {
				return;
			}
			if (text && !`${entry.key} ${entry.value}`.toLowerCase().includes(text)) {
				return;
			}
			results.push(entry);
		};

		for (const entry of this._ephemeral.values()) {
			consider(entry);
			if (results.length >= limit) {
				return results;
			}
		}

		for (const record of this.persistent.list()) {
			const entry = mapPersistentToEntry(record);
			if (!entry) {
				continue;
			}
			consider(entry);
			if (results.length >= limit) {
				break;
			}
		}

		return results;
	}

	async upsert(partial: Omit<IFrameMemoryEntry, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): Promise<IFrameMemoryEntry> {
		await this.persistent.load();
		const now = Date.now();
		const id = partial.id || generateUuid();
		const tags = partial.tags ?? [];
		const durableKind = inferDurableKind(partial.scope, tags, partial.key);

		if (durableKind) {
			const record = await this.writeDurable(durableKind, id, partial, now);
			const entry = mapPersistentToEntry(record)!;
			this._onDidChange.fire();
			return entry;
		}

		const existing = this._ephemeral.get(id);
		const entry: IFrameMemoryEntry = {
			id,
			scope: partial.scope ?? FrameMemoryScope.Session,
			key: partial.key,
			value: partial.value,
			workspaceId: partial.workspaceId,
			sessionId: partial.sessionId,
			tags: partial.tags,
			createdAt: existing?.createdAt ?? partial.createdAt ?? now,
			updatedAt: now,
		};
		this._ephemeral.set(entry.id, entry);
		this._onDidChange.fire();
		return entry;
	}

	async delete(id: string): Promise<boolean> {
		const ephemeralOk = this._ephemeral.delete(id);
		const persistentOk = await this.persistent.delete(id);
		const ok = ephemeralOk || persistentOk;
		if (ok) {
			this._onDidChange.fire();
		}
		return ok;
	}

	async clear(scope?: IFrameMemoryQuery): Promise<number> {
		if (!scope) {
			const n = this._ephemeral.size + this.persistent.list().length;
			this._ephemeral.clear();
			for (const record of [...this.persistent.list()]) {
				await this.persistent.delete(record.id);
			}
			this._onDidChange.fire();
			return n;
		}
		const toDelete = await this.query({ ...scope, limit: Number.MAX_SAFE_INTEGER });
		for (const e of toDelete) {
			this._ephemeral.delete(e.id);
			await this.persistent.delete(e.id);
		}
		if (toDelete.length) {
			this._onDidChange.fire();
		}
		return toDelete.length;
	}

	private async writeDurable(
		kind: FramePersistentMemoryKind,
		id: string,
		partial: Omit<IFrameMemoryEntry, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number },
		now: number,
	): Promise<IFramePersistentMemoryRecord> {
		switch (kind) {
			case FramePersistentMemoryKind.Preference:
				return this.persistent.savePreference({
					id,
					preference: partial.value,
					language: tagValue(partial.tags, 'lang:') ?? tagValue(partial.tags, 'language:'),
					confidence: 0.6,
					observations: 1,
					accepted: 0,
					rejected: 0,
					tags: partial.tags,
					createdAt: partial.createdAt,
					updatedAt: now,
				});
			case FramePersistentMemoryKind.Decision:
				return this.persistent.saveDecision({
					id,
					decision: partial.value,
					rationale: partial.key !== 'decision' ? partial.key : undefined,
					tags: partial.tags,
					createdAt: partial.createdAt,
					updatedAt: now,
				});
			case FramePersistentMemoryKind.ConversationSummary:
				return this.persistent.saveConversationSummary({
					id,
					topic: partial.key,
					summary: partial.value,
					relatedFiles: [],
					sessionId: partial.sessionId,
					createdAt: partial.createdAt,
					updatedAt: now,
				});
			case FramePersistentMemoryKind.Project:
			default:
				return this.persistent.saveProject({
					id,
					title: partial.key,
					content: partial.value,
					category: inferProjectCategory(partial.tags, partial.key),
					tags: partial.tags,
					createdAt: partial.createdAt,
					updatedAt: now,
				});
		}
	}
}

export function mapPersistentToEntry(record: IFramePersistentMemoryRecord | undefined): IFrameMemoryEntry | undefined {
	if (!record) {
		return undefined;
	}
	switch (record.kind) {
		case FramePersistentMemoryKind.Project:
			return {
				id: record.id,
				scope: FrameMemoryScope.Workspace,
				key: record.title,
				value: record.content,
				tags: ['project', record.category, ...(record.tags ?? [])],
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			};
		case FramePersistentMemoryKind.Preference:
			return {
				id: record.id,
				scope: FrameMemoryScope.User,
				key: 'preference',
				value: record.preference,
				tags: ['preference', ...(record.language ? [`lang:${record.language}`] : []), ...(record.tags ?? [])],
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			};
		case FramePersistentMemoryKind.Decision:
			return {
				id: record.id,
				scope: FrameMemoryScope.Workspace,
				key: 'decision',
				value: record.decision,
				tags: ['decision', ...(record.tags ?? [])],
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			};
		case FramePersistentMemoryKind.ConversationSummary:
			return {
				id: record.id,
				scope: FrameMemoryScope.Session,
				key: record.topic,
				value: record.summary,
				sessionId: record.sessionId,
				tags: ['conversationSummary', 'summary'],
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			};
	}
}

function inferDurableKind(scope: FrameMemoryScope | undefined, tags: readonly string[], key: string): FramePersistentMemoryKind | undefined {
	// Preferences must go through observation Approve — never auto-write via upsert.
	if (tags.includes('preference') || scope === FrameMemoryScope.User || /pref|style|convention/i.test(key)) {
		return undefined;
	}
	if (tags.includes('decision')) {
		return FramePersistentMemoryKind.Decision;
	}
	if (tags.includes('conversationSummary') || tags.includes('summary')) {
		return FramePersistentMemoryKind.ConversationSummary;
	}
	if (tags.includes('project') || tags.includes('architecture') || tags.includes('convention') || tags.includes('technology')) {
		return FramePersistentMemoryKind.Project;
	}
	if (scope === FrameMemoryScope.Workspace) {
		return FramePersistentMemoryKind.Project;
	}
	return undefined;
}

function inferProjectCategory(tags: readonly string[] | undefined, key: string): 'info' | 'architecture' | 'technology' | 'convention' {
	if (tags?.includes('architecture') || /arch/i.test(key)) {
		return 'architecture';
	}
	if (tags?.includes('technology') || /tech|stack|library/i.test(key)) {
		return 'technology';
	}
	if (tags?.includes('convention') || /convention|style|format/i.test(key)) {
		return 'convention';
	}
	return 'info';
}

function tagValue(tags: readonly string[] | undefined, prefix: string): string | undefined {
	const hit = tags?.find(t => t.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : undefined;
}
