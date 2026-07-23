/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	FRAME_MODEL_FORMAT_VERSION,
	FrameEdition,
	FrameModelPrecision,
	IFrameModelPackageChecksums,
	IFrameModelPackageContents,
	IFrameModelPackageManifest,
	FrameRuntimeKind,
} from '../common/models.js';
import { FRAME_PACKAGE_CHECKSUM_PLACEHOLDER } from './frameModelPackage.js';
import { getFrameModelProfile, resolveFrameModelId } from './frameModelProfiles.js';
import { createUnsignedSignature, migrateFrameModelManifest } from './frameModelMigration.js';

export const FRAME_MODEL_ARCHIVE_EXTENSION = '.frame-model';
export const FRAME_MODEL_PACKAGE_DIR = 'frame-model';
export const FRAME_MODEL_MANIFEST_FILE = 'manifest.json';
export const FRAME_MODEL_CHECKSUMS_FILE = 'checksums.json';
export const FRAME_MODEL_SIGNATURE_FILE = 'signature.json';

/**
 * Reads offline `.frame-model` packages (folder or JSON envelope).
 * Never downloads, never executes weights, never opens inference.
 */
export class FrameModelPackageReader {

	constructor(
		private readonly fileService: IFileService,
	) { }

	/**
	 * Read package metadata from:
	 * - a directory containing `frame-model/manifest.json` or `manifest.json`
	 * - a `.frame-model` JSON envelope file (offline portable descriptor)
	 */
	async readPackage(source: URI): Promise<IFrameModelPackageContents> {
		const stat = await this.fileService.resolve(source);
		if (stat.isDirectory) {
			return this.readFromDirectory(source);
		}
		return this.readFromFile(source);
	}

	async readManifestOnly(packageRoot: URI): Promise<IFrameModelPackageManifest> {
		const manifestUri = await this.resolveManifestUri(packageRoot);
		return this.parseManifestFile(manifestUri);
	}

	private async readFromDirectory(dir: URI): Promise<IFrameModelPackageContents> {
		const packageRoot = await this.resolvePackageRoot(dir);
		const manifestUri = joinPath(packageRoot, FRAME_MODEL_MANIFEST_FILE);
		const checksumsUri = joinPath(packageRoot, FRAME_MODEL_CHECKSUMS_FILE);
		let manifest = await this.parseManifestFile(manifestUri);
		const fileSig = await this.readSignatureFile(packageRoot);
		if (fileSig) {
			manifest = { ...manifest, signature: fileSig };
		}
		const checksums = await this.parseChecksumsFile(checksumsUri, manifest);
		const { present, missing } = await this.probeWeightFiles(packageRoot, manifest.weightFiles);
		return {
			sourceUri: dir.toString(),
			packageRootUri: packageRoot.toString(),
			manifest,
			checksums,
			weightFilesPresent: present,
			weightFilesMissing: missing,
		};
	}

	private async readFromFile(file: URI): Promise<IFrameModelPackageContents> {
		const name = basename(file);
		if (!name.toLowerCase().endsWith(FRAME_MODEL_ARCHIVE_EXTENSION)) {
			throw new Error(`Expected a ${FRAME_MODEL_ARCHIVE_EXTENSION} file or package folder.`);
		}
		const raw = (await this.fileService.readFile(file)).value.toString().trim();
		if (raw.startsWith('{')) {
			return this.readJsonEnvelope(file, raw);
		}
		// Binary / zip archives: Frame does not extract or execute them here.
		// Users unpack offline; then import the extracted folder.
		throw new Error(
			`Compressed ${FRAME_MODEL_ARCHIVE_EXTENSION} archives are not auto-extracted. ` +
			`Unpack offline to a folder with frame-model/manifest.json, then import that folder.`,
		);
	}

	private async readJsonEnvelope(file: URI, raw: string): Promise<IFrameModelPackageContents> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('Invalid .frame-model JSON envelope.');
		}
		const env = parsed as {
			format?: string;
			manifest?: IFrameModelPackageManifest;
			checksums?: IFrameModelPackageChecksums;
			packageRoot?: string;
		};
		if (env.format !== 'frame-model' || !env.manifest) {
			throw new Error('JSON envelope must include format "frame-model" and a manifest object.');
		}
		const manifest = normalizeManifest(env.manifest);
		const checksums = env.checksums ?? defaultChecksums(manifest);
		const packageRoot = env.packageRoot
			? URI.file(env.packageRoot)
			: dirname(file);
		const { present, missing } = await this.probeWeightFiles(packageRoot, manifest.weightFiles);
		return {
			sourceUri: file.toString(),
			packageRootUri: packageRoot.toString(),
			manifest,
			checksums,
			weightFilesPresent: present,
			weightFilesMissing: missing,
		};
	}

	private async resolvePackageRoot(dir: URI): Promise<URI> {
		const nested = joinPath(dir, FRAME_MODEL_PACKAGE_DIR);
		if (await this.fileService.exists(joinPath(nested, FRAME_MODEL_MANIFEST_FILE))) {
			return nested;
		}
		if (await this.fileService.exists(joinPath(dir, FRAME_MODEL_MANIFEST_FILE))) {
			return dir;
		}
		throw new Error(
			`Package manifest not found. Expected ${FRAME_MODEL_PACKAGE_DIR}/${FRAME_MODEL_MANIFEST_FILE} or ${FRAME_MODEL_MANIFEST_FILE}.`,
		);
	}

	private async resolveManifestUri(packageRoot: URI): Promise<URI> {
		const nested = joinPath(packageRoot, FRAME_MODEL_PACKAGE_DIR, FRAME_MODEL_MANIFEST_FILE);
		if (await this.fileService.exists(nested)) {
			return nested;
		}
		const direct = joinPath(packageRoot, FRAME_MODEL_MANIFEST_FILE);
		if (await this.fileService.exists(direct)) {
			return direct;
		}
		throw new Error('manifest.json not found in package.');
	}

	private async parseManifestFile(uri: URI): Promise<IFrameModelPackageManifest> {
		if (!(await this.fileService.exists(uri))) {
			throw new Error(`Missing manifest: ${basename(uri)}`);
		}
		const raw = (await this.fileService.readFile(uri)).value.toString();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('manifest.json is not valid JSON.');
		}
		return normalizeManifest(parsed as IFrameModelPackageManifest);
	}

	private async parseChecksumsFile(uri: URI, manifest: IFrameModelPackageManifest): Promise<IFrameModelPackageChecksums> {
		if (!(await this.fileService.exists(uri))) {
			return defaultChecksums(manifest);
		}
		const raw = (await this.fileService.readFile(uri)).value.toString();
		try {
			const parsed = JSON.parse(raw) as IFrameModelPackageChecksums;
			return {
				version: parsed.version ?? 1,
				files: parsed.files ?? {},
			};
		} catch {
			throw new Error('checksums.json is not valid JSON.');
		}
	}

	private async readSignatureFile(packageRoot: URI): Promise<IFrameModelPackageManifest['signature']> {
		const uri = joinPath(packageRoot, FRAME_MODEL_SIGNATURE_FILE);
		try {
			if (!(await this.fileService.exists(uri))) {
				return undefined;
			}
			const raw = (await this.fileService.readFile(uri)).value.toString();
			return JSON.parse(raw) as IFrameModelPackageManifest['signature'];
		} catch {
			return undefined;
		}
	}

	private async probeWeightFiles(packageRoot: URI, weightFiles: readonly string[]): Promise<{ present: string[]; missing: string[] }> {
		const present: string[] = [];
		const missing: string[] = [];
		for (const rel of weightFiles) {
			const clean = rel.replace(/^\/+/, '');
			if (clean.includes('..')) {
				missing.push(rel);
				continue;
			}
			const uri = joinPath(packageRoot, clean);
			if (await this.fileService.exists(uri)) {
				present.push(rel);
			} else {
				missing.push(rel);
			}
		}
		return { present, missing };
	}
}

export function normalizeManifest(raw: IFrameModelPackageManifest): IFrameModelPackageManifest {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Invalid manifest object.');
	}
	const id = resolveFrameModelId(String(raw.id ?? '').trim());
	if (!id) {
		throw new Error('manifest.id is required.');
	}
	const edition = normalizeEdition(raw.edition);
	const precision = normalizePrecision(raw.precision);
	const weightFiles = Array.isArray(raw.weightFiles)
		? raw.weightFiles.map(String)
		: ['model/weights.placeholder'];
	const base: IFrameModelPackageManifest = {
		format: 'frame-model',
		formatVersion: Number(raw.formatVersion) || 1,
		id,
		edition,
		modelName: String(raw.modelName ?? raw.id),
		architecture: String(raw.architecture ?? 'unknown'),
		modelFamily: raw.modelFamily ? String(raw.modelFamily) : undefined,
		parameterCount: raw.parameterCount ? String(raw.parameterCount) : undefined,
		precision,
		quantization: String(raw.quantization ?? precision),
		packageVersion: String(raw.packageVersion ?? '0.0.0'),
		storageSizeGb: Number(raw.storageSizeGb) || 0,
		memoryRequirementGb: Number(raw.memoryRequirementGb) || 0,
		weightFiles,
		description: raw.description ? String(raw.description) : undefined,
		compatibleRuntimes: Array.isArray(raw.compatibleRuntimes)
			? raw.compatibleRuntimes as FrameRuntimeKind[]
			: undefined,
		signature: raw.signature ?? createUnsignedSignature(),
	};
	const migrated = migrateFrameModelManifest(base);
	if (!migrated.ok) {
		throw new Error(migrated.issues.map(i => i.message).join(' ') || 'Manifest formatVersion migration failed.');
	}
	return {
		...migrated.manifest,
		formatVersion: FRAME_MODEL_FORMAT_VERSION,
	};
}

export function defaultChecksums(manifest: IFrameModelPackageManifest): IFrameModelPackageChecksums {
	const files: Record<string, string> = {};
	for (const f of manifest.weightFiles) {
		files[f] = FRAME_PACKAGE_CHECKSUM_PLACEHOLDER;
	}
	files[FRAME_MODEL_MANIFEST_FILE] = FRAME_PACKAGE_CHECKSUM_PLACEHOLDER;
	return { version: 1, files };
}

export function primaryChecksum(checksums: IFrameModelPackageChecksums, manifest: IFrameModelPackageManifest): string {
	for (const f of manifest.weightFiles) {
		if (checksums.files[f]) {
			return checksums.files[f];
		}
	}
	const first = Object.values(checksums.files)[0];
	return first ?? FRAME_PACKAGE_CHECKSUM_PLACEHOLDER;
}

export function isSupportedArchitecture(architecture: string): boolean {
	const profile = getFrameModelProfile(architecture) ?? getFrameModelProfile(resolveFrameModelId(architecture));
	if (profile) {
		return true;
	}
	const known = ['qwen2.5-coder-7b', 'qwen2.5-coder', 'qwen-coder-7b'];
	const lower = architecture.toLowerCase();
	return known.some(k => lower.includes(k)) || !!getFrameModelProfile(resolveFrameModelId(architecture));
}

function normalizeEdition(value: unknown): FrameEdition {
	const v = String(value ?? '').toLowerCase();
	if (v === FrameEdition.Professional || v === 'professional') {
		return FrameEdition.Professional;
	}
	if (v === FrameEdition.Maximum || v === 'maximum') {
		return FrameEdition.Maximum;
	}
	return FrameEdition.Efficient;
}

function normalizePrecision(value: unknown): FrameModelPrecision {
	const v = String(value ?? '').toLowerCase();
	if (v === '8-bit' || v === 'q8' || v.includes('8')) {
		if (v.includes('16') || v === 'fp16') {
			return 'fp16';
		}
		if (v.includes('4')) {
			return '4-bit';
		}
		return '8-bit';
	}
	if (v === 'fp16' || v === '16-bit' || v.includes('fp16')) {
		return 'fp16';
	}
	return '4-bit';
}
