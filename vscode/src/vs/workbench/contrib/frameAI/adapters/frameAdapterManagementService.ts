/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	FrameAdapterScope,
	FrameAdapterState,
	IFrameAdapterDescriptor,
	IFrameAdapterExportPackage,
	IFrameAdapterMetadata,
} from '../common/models.js';
import { FRAME_ADAPTER_PACKAGE_VERSION } from './frameAdapterService.js';
import { IFrameAdapterService } from './frameAdapters.js';
import { isFrameBuiltinAdapter } from './frameBuiltinAdapters.js';
import {
	IFrameAdapterDetails,
	IFrameAdapterGroups,
	IFrameAdapterListItem,
	IFrameAdapterManagementService,
	IFrameAdapterPackageValidation,
} from './frameAdapterManagement.js';

const IMPORTED_TAG = 'imported';

export class FrameAdapterManagementService extends Disposable implements IFrameAdapterManagementService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFrameAdapterService private readonly adapters: IFrameAdapterService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.adapters.onDidChangeAdapters(() => this._onDidChange.fire()));
	}

	getGroupedAdapters(): IFrameAdapterGroups {
		const items = this.adapters.listAdapters().map(d => this.toListItem(d));
		const active = items.filter(i => i.descriptor.state === FrameAdapterState.Active);
		const imported = items.filter(i => i.imported);
		const available = items.filter(i =>
			i.descriptor.state !== FrameAdapterState.Active
			&& i.descriptor.state !== FrameAdapterState.Failed
			&& !i.imported
		);
		return { active, available, imported };
	}

	async getDetails(id: string): Promise<IFrameAdapterDetails | undefined> {
		const descriptor = this.adapters.getAdapter(id);
		if (!descriptor) {
			return undefined;
		}
		const metadata = await this.adapters.loadMetadata(id) ?? descriptorToFallbackMetadata(descriptor);
		const compatibility = this.adapters.checkCompatibility(id, {
			language: descriptor.language,
			baseModelId: descriptor.baseModelId,
			minAdapterVersion: '0.0.0',
		});
		const weightUri = await this.adapters.resolveWeightUri(id);
		return {
			descriptor,
			metadata,
			compatibility,
			weightsLinked: !!descriptor.weightsLinked || !!weightUri,
			weightAbsolutePath: weightUri?.fsPath,
			weightBytes: descriptor.weightBytes,
		};
	}

	async activate(id: string): Promise<IFrameAdapterDescriptor | undefined> {
		const next = await this.adapters.setAdapterState(id, FrameAdapterState.Active);
		if (next) {
			this.logService.info(`[FrameAdapterUI] Activated ${id}`);
		}
		return next;
	}

	async deactivate(id: string): Promise<IFrameAdapterDescriptor | undefined> {
		const existing = this.adapters.getAdapter(id);
		if (isFrameBuiltinAdapter(existing)) {
			this.logService.info(`[FrameAdapterUI] Builtin ${id} stays active`);
			return existing;
		}
		const next = await this.adapters.setAdapterState(id, FrameAdapterState.Available);
		if (next) {
			this.logService.info(`[FrameAdapterUI] Deactivated ${id}`);
		}
		return next;
	}

	async remove(id: string): Promise<boolean> {
		const existing = this.adapters.getAdapter(id);
		if (isFrameBuiltinAdapter(existing)) {
			this.logService.warn(`[FrameAdapterUI] Cannot remove builtin adapter ${id}`);
			return false;
		}
		const ok = await this.adapters.removeAdapter(id);
		if (ok) {
			this.logService.info(`[FrameAdapterUI] Removed ${id}`);
		}
		return ok;
	}

	async exportAdapter(id: string): Promise<IFrameAdapterExportPackage | undefined> {
		return this.adapters.exportAdapter(id);
	}

	validatePackageJson(raw: string): IFrameAdapterPackageValidation {
		const trimmed = raw.trim();
		if (!trimmed) {
			return { ok: false, errors: ['Package JSON is empty.'] };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { ok: false, errors: ['Invalid JSON.'] };
		}

		const errors: string[] = [];
		const pkg = parsed as Partial<IFrameAdapterExportPackage>;

		if (pkg.formatVersion !== FRAME_ADAPTER_PACKAGE_VERSION) {
			errors.push(`Unsupported formatVersion (expected ${FRAME_ADAPTER_PACKAGE_VERSION}).`);
		}
		const meta = pkg.metadata as Partial<IFrameAdapterMetadata> | undefined;
		if (!meta) {
			errors.push('Missing metadata object.');
		} else {
			if (!meta.name) {
				errors.push('metadata.name is required.');
			}
			if (!meta.scope) {
				errors.push('metadata.scope is required.');
			} else {
				const scopes: readonly string[] = [FrameAdapterScope.Language, FrameAdapterScope.Project, FrameAdapterScope.User];
				if (!scopes.includes(meta.scope)) {
					errors.push(`metadata.scope must be language | project | user (got ${meta.scope}).`);
				}
			}
			if (!meta.baseModel) {
				errors.push('metadata.baseModel is required.');
			}
			if (!meta.version) {
				errors.push('metadata.version is required.');
			}
		}

		if (errors.length) {
			return { ok: false, errors };
		}

		return { ok: true, errors: [], pkg: pkg as IFrameAdapterExportPackage };
	}

	async importPackageJson(raw: string, options?: { activate?: boolean }): Promise<IFrameAdapterDescriptor> {
		const validation = this.validatePackageJson(raw);
		if (!validation.ok || !validation.pkg) {
			throw new Error(validation.errors.join(' ') || 'Invalid adapter package.');
		}

		const tags = new Set<string>([...(validation.pkg.metadata.tags ?? []), IMPORTED_TAG]);
		const pkg: IFrameAdapterExportPackage = {
			...validation.pkg,
			metadata: {
				...validation.pkg.metadata,
				tags: [...tags],
			},
		};

		const descriptor = await this.adapters.importAdapter(pkg, { activate: options?.activate });
		this.logService.info(`[FrameAdapterUI] Imported ${descriptor.id}`);
		return descriptor;
	}

	async importWeightFile(adapterId: string, absoluteSourcePath: string): Promise<IFrameAdapterDescriptor | undefined> {
		const descriptor = await this.adapters.importWeightFile(adapterId, absoluteSourcePath);
		if (descriptor) {
			this.logService.info(`[FrameAdapterUI] Linked weights for ${descriptor.id} → ${descriptor.weightFileName}`);
		}
		return descriptor;
	}

	async importWeightAsAdapter(absoluteSourcePath: string, options?: { activate?: boolean; name?: string }): Promise<IFrameAdapterDescriptor> {
		const descriptor = await this.adapters.importWeightAsAdapter(absoluteSourcePath, options);
		this.logService.info(`[FrameAdapterUI] Imported weight as adapter ${descriptor.id}`);
		return descriptor;
	}

	async exportWeightFile(adapterId: string, absoluteDestPath: string): Promise<string> {
		const uri = await this.adapters.exportWeightFile(adapterId, absoluteDestPath);
		this.logService.info(`[FrameAdapterUI] Exported weights ${adapterId} → ${uri.fsPath}`);
		return uri.fsPath;
	}

	async resolveWeightPath(adapterId: string): Promise<string | undefined> {
		const uri = await this.adapters.resolveWeightUri(adapterId);
		return uri?.fsPath;
	}

	async refresh(): Promise<void> {
		await this.adapters.discover();
		this._onDidChange.fire();
	}

	private toListItem(descriptor: IFrameAdapterDescriptor): IFrameAdapterListItem {
		const compatibility = this.adapters.checkCompatibility(descriptor.id, {
			language: descriptor.language,
			baseModelId: descriptor.baseModelId,
			minAdapterVersion: '0.0.0',
		});
		const imported = !!descriptor.tags?.some(t => t.toLowerCase() === IMPORTED_TAG);
		return {
			descriptor,
			compatible: compatibility.compatible,
			compatibility,
			imported,
			weightsLinked: !!descriptor.weightsLinked,
			weightBytes: descriptor.weightBytes,
			storagePath: descriptor.localPath ?? `.frame/adapters/${descriptor.id}`,
		};
	}
}

function descriptorToFallbackMetadata(d: IFrameAdapterDescriptor): IFrameAdapterMetadata {
	return {
		id: d.id,
		name: d.name,
		language: d.language,
		version: d.version,
		baseModel: d.baseModelId,
		created: d.createdAt,
		trainingExamples: d.trainingExamples,
		lastUpdated: d.updatedAt,
		scope: d.scope,
		kind: d.kind,
		state: d.state,
		description: d.description,
		weightFile: d.weightFileName,
		rank: d.rank,
		tags: d.tags,
		builtin: d.builtin,
	};
}
