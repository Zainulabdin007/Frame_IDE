/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FrameModelTrustStatus,
	IFrameAdapterPrecisionWarning,
	IFrameModelImportResult,
	IFrameModelImportStagesBuilder,
	IFrameModelPackageContents,
	IFrameModelVerifyIssue,
	IFrameModelVerifyResult,
} from '../common/models.js';
import { IFrameAdapterService } from '../adapters/frameAdapters.js';
import { IFrameRuntimeService } from '../runtime/frameRuntime.js';
import {
	FRAME_MODEL_ARCHIVE_EXTENSION,
	FRAME_MODEL_CHECKSUMS_FILE,
	FRAME_MODEL_MANIFEST_FILE,
	FRAME_MODEL_PACKAGE_DIR,
	FrameModelPackageReader,
	primaryChecksum,
} from './frameModelPackageReader.js';
import { FRAME_PACKAGE_CHECKSUM_PLACEHOLDER } from './frameModelPackage.js';
import { getFrameModelProfile } from './frameModelProfiles.js';
import { IFrameModelImportService } from './frameModelImport.js';
import { IFrameModelService } from './frameModels.js';
import { IFrameModelSignatureService } from './frameModelSignature.js';
import { mapCryptoStatusToSignatureStatus } from './frameModelSignature.js';
import { IFrameModelVerifierService } from './frameModelVerifier.js';

/**
 * Copies user-owned offline packages into `.frame/models/imported/<id>/`.
 * Never downloads, never runs inference, never executes package code.
 */
export class FrameModelImportService extends Disposable implements IFrameModelImportService {

	declare readonly _serviceBrand: undefined;

	private readonly reader: FrameModelPackageReader;

	private readonly _onDidImport = this._register(new Emitter<IFrameModelImportResult>());
	readonly onDidImport: Event<IFrameModelImportResult> = this._onDidImport.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFrameModelVerifierService private readonly verifier: IFrameModelVerifierService,
		@IFrameModelSignatureService private readonly signatureService: IFrameModelSignatureService,
		@IFrameModelService private readonly modelService: IFrameModelService,
		@IFrameRuntimeService private readonly runtimeService: IFrameRuntimeService,
		@IFrameAdapterService private readonly adapterService: IFrameAdapterService,
	) {
		super();
		this.reader = new FrameModelPackageReader(this.fileService);
	}

	async pickPackage(): Promise<URI | undefined> {
		const defaultUri = await this.fileDialogService.defaultFilePath();
		const result = await this.fileDialogService.showOpenDialog({
			title: 'Import Frame Model Package',
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Import',
			defaultUri,
			filters: [
				{ name: 'Frame Model Package', extensions: ['frame-model'] },
				{ name: 'All Files', extensions: ['*'] },
			],
		});
		return result?.[0];
	}

	readPackage(source: URI): Promise<IFrameModelPackageContents> {
		return this.reader.readPackage(source);
	}

	async validatePackage(source: URI): Promise<IFrameModelVerifyResult> {
		try {
			const pkg = await this.reader.readPackage(source);
			return this.verifier.verify(pkg);
		} catch (err) {
			return {
				ok: false,
				issues: [{
					severity: 'error',
					code: 'read.failed',
					message: err instanceof Error ? err.message : String(err),
				}],
			};
		}
	}

	async importPackage(source: URI, options?: { activate?: boolean }): Promise<IFrameModelImportResult> {
		const stages: IFrameModelImportStagesBuilder = {
			readManifest: false,
			verifyChecksums: false,
			verifySignature: false,
			install: false,
			register: false,
			activate: false,
		};
		const issues: IFrameModelVerifyIssue[] = [];

		// 1. Read Manifest
		let pkg: IFrameModelPackageContents;
		try {
			pkg = await this.reader.readPackage(source);
			stages.readManifest = true;
		} catch (err) {
			return {
				ok: false,
				modelId: 'unknown',
				localPath: '',
				packageVersion: '',
				checksum: '',
				trustStatus: FrameModelTrustStatus.Invalid,
				stages,
				issues: [{
					severity: 'error',
					code: 'read.failed',
					message: err instanceof Error ? err.message : String(err),
				}],
			};
		}

		// 2–3. Verify Checksums + Signature (via verifier)
		const validation = await this.verifier.verify(pkg);
		issues.push(...validation.issues);
		pkg = validation.package ?? pkg;
		stages.verifyChecksums = !!validation.checksumResult;
		stages.verifySignature = !!validation.signatureResult;

		if (validation.checksumResult && !validation.checksumResult.ok && validation.trustStatus === FrameModelTrustStatus.Invalid) {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: '',
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: FrameModelTrustStatus.Invalid,
				stages,
				issues,
			};
		}
		if (validation.signatureResult?.status === 'invalid') {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: '',
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: FrameModelTrustStatus.Invalid,
				stages,
				issues,
			};
		}
		if (!validation.ok) {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: '',
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: validation.trustStatus ?? FrameModelTrustStatus.Invalid,
				stages,
				issues,
			};
		}

		// Explicit signature step log (metadata already verified above).
		const sig = this.signatureService.verify(pkg.manifest.signature);
		this.logService.info(`[FrameImport] Signature: ${sig.status} — ${sig.message}`);

		const profile = getFrameModelProfile(pkg.manifest.id);
		if (!profile) {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: '',
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: validation.trustStatus,
				stages,
				issues: [
					...issues,
					{
						severity: 'error',
						code: 'catalog.unknown',
						message: `Model id "${pkg.manifest.id}" is not in the Frame catalog (Efficient / Professional / Maximum).`,
					},
				],
			};
		}

		const folder = this.primaryFolder();
		if (!folder) {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: '',
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: validation.trustStatus,
				stages,
				issues: [...issues, {
					severity: 'error',
					code: 'workspace.missing',
					message: 'Open a workspace folder before importing a model package.',
				}],
			};
		}

		// 4. Install (copy into Frame storage)
		const relPath = `.frame/models/imported/${pkg.manifest.id}`;
		const destRoot = joinPath(folder, '.frame', 'models', 'imported', pkg.manifest.id);
		const destPackage = joinPath(destRoot, FRAME_MODEL_PACKAGE_DIR);

		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'models'));
		await this.ensureDir(joinPath(folder, '.frame', 'models', 'imported'));
		await this.ensureDir(destRoot);
		await this.ensureDir(destPackage);

		await this.copyPackageTree(URI.parse(pkg.packageRootUri), destPackage);

		await this.fileService.writeFile(
			joinPath(destPackage, FRAME_MODEL_MANIFEST_FILE),
			VSBuffer.fromString(JSON.stringify(pkg.manifest, null, 2) + '\n'),
		);
		await this.fileService.writeFile(
			joinPath(destPackage, FRAME_MODEL_CHECKSUMS_FILE),
			VSBuffer.fromString(JSON.stringify(pkg.checksums, null, 2) + '\n'),
		);
		stages.install = true;

		// Re-verify checksums on the installed copy (local files only).
		const installedPkg: IFrameModelPackageContents = {
			...pkg,
			sourceUri: destPackage.toString(),
			packageRootUri: destPackage.toString(),
		};
		const postChecksum = await this.verifier.verifyChecksums(installedPkg);
		issues.push(...postChecksum.issues.map(i => ({
			...i,
			code: i.code.startsWith('checksum.') ? `install.${i.code}` : i.code,
		})));
		if (!postChecksum.ok && postChecksum.mismatched.length + postChecksum.missing.length > 0) {
			return {
				ok: false,
				modelId: pkg.manifest.id,
				localPath: relPath,
				packageVersion: pkg.manifest.packageVersion,
				checksum: primaryChecksum(pkg.checksums, pkg.manifest),
				trustStatus: FrameModelTrustStatus.Invalid,
				stages,
				issues,
			};
		}

		const postCrypto = await this.signatureService.verifyPackageSignature(installedPkg);
		const postSigStatus = mapCryptoStatusToSignatureStatus(postCrypto.status);
		const trustStatus = this.verifier.deriveTrustStatus(postChecksum, postSigStatus);

		// 5. Register
		const checksum = primaryChecksum(pkg.checksums, pkg.manifest) || FRAME_PACKAGE_CHECKSUM_PLACEHOLDER;
		const ggufPath = await this.resolveImportedGgufPath(destPackage, pkg.manifest.weightFiles ?? []);
		const registryLocalPath = ggufPath ?? relPath;
		const registrySignature = postCrypto.algorithm && postCrypto.algorithm !== 'none'
			? {
				algorithm: String(postCrypto.algorithm),
				keyId: postCrypto.keyId,
				verifyStatus: postCrypto.status,
			}
			: (pkg.manifest.signature?.algorithm && pkg.manifest.signature.algorithm !== 'none'
				? {
					algorithm: String(pkg.manifest.signature.algorithm),
					keyId: pkg.manifest.signature.keyId ?? null,
					verifyStatus: postCrypto.status,
				}
				: undefined);
		const descriptor = await this.modelService.registerModel(pkg.manifest.id, {
			localPath: registryLocalPath,
			packageVersion: pkg.manifest.packageVersion,
			checksum,
			trustStatus,
			signature: registrySignature,
		});
		stages.register = true;

		this.logService.info(`[FrameImport] Registered ${pkg.manifest.id} trust=${trustStatus} → ${registryLocalPath}`);

		let activated = false;
		if (options?.activate) {
			await this.activateImportedModel(pkg.manifest.id);
			activated = true;
			stages.activate = true;
		}

		const result: IFrameModelImportResult = {
			ok: true,
			modelId: pkg.manifest.id,
			localPath: registryLocalPath,
			packageVersion: pkg.manifest.packageVersion,
			checksum,
			trustStatus,
			stages: { ...stages, activate: activated },
			descriptor,
			issues,
		};
		this._onDidImport.fire(result);
		return result;
	}

	async activateImportedModel(modelId: string): Promise<{
		ok: boolean;
		warnings: readonly IFrameAdapterPrecisionWarning[];
	}> {
		const model = this.modelService.getModel(modelId);
		if (!model?.installed) {
			return {
				ok: false,
				warnings: [{
					adapterId: '',
					adapterName: '',
					adapterPrecision: '',
					modelPrecision: '4-bit',
					message: `Model ${modelId} is not installed. Import a package first.`,
				}],
			};
		}
		await this.runtimeService.updateConfig({
			activeModelId: modelId,
			modelPath: model.localPath?.toLowerCase().endsWith('.gguf') ? model.localPath : null,
		});
		const warnings = await this.checkAdapterPrecisionWarnings(modelId);
		return { ok: true, warnings };
	}

	async checkAdapterPrecisionWarnings(modelId: string): Promise<readonly IFrameAdapterPrecisionWarning[]> {
		const model = this.modelService.getModel(modelId);
		if (!model) {
			return [];
		}
		await this.adapterService.discover();
		const warnings: IFrameAdapterPrecisionWarning[] = [];
		for (const adapter of this.adapterService.listAdapters()) {
			const meta = await this.adapterService.loadMetadata(adapter.id);
			const adapterPrecision = normalizePrecisionLabel(meta?.precision ?? inferPrecisionFromBaseModel(adapter.baseModelId));
			if (!adapterPrecision) {
				continue;
			}
			const modelPrecision = normalizePrecisionLabel(model.precision);
			if (adapterPrecision !== modelPrecision) {
				warnings.push({
					adapterId: adapter.id,
					adapterName: adapter.name,
					adapterPrecision,
					modelPrecision: model.precision,
					message: `Adapter “${adapter.name}” precision (${adapterPrecision}) ≠ model precision (${modelPrecision}).`,
				});
			}
		}
		return warnings;
	}

	private async resolveImportedGgufPath(destPackage: URI, weightFiles: readonly string[]): Promise<string | undefined> {
		for (const rel of weightFiles) {
			const clean = String(rel).replace(/^[/\\]+/, '');
			if (!clean.toLowerCase().endsWith('.gguf')) {
				continue;
			}
			const uri = joinPath(destPackage, clean);
			if (await this.fileService.exists(uri)) {
				return uri.fsPath;
			}
		}
		try {
			const modelDir = joinPath(destPackage, 'model');
			if (await this.fileService.exists(modelDir)) {
				const stat = await this.fileService.resolve(modelDir);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory && basename(child.resource).toLowerCase().endsWith('.gguf')) {
						return child.resource.fsPath;
					}
				}
			}
		} catch {
			// ignore scan failures
		}
		return undefined;
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async copyPackageTree(sourceRoot: URI, destPackage: URI): Promise<void> {
		try {
			const stat = await this.fileService.resolve(sourceRoot, { resolveSingleChildDescendants: true });
			if (!stat.isDirectory) {
				return;
			}
			const children = stat.children ?? [];
			for (const child of children) {
				const name = basename(child.resource);
				if (name === '.' || name === '..') {
					continue;
				}
				const target = joinPath(destPackage, name);
				try {
					await this.fileService.copy(child.resource, target, true);
				} catch (err) {
					this.logService.warn(`[FrameImport] Could not copy ${name}: ${String(err)}`);
				}
			}
		} catch (err) {
			this.logService.warn(`[FrameImport] Package tree copy skipped: ${String(err)}`);
		}
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}

function normalizePrecisionLabel(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const v = value.toLowerCase();
	if (v.includes('fp16') || v === '16-bit') {
		return 'fp16';
	}
	if (v.includes('8')) {
		return '8-bit';
	}
	if (v.includes('4')) {
		return '4-bit';
	}
	return value;
}

function inferPrecisionFromBaseModel(baseModelId: string): string | undefined {
	const id = baseModelId.toLowerCase();
	if (id.includes('fp16') || id.includes('qwen-coder-7b-fp16') || id.includes('maximum')) {
		return 'fp16';
	}
	if (id.includes('q8') || id.includes('8b') || id.includes('professional')) {
		return '8-bit';
	}
	if (id.includes('q4') || id.includes('4b') || id.includes('efficient')) {
		return '4-bit';
	}
	const profile = getFrameModelProfile(baseModelId);
	return profile?.precision;
}

void FRAME_MODEL_ARCHIVE_EXTENSION;
