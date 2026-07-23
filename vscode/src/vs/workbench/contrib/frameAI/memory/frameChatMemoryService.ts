/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ensureFrameDotGitignore, truncateForLocalPersistence } from '../common/frameWorkspaceIgnore.js';
import {
	IFrameChatConversationFile,
	IFrameChatMemoryService,
	IFrameChatTurnRecord,
} from './frameChatMemory.js';

/** Cap persisted prompt/response text to limit secret / PII leakage via `.frame/`. */
const MAX_TURN_FIELD_CHARS = 4_000;

/**
 * Persists chat turns under `.frame/memory/chat/` for UI resume (streaming).
 * Durable memory / context engine still use conversation *summaries* only —
 * raw transcripts are never mixed into preference or project memory search.
 * Fields are truncated and `.frame/` is gitignored.
 */
export class FrameChatMemoryService extends Disposable implements IFrameChatMemoryService {

	declare readonly _serviceBrand: undefined;

	private _activeId: string | null = null;
	private _cache: IFrameChatConversationFile | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._activeId = null;
			this._cache = undefined;
			this.logService.info('[FrameChat] Cleared active conversation after workspace folder change');
		}));
	}

	getActiveConversationId(): string | null {
		return this._activeId;
	}

	async startConversation(): Promise<string> {
		const id = generateUuid();
		const workspaceId = this.workspaceId();
		const now = Date.now();
		this._activeId = id;
		this._cache = {
			id,
			createdAt: now,
			updatedAt: now,
			workspaceId,
			turns: [],
		};
		await this.persist(this._cache);
		this.logService.info(`[FrameChat] Started conversation ${id}`);
		return id;
	}

	async clearConversation(): Promise<void> {
		this._activeId = null;
		this._cache = undefined;
		this.logService.info('[FrameChat] Cleared active conversation (files retained on disk)');
	}

	async appendTurn(turn: Omit<IFrameChatTurnRecord, 'timestamp'> & { readonly timestamp?: number }): Promise<IFrameChatConversationFile> {
		if (!this._activeId || !this._cache) {
			await this.startConversation();
		}
		const file = this._cache!;
		const record: IFrameChatTurnRecord = {
			...turn,
			prompt: truncateForLocalPersistence(turn.prompt ?? '', MAX_TURN_FIELD_CHARS),
			response: truncateForLocalPersistence(turn.response ?? '', MAX_TURN_FIELD_CHARS),
			timestamp: turn.timestamp ?? Date.now(),
		};
		const next: IFrameChatConversationFile = {
			...file,
			updatedAt: Date.now(),
			turns: [...file.turns, record],
		};
		this._cache = next;
		await this.persist(next);
		return next;
	}

	private async persist(file: IFrameChatConversationFile): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const dir = joinPath(folder, '.frame', 'memory', 'chat');
		await this.ensureDir(joinPath(folder, '.frame'));
		await ensureFrameDotGitignore(this.fileService, folder);
		await this.ensureDir(joinPath(folder, '.frame', 'memory'));
		await this.ensureDir(dir);
		const uri = joinPath(dir, `${file.id}.json`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(file, null, 2) + '\n'));
	}

	private workspaceId(): string | null {
		const ws = this.workspaceService.getWorkspace();
		return ws.id || ws.folders[0]?.uri.toString() || null;
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}
