/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IFrameConversationSummary,
	IFrameDecisionMemory,
	IFrameMemoryExportBundle,
	IFramePersistentMemoryRecord,
	IFrameProjectMemory,
	IFrameUserPreference,
} from '../common/models.js';

export const FRAME_MEMORY_STORE_VERSION = 1;

export interface IFrameMemoryStoreMeta {
	readonly version: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly folder: string;
	readonly counts: {
		readonly project: number;
		readonly preferences: number;
		readonly decisions: number;
		readonly conversationSummaries: number;
	};
}

export interface IFrameMemoryDiskSnapshot {
	readonly meta: IFrameMemoryStoreMeta;
	readonly project: IFrameProjectMemory[];
	readonly preferences: IFrameUserPreference[];
	readonly decisions: IFrameDecisionMemory[];
	readonly conversationSummaries: IFrameConversationSummary[];
}

export class FrameMemoryDiskStore {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	memoryRoot(folder: URI): URI {
		return joinPath(folder, '.frame', 'memory');
	}

	async load(folder: URI): Promise<IFrameMemoryDiskSnapshot | undefined> {
		const root = this.memoryRoot(folder);
		try {
			const metaBuf = await this.fileService.readFile(joinPath(root, 'meta.json'));
			const meta = JSON.parse(metaBuf.value.toString()) as IFrameMemoryStoreMeta;
			const project = await this.readJsonl<IFrameProjectMemory>(joinPath(root, 'project.jsonl'));
			const preferences = await this.readPreferences(root);
			const decisions = await this.readJsonl<IFrameDecisionMemory>(joinPath(root, 'decisions.jsonl'));
			const conversationSummaries = await this.readJsonl<IFrameConversationSummary>(joinPath(root, 'conversation-summaries.jsonl'));
			return { meta, project, preferences, decisions, conversationSummaries };
		} catch {
			return undefined;
		}
	}

	async save(folder: URI, snapshot: Omit<IFrameMemoryDiskSnapshot, 'meta'> & { meta?: Partial<IFrameMemoryStoreMeta> }): Promise<IFrameMemoryStoreMeta> {
		const root = this.memoryRoot(folder);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(root);
		await this.ensureGitignore(folder);

		const now = Date.now();
		const meta: IFrameMemoryStoreMeta = {
			version: FRAME_MEMORY_STORE_VERSION,
			createdAt: snapshot.meta?.createdAt ?? now,
			updatedAt: now,
			folder: folder.toString(true),
			counts: {
				project: snapshot.project.length,
				preferences: snapshot.preferences.length,
				decisions: snapshot.decisions.length,
				conversationSummaries: snapshot.conversationSummaries.length,
			},
		};

		await this.fileService.writeFile(joinPath(root, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
		await this.writeJsonl(joinPath(root, 'project.jsonl'), snapshot.project);
		// Canonical preferences file for Preference Observation Engine
		await this.fileService.writeFile(
			joinPath(root, 'preferences.json'),
			VSBuffer.fromString(JSON.stringify(snapshot.preferences, null, 2) + '\n'),
		);
		await this.writeJsonl(joinPath(root, 'preferences.jsonl'), snapshot.preferences);
		await this.writeJsonl(joinPath(root, 'decisions.jsonl'), snapshot.decisions);
		await this.writeJsonl(joinPath(root, 'conversation-summaries.jsonl'), snapshot.conversationSummaries);

		this.logService.trace(`[FrameMemory] Persisted to ${root.toString()}`);
		return meta;
	}

	toExportBundle(folder: URI | undefined, snapshot: IFrameMemoryDiskSnapshot): IFrameMemoryExportBundle {
		return {
			version: FRAME_MEMORY_STORE_VERSION,
			exportedAt: Date.now(),
			folder: folder?.toString(true),
			project: snapshot.project,
			preferences: snapshot.preferences,
			decisions: snapshot.decisions,
			conversationSummaries: snapshot.conversationSummaries,
		};
	}

	private async readPreferences(root: URI): Promise<IFrameUserPreference[]> {
		try {
			const buf = await this.fileService.readFile(joinPath(root, 'preferences.json'));
			const parsed = JSON.parse(buf.value.toString()) as IFrameUserPreference[];
			if (Array.isArray(parsed)) {
				return parsed;
			}
		} catch {
			// fall through to jsonl
		}
		return this.readJsonl<IFrameUserPreference>(joinPath(root, 'preferences.jsonl'));
	}

	private async readJsonl<T>(uri: URI): Promise<T[]> {
		try {
			const buf = await this.fileService.readFile(uri);
			return buf.value.toString()
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.map(line => JSON.parse(line) as T);
		} catch {
			return [];
		}
	}

	private async writeJsonl(uri: URI, rows: readonly IFramePersistentMemoryRecord[]): Promise<void> {
		const body = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
		await this.fileService.writeFile(uri, VSBuffer.fromString(body));
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
			if (!(await this.fileService.exists(gi))) {
				await this.fileService.writeFile(gi, VSBuffer.fromString('*\n'));
			}
		} catch (err) {
			this.logService.trace('[FrameMemory] could not write .frame/.gitignore', err);
		}
	}
}
