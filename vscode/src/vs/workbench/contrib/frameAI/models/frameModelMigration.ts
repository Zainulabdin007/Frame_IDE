/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	FRAME_MODEL_FORMAT_VERSION,
	FRAME_MODEL_FORMAT_VERSION_MIN,
	IFrameModelPackageManifest,
	IFrameModelPackageSignature,
	IFrameModelVerifyIssue,
} from '../common/models.js';

export interface IFrameModelMigrationResult {
	readonly ok: boolean;
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly manifest: IFrameModelPackageManifest;
	readonly migrated: boolean;
	readonly issues: readonly IFrameModelVerifyIssue[];
}

/**
 * Validates and migrates `.frame-model` manifests across formatVersion.
 * Does not touch weight bytes or perform network I/O.
 */
export function validateFormatVersion(formatVersion: number): IFrameModelVerifyIssue[] {
	const issues: IFrameModelVerifyIssue[] = [];
	if (!Number.isFinite(formatVersion) || formatVersion < FRAME_MODEL_FORMAT_VERSION_MIN) {
		issues.push({
			severity: 'error',
			code: 'formatVersion.tooOld',
			message: `formatVersion ${formatVersion} is below minimum ${FRAME_MODEL_FORMAT_VERSION_MIN}.`,
		});
		return issues;
	}
	if (formatVersion > FRAME_MODEL_FORMAT_VERSION) {
		issues.push({
			severity: 'error',
			code: 'formatVersion.tooNew',
			message: `formatVersion ${formatVersion} is newer than supported ${FRAME_MODEL_FORMAT_VERSION}. Upgrade Frame IDE or re-package.`,
		});
		return issues;
	}
	if (formatVersion < FRAME_MODEL_FORMAT_VERSION) {
		issues.push({
			severity: 'info',
			code: 'formatVersion.migrate',
			message: `Manifest formatVersion ${formatVersion} will be migrated to ${FRAME_MODEL_FORMAT_VERSION}.`,
		});
	}
	return issues;
}

/**
 * Migrate a normalized (or raw-normalized) manifest to the current formatVersion.
 */
export function migrateFrameModelManifest(manifest: IFrameModelPackageManifest): IFrameModelMigrationResult {
	const fromVersion = Number(manifest.formatVersion) || 1;
	const versionIssues = validateFormatVersion(fromVersion);
	if (versionIssues.some(i => i.severity === 'error')) {
		return {
			ok: false,
			fromVersion,
			toVersion: fromVersion,
			manifest,
			migrated: false,
			issues: versionIssues,
		};
	}

	let current: IFrameModelPackageManifest = { ...manifest, formatVersion: fromVersion };
	const issues: IFrameModelVerifyIssue[] = [...versionIssues];
	let migrated = false;

	if (current.formatVersion < 2) {
		current = migrateV1ToV2(current);
		migrated = true;
		issues.push({
			severity: 'info',
			code: 'migration.v1_to_v2',
			message: 'Migrated manifest v1 → v2 (modelFamily, parameterCount, signature placeholder).',
		});
	}

	// Future: if (current.formatVersion < 3) { ... }

	current = {
		...current,
		formatVersion: FRAME_MODEL_FORMAT_VERSION,
		signature: normalizeSignature(current.signature),
	};

	return {
		ok: true,
		fromVersion,
		toVersion: FRAME_MODEL_FORMAT_VERSION,
		manifest: current,
		migrated,
		issues,
	};
}

function migrateV1ToV2(manifest: IFrameModelPackageManifest): IFrameModelPackageManifest {
	const weightFiles = manifest.weightFiles?.length
		? manifest.weightFiles.map(relocateWeightPath)
		: ['model/weights.placeholder'];

	return {
		...manifest,
		formatVersion: 2,
		modelFamily: manifest.modelFamily ?? deriveModelFamily(manifest.architecture, manifest.modelName),
		parameterCount: manifest.parameterCount ?? deriveParameterCount(manifest.architecture, manifest.id),
		compatibleRuntimes: manifest.compatibleRuntimes?.length
			? manifest.compatibleRuntimes
			: ['stub', 'llamacpp', 'mlx'],
		weightFiles,
		signature: normalizeSignature(manifest.signature),
	};
}

function relocateWeightPath(rel: string): string {
	const clean = rel.replace(/^\/+/, '');
	if (clean.startsWith('model/')) {
		return clean;
	}
	return `model/${clean}`;
}

function deriveModelFamily(architecture: string, modelName: string): string {
	if (architecture && architecture !== 'unknown') {
		return architecture;
	}
	return modelName || 'unknown';
}

function deriveParameterCount(architecture: string, id: string): string {
	const hay = `${architecture} ${id}`.toLowerCase();
	const match = hay.match(/(\d+)\s*b\b/);
	if (match) {
		return `${match[1]}B`;
	}
	if (hay.includes('7b') || hay.includes('coder-7')) {
		return '7B';
	}
	return 'unknown';
}

export function normalizeSignature(raw: IFrameModelPackageSignature | null | undefined): IFrameModelPackageSignature {
	if (!raw || typeof raw !== 'object') {
		return {
			algorithm: 'none',
			keyId: null,
			signer: null,
			signatureValue: null,
			value: null,
			createdAt: null,
			signedAt: null,
			note: 'Signature placeholder — cryptography not implemented.',
		};
	}
	const algorithm = String(raw.algorithm || 'none').toLowerCase();
	const signatureValue = raw.signatureValue ?? raw.value ?? null;
	const createdAt = raw.createdAt ?? raw.signedAt ?? null;
	return {
		algorithm: algorithm === 'none' || algorithm === 'pending' || algorithm === 'ed25519' || algorithm === 'rsa-pss-sha256'
			? algorithm
			: algorithm,
		keyId: raw.keyId ?? null,
		signer: raw.signer ?? null,
		signatureValue,
		value: signatureValue,
		createdAt,
		signedAt: createdAt,
		note: raw.note ?? 'Signature placeholder — cryptography not implemented.',
	};
}

export function createUnsignedSignature(): IFrameModelPackageSignature {
	return normalizeSignature(undefined);
}
