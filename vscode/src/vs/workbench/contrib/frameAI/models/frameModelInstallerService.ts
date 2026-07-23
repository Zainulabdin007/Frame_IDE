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
import {
	FrameEdition,
	FrameModelInstallStatus,
	IFrameEditionRecommendation,
	IFrameHardwareProfile,
	IFrameModelPackage,
} from '../common/models.js';
import { IFrameHardwareService } from '../hardware/frameHardware.js';
import { IFrameModelCompatibilityService } from '../hardware/frameModelCompatibility.js';
import { IFrameRuntimeService } from '../runtime/frameRuntime.js';
import {
	editionDisplayName,
	FRAME_PACKAGE_CHECKSUM_PLACEHOLDER,
	listFrameModelPackages,
	simulatedPackageLocalPath,
} from './frameModelPackage.js';
import { FRAME_MODEL_PROFILES, getFrameModelProfile, getFrameModelProfileByEdition } from './frameModelProfiles.js';
import { IFrameModelInstallerService } from './frameModelInstaller.js';
import { IFrameModelService } from './frameModels.js';

/**
 * Simulated installer — progresses lifecycle states without network I/O.
 * Updates model registry; writes PACKAGE.frame markers only.
 */
export class FrameModelInstallerService extends Disposable implements IFrameModelInstallerService {

	declare readonly _serviceBrand: undefined;

	private readonly _status = new Map<string, FrameModelInstallStatus>();
	private readonly _progress = new Map<string, number>();
	private readonly _paths = new Map<string, string | null>();
	private readonly _running = new Set<string>();

	private readonly _onDidChangePackages = this._register(new Emitter<readonly IFrameModelPackage[]>());
	readonly onDidChangePackages: Event<readonly IFrameModelPackage[]> = this._onDidChangePackages.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFrameModelService private readonly modelService: IFrameModelService,
		@IFrameHardwareService private readonly hardwareService: IFrameHardwareService,
		@IFrameModelCompatibilityService private readonly compatibilityService: IFrameModelCompatibilityService,
		@IFrameRuntimeService private readonly runtimeService: IFrameRuntimeService,
	) {
		super();
		this.hydrateFromRegistry();
		this._register(this.modelService.onDidChangeModels(() => {
			this.hydrateFromRegistry();
			this.fireChange();
		}));
	}

	listPackages(): readonly IFrameModelPackage[] {
		const packages = listFrameModelPackages(this._status, this._paths);
		return packages.map(pkg => {
			const progress = this._progress.get(pkg.id);
			return progress === undefined ? pkg : { ...pkg, progress };
		});
	}

	getPackage(id: string): IFrameModelPackage | undefined {
		return this.listPackages().find(p => p.id === id);
	}

	async installPackage(id: string): Promise<IFrameModelPackage> {
		const profile = getFrameModelProfile(id);
		if (!profile) {
			throw new Error(`Unknown model package: ${id}`);
		}
		if (this._running.has(profile.id)) {
			throw new Error(`Install already in progress for ${profile.id}`);
		}
		const current = this._status.get(profile.id) ?? FrameModelInstallStatus.Available;
		if (
			current === FrameModelInstallStatus.Verified
			|| current === FrameModelInstallStatus.Active
			|| current === FrameModelInstallStatus.Installed
		) {
			return (await this.verifyInstallation(profile.id)) ?? this.getPackage(profile.id)!;
		}

		this._running.add(profile.id);
		try {
			this.setStatus(profile.id, FrameModelInstallStatus.Downloading, 0);
			this.logService.info(`[FrameInstaller] Simulating install for ${profile.id} (no network download)`);

			await this.delay(180);
			this.setStatus(profile.id, FrameModelInstallStatus.Downloading, 35);
			await this.delay(180);
			this.setStatus(profile.id, FrameModelInstallStatus.Downloading, 70);
			await this.delay(120);

			const localPath = simulatedPackageLocalPath(profile.id);
			await this.writePackageMarker(profile.id, localPath);
			this._paths.set(profile.id, localPath);
			this.setStatus(profile.id, FrameModelInstallStatus.Installed, 100);

			await this.modelService.registerModel(profile.id, { localPath });
			const verified = await this.verifyInstallation(profile.id);
			this.logService.info(`[FrameInstaller] ${profile.id} → verified (marker only)`);
			return verified ?? this.getPackage(profile.id)!;
		} catch (err) {
			this.setStatus(profile.id, FrameModelInstallStatus.Failed, 0);
			throw err;
		} finally {
			this._running.delete(profile.id);
			this._progress.delete(profile.id);
			this.fireChange();
		}
	}

	async removePackage(id: string): Promise<boolean> {
		const profile = getFrameModelProfile(id);
		if (!profile) {
			return false;
		}
		await this.deletePackageMarker(profile.id);
		this._status.set(profile.id, FrameModelInstallStatus.Available);
		this._paths.set(profile.id, null);
		this._progress.delete(profile.id);
		await this.modelService.unregisterModel(profile.id);
		this.fireChange();
		this.logService.info(`[FrameInstaller] Removed package ${profile.id}`);
		return true;
	}

	async verifyInstallation(id: string): Promise<IFrameModelPackage | undefined> {
		const profile = getFrameModelProfile(id);
		if (!profile) {
			return undefined;
		}
		const path = this._paths.get(profile.id) ?? this.modelService.getModel(profile.id)?.localPath ?? null;
		const markerOk = path ? await this.markerExists(path) : false;
		const registered = !!this.modelService.getModel(profile.id)?.installed;

		if (!registered && !markerOk) {
			this.setStatus(profile.id, FrameModelInstallStatus.Available);
			return this.getPackage(profile.id);
		}

		if (!markerOk) {
			const localPath = path ?? simulatedPackageLocalPath(profile.id);
			await this.writePackageMarker(profile.id, localPath);
			this._paths.set(profile.id, localPath);
		}

		const activeId = this.modelService.getActiveModel()?.id;
		const next = activeId === profile.id ? FrameModelInstallStatus.Active : FrameModelInstallStatus.Verified;
		this.setStatus(profile.id, next, 100);
		if (!registered) {
			await this.modelService.registerModel(profile.id, { localPath: this._paths.get(profile.id) ?? null });
		}
		return this.getPackage(profile.id);
	}

	async activatePackage(id: string): Promise<IFrameModelPackage | undefined> {
		const verified = await this.verifyInstallation(id);
		if (!verified) {
			throw new Error(`Package ${id} is not installed/verified.`);
		}
		if (
			verified.status !== FrameModelInstallStatus.Verified
			&& verified.status !== FrameModelInstallStatus.Active
			&& verified.status !== FrameModelInstallStatus.Installed
		) {
			throw new Error(`Package ${id} is not installed/verified.`);
		}
		await this.runtimeService.updateConfig({ activeModelId: verified.id });
		this.setStatus(verified.id, FrameModelInstallStatus.Active, 100);
		for (const pkg of this.listPackages()) {
			if (pkg.id !== verified.id && pkg.status === FrameModelInstallStatus.Active) {
				this._status.set(pkg.id, FrameModelInstallStatus.Verified);
			}
		}
		this.fireChange();
		return this.getPackage(verified.id);
	}

	async recommendBestEdition(): Promise<IFrameEditionRecommendation> {
		const hardware = await this.hardwareService.detect();
		const results = await this.compatibilityService.evaluateAll(hardware);
		const byId = new Map(results.map(r => [r.modelId, r]));

		const order: FrameEdition[] = [FrameEdition.Maximum, FrameEdition.Professional, FrameEdition.Efficient];
		for (const edition of order) {
			const profile = getFrameModelProfileByEdition(edition);
			if (!profile) {
				continue;
			}
			const compat = byId.get(profile.id);
			if (compat?.status === 'compatible') {
				return this.buildRecommendation(edition, profile.id, hardware, compat.message);
			}
		}
		for (const edition of order) {
			const profile = getFrameModelProfileByEdition(edition);
			if (!profile) {
				continue;
			}
			const compat = byId.get(profile.id);
			if (compat?.status === 'warning') {
				return this.buildRecommendation(edition, profile.id, hardware, compat.message);
			}
		}

		const fallback = getFrameModelProfileByEdition(FrameEdition.Efficient)!;
		return this.buildRecommendation(
			FrameEdition.Efficient,
			fallback.id,
			hardware,
			'Defaulting to Frame Efficient on this hardware.',
		);
	}

	recommendBestEditionForEdition(edition: FrameEdition): IFrameEditionRecommendation | undefined {
		const profile = getFrameModelProfileByEdition(edition);
		if (!profile) {
			return undefined;
		}
		const hardware = this.hardwareService.getCachedProfile();
		const reason = hardware
			? this.compatibilityService.evaluate(profile, hardware).message
			: 'Hardware not detected yet.';
		return {
			edition,
			modelId: profile.id,
			displayName: editionDisplayName(edition),
			reason,
			hardwareSummary: hardware
				? `${hardware.osLabel}, ${hardware.ramGB} GB RAM`
				: 'Unknown hardware',
		};
	}

	private buildRecommendation(
		edition: FrameEdition,
		modelId: string,
		hardware: IFrameHardwareProfile,
		reason: string,
	): IFrameEditionRecommendation {
		return {
			edition,
			modelId,
			displayName: editionDisplayName(edition),
			reason,
			hardwareSummary: `${hardware.osLabel}, ${hardware.ramGB} GB RAM` +
				(hardware.gpuAvailable ? `, GPU${hardware.gpuMemoryGB ? ` ~${hardware.gpuMemoryGB} GB` : ''}` : ''),
		};
	}

	private hydrateFromRegistry(): void {
		for (const profile of FRAME_MODEL_PROFILES) {
			const model = this.modelService.getModel(profile.id);
			if (!model) {
				continue;
			}
			if (model.active) {
				this._status.set(profile.id, FrameModelInstallStatus.Active);
			} else if (model.installed) {
				const existing = this._status.get(profile.id);
				if (existing !== FrameModelInstallStatus.Downloading && existing !== FrameModelInstallStatus.Failed) {
					this._status.set(
						profile.id,
						existing === FrameModelInstallStatus.Verified || existing === FrameModelInstallStatus.Active
							? existing
							: FrameModelInstallStatus.Verified,
					);
				}
			} else if (!this._running.has(profile.id)) {
				this._status.set(profile.id, FrameModelInstallStatus.Available);
			}
			if (model.localPath) {
				this._paths.set(profile.id, model.localPath);
			}
		}
	}

	private setStatus(id: string, status: FrameModelInstallStatus, progress?: number): void {
		this._status.set(id, status);
		if (progress !== undefined) {
			this._progress.set(id, progress);
		}
		this.fireChange();
	}

	private fireChange(): void {
		this._onDidChangePackages.fire(this.listPackages());
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async writePackageMarker(modelId: string, relativePath: string): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const uri = joinPath(folder, relativePath);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'models'));
		await this.ensureDir(joinPath(folder, '.frame', 'models', 'packages'));
		await this.ensureDir(joinPath(folder, '.frame', 'models', 'packages', modelId));
		const body = {
			format: 'frame-model-package-marker',
			version: 1,
			id: modelId,
			checksumPlaceholder: FRAME_PACKAGE_CHECKSUM_PLACEHOLDER,
			note: 'Simulated install — no model weights. Future offline installer replaces this marker.',
			createdAt: Date.now(),
		};
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(body, null, 2) + '\n'));
	}

	private async markerExists(relativePath: string): Promise<boolean> {
		const folder = this.primaryFolder();
		if (!folder) {
			return false;
		}
		try {
			return await this.fileService.exists(joinPath(folder, relativePath));
		} catch {
			return false;
		}
	}

	private async deletePackageMarker(modelId: string): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const dir = joinPath(folder, '.frame', 'models', 'packages', modelId);
		try {
			await this.fileService.del(dir, { recursive: true, useTrash: false });
		} catch {
			// ignore
		}
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
