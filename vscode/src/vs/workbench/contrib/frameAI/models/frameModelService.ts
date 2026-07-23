/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	FrameEdition,
	FrameModelCompatibilityStatus,
	FrameModelTrustStatus,
	IFrameModelCompatibilityRequest,
	IFrameModelCompatibilityResult,
	IFrameModelDescriptor,
	IFrameModelProfile,
	IFrameModelRegistryFile,
	IFrameModelRegistrySignature,
} from '../common/models.js';
import { IFrameModelCompatibilityService } from '../hardware/frameModelCompatibility.js';
import { IFrameHardwareService } from '../hardware/frameHardware.js';
import { FRAME_MODEL_PROFILES, getFrameModelProfile, getFrameModelProfileByEdition, resolveFrameModelId } from './frameModelProfiles.js';
import { IFrameModelService } from './frameModels.js';

const REGISTRY_VERSION = 4;
const REGISTRY_REL = '.frame/models/registry.json';

interface IInstalledRecord {
	readonly id: string;
	readonly installed: boolean;
	readonly localPath: string | null;
	readonly compatibilityStatus?: FrameModelCompatibilityStatus;
	readonly compatibilityMessage?: string;
	readonly packageVersion?: string;
	readonly checksum?: string;
	readonly trustStatus?: FrameModelTrustStatus;
	readonly signature?: IFrameModelRegistrySignature;
	readonly registeredAt?: number;
	readonly updatedAt?: number;
}

/**
 * Persists installed model metadata under `.frame/models/registry.json`.
 * Never downloads or loads weights.
 */
export class FrameModelService extends Disposable implements IFrameModelService {

	declare readonly _serviceBrand: undefined;

	private _installed = new Map<string, IInstalledRecord>();
	private _activeModelId: string | null = null;
	private _ready: Promise<void>;

	private readonly _onDidChangeModels = this._register(new Emitter<readonly IFrameModelDescriptor[]>());
	readonly onDidChangeModels: Event<readonly IFrameModelDescriptor[]> = this._onDidChangeModels.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@IFrameHardwareService private readonly hardwareService: IFrameHardwareService,
		@IFrameModelCompatibilityService private readonly compatibilityService: IFrameModelCompatibilityService,
	) {
		super();
		this._ready = this.refresh();
		this._register(this.hardwareService.onDidChangeHardware(() => {
			void this.refreshCompatibility();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			// Callers await `_ready` — retarget so they wait for the new workspace registry.
			this._ready = this.refresh();
		}));
	}

	listProfiles(): readonly IFrameModelProfile[] {
		return FRAME_MODEL_PROFILES;
	}

	getProfile(id: string): IFrameModelProfile | undefined {
		return getFrameModelProfile(id);
	}

	getProfileByEdition(edition: FrameEdition): IFrameModelProfile | undefined {
		return getFrameModelProfileByEdition(edition);
	}

	async registerModel(id: string, options?: {
		localPath?: string | null;
		packageVersion?: string;
		checksum?: string;
		trustStatus?: FrameModelTrustStatus;
		signature?: IFrameModelRegistrySignature;
	}): Promise<IFrameModelDescriptor> {
		await this._ready;
		const resolved = resolveFrameModelId(id);
		const profile = getFrameModelProfile(resolved);
		if (!profile) {
			throw new Error(`Unknown model profile: ${id}`);
		}
		const now = Date.now();
		const existing = this._installed.get(resolved);
		const compat = await this.compatibilityService.evaluateById(resolved);
		const record: IInstalledRecord = {
			id: resolved,
			installed: true,
			localPath: options?.localPath !== undefined ? options.localPath : (existing?.localPath ?? null),
			compatibilityStatus: compat.status,
			compatibilityMessage: compat.message,
			packageVersion: options?.packageVersion !== undefined ? options.packageVersion : existing?.packageVersion,
			checksum: options?.checksum !== undefined ? options.checksum : existing?.checksum,
			trustStatus: options?.trustStatus !== undefined ? options.trustStatus : (existing?.trustStatus ?? FrameModelTrustStatus.Unverified),
			signature: options?.signature !== undefined ? options.signature : existing?.signature,
			registeredAt: existing?.registeredAt ?? now,
			updatedAt: now,
		};
		this._installed.set(resolved, record);
		if (!this._activeModelId) {
			this._activeModelId = resolved;
		}
		await this.persistRegistry();
		this._onDidChangeModels.fire(this.listModels());
		this.logService.info(`[FrameModels] Registered ${resolved} (metadata only — no weights downloaded)`);
		return this.toDescriptor(profile, record);
	}

	listInstalledModels(): readonly IFrameModelDescriptor[] {
		return this.listModels().filter(m => m.installed);
	}

	listModels(): readonly IFrameModelDescriptor[] {
		return FRAME_MODEL_PROFILES.map(profile => {
			const record = this._installed.get(profile.id);
			return this.toDescriptor(profile, record);
		});
	}

	getModel(id: string): IFrameModelDescriptor | undefined {
		const resolved = resolveFrameModelId(id);
		return this.listModels().find(m => m.id === resolved);
	}

	getActiveModel(): IFrameModelDescriptor | undefined {
		if (!this._activeModelId) {
			return undefined;
		}
		return this.getModel(this._activeModelId);
	}

	async selectActiveModel(id: string): Promise<IFrameModelDescriptor | undefined> {
		await this._ready;
		const resolved = resolveFrameModelId(id);
		const profile = getFrameModelProfile(resolved);
		if (!profile) {
			return undefined;
		}
		if (!this._installed.get(resolved)?.installed) {
			await this.registerModel(resolved);
		}
		this._activeModelId = resolved;
		const record = this._installed.get(resolved)!;
		this._installed.set(resolved, { ...record, updatedAt: Date.now() });
		await this.persistRegistry();
		this._onDidChangeModels.fire(this.listModels());
		this.logService.info(`[FrameModels] Active model → ${resolved} (not loaded)`);
		return this.getActiveModel();
	}

	async setModelLocalPath(id: string, localPath: string | null): Promise<IFrameModelDescriptor | undefined> {
		await this._ready;
		const resolved = resolveFrameModelId(id);
		if (!getFrameModelProfile(resolved)) {
			return undefined;
		}
		const existing = this._installed.get(resolved);
		if (!existing?.installed) {
			await this.registerModel(resolved, { localPath });
			return this.getModel(resolved);
		}
		this._installed.set(resolved, {
			...existing,
			localPath,
			updatedAt: Date.now(),
		});
		await this.persistRegistry();
		this._onDidChangeModels.fire(this.listModels());
		return this.getModel(resolved);
	}

	async unregisterModel(id: string): Promise<boolean> {
		await this._ready;
		const resolved = resolveFrameModelId(id);
		if (!this._installed.has(resolved)) {
			return false;
		}
		this._installed.delete(resolved);
		if (this._activeModelId === resolved) {
			const next = [...this._installed.values()].find(r => r.installed);
			this._activeModelId = next?.id ?? null;
		}
		await this.persistRegistry();
		this._onDidChangeModels.fire(this.listModels());
		this.logService.info(`[FrameModels] Unregistered ${resolved}`);
		return true;
	}

	checkCompatibility(id: string, request?: IFrameModelCompatibilityRequest): IFrameModelCompatibilityResult {
		const resolved = resolveFrameModelId(id);
		const profile = getFrameModelProfile(resolved);
		if (!profile) {
			return {
				modelId: resolved,
				status: 'unsupported',
				compatible: false,
				reasons: ['Unknown model profile.'],
				message: 'Unknown model profile',
			};
		}
		const hardware = request?.hardware ?? this.hardwareService.getCachedProfile();
		if (hardware) {
			return this.compatibilityService.evaluate(profile, hardware);
		}
		// Sync path without hardware yet — defer to memory-only request fields.
		const reasons: string[] = [];
		if (request?.maxMemoryGb !== undefined && profile.memoryRequirementGb > request.maxMemoryGb) {
			reasons.push(`Memory requirement ${profile.memoryRequirementGb} GB exceeds limit ${request.maxMemoryGb} GB.`);
		}
		if (request?.runtimeKind && request.runtimeKind !== 'none' && request.runtimeKind !== 'stub') {
			if (!profile.compatibleRuntimes.includes(request.runtimeKind)) {
				reasons.push(`Runtime ${request.runtimeKind} is not listed as compatible.`);
			}
		}
		const status: FrameModelCompatibilityStatus = reasons.length ? 'unsupported' : 'unknown';
		return {
			modelId: resolved,
			status,
			compatible: status !== 'unsupported',
			reasons: reasons.length ? reasons : ['Hardware not detected yet.'],
			message: reasons[0] ?? 'Hardware not detected yet',
		};
	}

	async refresh(): Promise<void> {
		await this.loadRegistry();
		await this.ensureRegistryFile();
		await this.refreshCompatibility();
		this._onDidChangeModels.fire(this.listModels());
	}

	private async refreshCompatibility(): Promise<void> {
		const hardware = await this.hardwareService.detect();
		let changed = false;
		for (const profile of FRAME_MODEL_PROFILES) {
			const result = this.compatibilityService.evaluate(profile, hardware);
			const existing = this._installed.get(profile.id);
			if (existing?.installed) {
				if (existing.compatibilityStatus !== result.status || existing.compatibilityMessage !== result.message) {
					this._installed.set(profile.id, {
						...existing,
						compatibilityStatus: result.status,
						compatibilityMessage: result.message,
						updatedAt: Date.now(),
					});
					changed = true;
				}
			}
		}
		if (changed) {
			await this.persistRegistry();
			this._onDidChangeModels.fire(this.listModels());
		}
	}

	private toDescriptor(profile: IFrameModelProfile, record: IInstalledRecord | undefined): IFrameModelDescriptor {
		const cachedHw = this.hardwareService.getCachedProfile();
		const live = cachedHw
			? this.compatibilityService.evaluate(profile, cachedHw)
			: undefined;
		return {
			...profile,
			installed: !!record?.installed,
			active: this._activeModelId === profile.id,
			localPath: record?.localPath ?? null,
			compatibilityStatus: live?.status ?? record?.compatibilityStatus ?? 'unknown',
			compatibilityMessage: live?.message ?? record?.compatibilityMessage,
			packageVersion: record?.packageVersion,
			checksum: record?.checksum,
			trustStatus: record?.trustStatus ?? FrameModelTrustStatus.Unverified,
			signature: record?.signature,
			registeredAt: record?.registeredAt,
			updatedAt: record?.updatedAt,
		};
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private registryCandidateUris(): URI[] {
		const out: URI[] = [];
		const folder = this.primaryFolder();
		if (folder) {
			out.push(joinPath(folder, '.frame', 'models', 'registry.json'));
		}
		const home = this.pathService.userHome({ preferLocal: true });
		out.push(joinPath(home, '.frame', 'models', 'registry.json'));
		return out;
	}

	private registryUri(): URI | undefined {
		return this.registryCandidateUris()[0];
	}

	private async loadRegistry(): Promise<void> {
		this._installed.clear();
		this._activeModelId = null;
		for (const uri of this.registryCandidateUris()) {
			try {
				if (!(await this.fileService.exists(uri))) {
					continue;
				}
				const buf = await this.fileService.readFile(uri);
				const parsed = JSON.parse(buf.value.toString()) as IFrameModelRegistryFile;
				this._activeModelId = parsed.activeModelId ? resolveFrameModelId(parsed.activeModelId) : null;
				for (const entry of parsed.models ?? []) {
					const id = resolveFrameModelId(entry.id);
					if (!getFrameModelProfile(id)) {
						continue;
					}
					this._installed.set(id, {
						id,
						installed: entry.installed !== false,
						localPath: entry.localPath ?? null,
						compatibilityStatus: entry.compatibilityStatus,
						compatibilityMessage: entry.compatibilityMessage,
						packageVersion: entry.packageVersion,
						checksum: entry.checksum ?? entry.checksumPlaceholder,
						trustStatus: normalizeTrustStatus(entry.trustStatus) ?? FrameModelTrustStatus.Unverified,
						signature: entry.signature,
						registeredAt: entry.registeredAt,
						updatedAt: entry.updatedAt,
					});
				}
				this.logService.info(`[FrameModels] Loaded registry from ${uri.fsPath} active=${this._activeModelId ?? '(none)'}`);
				return;
			} catch {
				// try next candidate
			}
		}
	}

	private async ensureRegistryFile(): Promise<void> {
		const uri = this.registryUri();
		if (!uri) {
			return;
		}
		if (await this.fileService.exists(uri)) {
			return;
		}
		await this.persistRegistry();
	}

	private async persistRegistry(): Promise<void> {
		const folder = this.primaryFolder();
		const uri = this.registryUri();
		if (!folder || !uri) {
			return;
		}
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'models'));
		await this.ensureGitignore(folder);

		const body: IFrameModelRegistryFile = {
			version: REGISTRY_VERSION,
			activeModelId: this._activeModelId,
			updatedAt: Date.now(),
			models: [...this._installed.values()].map(r => ({
				id: r.id,
				installed: r.installed,
				localPath: r.localPath,
				compatibilityStatus: r.compatibilityStatus,
				compatibilityMessage: r.compatibilityMessage,
				packageVersion: r.packageVersion,
				checksum: r.checksum,
				trustStatus: r.trustStatus ?? FrameModelTrustStatus.Unverified,
				signature: r.signature,
				registeredAt: r.registeredAt,
				updatedAt: r.updatedAt,
			})),
		};
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(body, null, 2) + '\n'));
		this.logService.trace(`[FrameModels] Wrote ${REGISTRY_REL}`);
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
		} catch {
			// ignore
		}
	}
}

function normalizeTrustStatus(value: unknown): FrameModelTrustStatus | undefined {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const upper = value.trim().toUpperCase();
	switch (upper) {
		case FrameModelTrustStatus.Unverified:
		case FrameModelTrustStatus.ChecksumValid:
		case FrameModelTrustStatus.SignatureValid:
		case FrameModelTrustStatus.Invalid:
			return upper as FrameModelTrustStatus;
		default:
			return FrameModelTrustStatus.Unverified;
	}
}
