/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFrameModelPublicKeyRecord } from '../common/models.js';

export const IFrameModelKeyStore = createDecorator<IFrameModelKeyStore>('frameModelKeyStore');

/**
 * Local public-key store under `.frame/models/keys/`.
 * Never downloads keys — users import public keys they already own.
 */
export interface IFrameModelKeyStore {
	readonly _serviceBrand: undefined;

	readonly onDidChangeKeys: Event<readonly IFrameModelPublicKeyRecord[]>;

	listKeys(): readonly IFrameModelPublicKeyRecord[];

	getKey(keyId: string): IFrameModelPublicKeyRecord | undefined;

	importKey(input: {
		keyId: string;
		publicKey: string;
		owner?: string;
		note?: string;
	}): Promise<IFrameModelPublicKeyRecord>;

	removeKey(keyId: string): Promise<boolean>;

	refresh(): Promise<void>;
}

const KEYS_REL = '.frame/models/keys';

/**
 * Persists Ed25519 public keys as JSON files — no private keys, no network.
 */
export class FrameModelKeyStore extends Disposable implements IFrameModelKeyStore {

	declare readonly _serviceBrand: undefined;

	private readonly _keys = new Map<string, IFrameModelPublicKeyRecord>();
	private _ready: Promise<void>;

	private readonly _onDidChangeKeys = this._register(new Emitter<readonly IFrameModelPublicKeyRecord[]>());
	readonly onDidChangeKeys: Event<readonly IFrameModelPublicKeyRecord[]> = this._onDidChangeKeys.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._ready = this.refresh();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._ready = this.refresh();
		}));
	}

	listKeys(): readonly IFrameModelPublicKeyRecord[] {
		return [...this._keys.values()].sort((a, b) => a.keyId.localeCompare(b.keyId));
	}

	getKey(keyId: string): IFrameModelPublicKeyRecord | undefined {
		return this._keys.get(keyId);
	}

	async importKey(input: {
		keyId: string;
		publicKey: string;
		owner?: string;
		note?: string;
	}): Promise<IFrameModelPublicKeyRecord> {
		await this._ready;
		const keyId = sanitizeKeyId(input.keyId);
		if (!keyId) {
			throw new Error('keyId is required.');
		}
		const publicKey = String(input.publicKey || '').replace(/\s+/g, '');
		if (!publicKey) {
			throw new Error('publicKey is required (base64 SPKI).');
		}
		const record: IFrameModelPublicKeyRecord = {
			keyId,
			algorithm: 'ed25519',
			owner: String(input.owner || 'local').trim() || 'local',
			publicKey,
			createdAt: Date.now(),
			note: input.note,
		};
		await this.writeKey(record);
		this._keys.set(keyId, record);
		this._onDidChangeKeys.fire(this.listKeys());
		this.logService.info(`[FrameKeys] Imported public key ${keyId} (ed25519, local only)`);
		return record;
	}

	async removeKey(keyId: string): Promise<boolean> {
		await this._ready;
		const id = sanitizeKeyId(keyId);
		if (!this._keys.has(id)) {
			return false;
		}
		const folder = this.primaryFolder();
		if (folder) {
			const uri = joinPath(folder, KEYS_REL, `${id}.json`);
			try {
				await this.fileService.del(uri);
			} catch {
				// ignore
			}
		}
		this._keys.delete(id);
		this._onDidChangeKeys.fire(this.listKeys());
		this.logService.info(`[FrameKeys] Removed public key ${id}`);
		return true;
	}

	async refresh(): Promise<void> {
		this._keys.clear();
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const dir = joinPath(folder, KEYS_REL);
		try {
			if (!(await this.fileService.exists(dir))) {
				return;
			}
			const stat = await this.fileService.resolve(dir);
			for (const child of stat.children ?? []) {
				if (!child.isFile || !child.name.endsWith('.json')) {
					continue;
				}
				try {
					const buf = await this.fileService.readFile(child.resource);
					const parsed = JSON.parse(buf.value.toString()) as Partial<IFrameModelPublicKeyRecord>;
					if (!parsed.keyId || !parsed.publicKey || parsed.algorithm !== 'ed25519') {
						continue;
					}
					const record: IFrameModelPublicKeyRecord = {
						keyId: String(parsed.keyId),
						algorithm: 'ed25519',
						owner: String(parsed.owner || 'local'),
						publicKey: String(parsed.publicKey).replace(/\s+/g, ''),
						createdAt: Number(parsed.createdAt) || Date.now(),
						note: parsed.note ? String(parsed.note) : undefined,
					};
					this._keys.set(record.keyId, record);
				} catch {
					// skip bad file
				}
			}
		} catch {
			// no keys dir
		}
		this._onDidChangeKeys.fire(this.listKeys());
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async writeKey(record: IFrameModelPublicKeyRecord): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			throw new Error('Open a workspace folder before importing keys.');
		}
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'models'));
		await this.ensureDir(joinPath(folder, KEYS_REL));
		const uri = joinPath(folder, KEYS_REL, `${record.keyId}.json`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(record, null, 2) + '\n'));
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}

function sanitizeKeyId(raw: string): string {
	return String(raw || '')
		.trim()
		.replace(/[^a-zA-Z0-9._-]/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 128);
}
