/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	FrameModelTrustStatus,
	IFrameModelChecksumFileResult,
	IFrameModelChecksumVerifyResult,
	IFrameModelPackageContents,
	IFrameModelVerifyIssue,
	IFrameModelVerifyResult,
} from '../common/models.js';
import { FRAME_PACKAGE_CHECKSUM_PLACEHOLDER } from './frameModelPackage.js';
import { getFrameModelProfile } from './frameModelProfiles.js';
import { migrateFrameModelManifest } from './frameModelMigration.js';
import { isSupportedArchitecture, primaryChecksum } from './frameModelPackageReader.js';
import { IFrameModelSignatureService, mapCryptoStatusToSignatureStatus } from './frameModelSignature.js';
import { IFrameModelVerifierService } from './frameModelVerifier.js';

const PLACEHOLDER_PREFIXES = ['sha256:pending', 'pending', 'placeholder', 'none'];

/**
 * Validates offline Frame model packages without loading or executing weights.
 */
export class FrameModelVerifierService implements IFrameModelVerifierService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IFrameModelSignatureService private readonly signatureService: IFrameModelSignatureService,
	) { }

	async verify(pkg: IFrameModelPackageContents, options?: { availableDiskGb?: number }): Promise<IFrameModelVerifyResult> {
		const issues: IFrameModelVerifyIssue[] = [];
		const migration = migrateFrameModelManifest(pkg.manifest);
		issues.push(...migration.issues);
		if (!migration.ok) {
			return { ok: false, issues, package: pkg, trustStatus: FrameModelTrustStatus.Invalid };
		}
		const manifest = migration.manifest;
		const migratedPkg: IFrameModelPackageContents = { ...pkg, manifest };

		if (manifest.format !== 'frame-model') {
			issues.push({ severity: 'error', code: 'manifest.format', message: `Unsupported format "${String(manifest.format)}". Expected "frame-model".` });
		}
		if (!manifest.id?.trim()) {
			issues.push({ severity: 'error', code: 'manifest.id', message: 'manifest.id is required.' });
		}
		if (!manifest.packageVersion?.trim()) {
			issues.push({ severity: 'error', code: 'manifest.version', message: 'manifest.packageVersion is required.' });
		}
		if (!manifest.architecture?.trim()) {
			issues.push({ severity: 'error', code: 'manifest.architecture', message: 'manifest.architecture is required.' });
		} else if (!isSupportedArchitecture(manifest.architecture) && !getFrameModelProfile(manifest.id)) {
			issues.push({
				severity: 'error',
				code: 'architecture.unsupported',
				message: `Unsupported architecture "${manifest.architecture}".`,
			});
		}

		if (!manifest.weightFiles?.length) {
			issues.push({ severity: 'error', code: 'weights.list', message: 'manifest.weightFiles must list at least one file.' });
		}

		const catalog = getFrameModelProfile(manifest.id);
		if (catalog && catalog.edition !== manifest.edition) {
			issues.push({
				severity: 'warning',
				code: 'edition.mismatch',
				message: `Manifest edition "${manifest.edition}" differs from catalog edition "${catalog.edition}" for ${manifest.id}.`,
			});
		}

		// Checksums — recompute from local files.
		const checksumResult = await this.verifyChecksums(migratedPkg);
		issues.push(...checksumResult.issues);

		// Signature — full Ed25519 package verification when applicable.
		const cryptoResult = await this.signatureService.verifyPackageSignature(migratedPkg);
		const signatureResult = {
			status: mapCryptoStatusToSignatureStatus(cryptoResult.status),
			message: cryptoResult.message,
			algorithm: cryptoResult.algorithm,
			keyId: cryptoResult.keyId,
			signer: migratedPkg.manifest.signature?.signer ?? null,
		};
		issues.push({
			severity: signatureResult.status === 'invalid' ? 'error'
				: signatureResult.status === 'unsupported' || signatureResult.status === 'unknown_key' ? 'warning'
					: 'info',
			code: `signature.${signatureResult.status}`,
			message: signatureResult.message,
		});

		const needGb = manifest.storageSizeGb || catalog?.storageSizeGb || 0;
		if (needGb > 0) {
			if (options?.availableDiskGb !== undefined) {
				if (options.availableDiskGb + 1 < needGb) {
					issues.push({
						severity: 'error',
						code: 'disk.insufficient',
						message: `Insufficient disk space: need ~${needGb} GB, available ~${options.availableDiskGb} GB.`,
					});
				}
			} else {
				issues.push({
					severity: 'info',
					code: 'disk.unverified',
					message: `Ensure ~${needGb} GB free disk for this package (disk free space was not measured).`,
				});
			}
		}

		const trustStatus = this.deriveTrustStatus(checksumResult, signatureResult.status);
		const ok = !issues.some(i => i.severity === 'error') && trustStatus !== FrameModelTrustStatus.Invalid;
		return {
			ok,
			issues,
			package: migratedPkg,
			checksumResult,
			signatureResult,
			trustStatus,
		};
	}

	async verifyChecksums(pkg: IFrameModelPackageContents): Promise<IFrameModelChecksumVerifyResult> {
		const issues: IFrameModelVerifyIssue[] = [];
		const matched: string[] = [];
		const mismatched: IFrameModelChecksumFileResult[] = [];
		const missing: string[] = [];
		const placeholders: string[] = [];

		const root = URI.parse(pkg.packageRootUri);
		const entries = Object.entries(pkg.checksums.files ?? {});

		if (!entries.length) {
			issues.push({ severity: 'error', code: 'checksum.missing', message: 'No checksum entries found.' });
			return { ok: false, matched, mismatched, missing, placeholders, issues };
		}

		for (const [rel, expectedRaw] of entries) {
			const expected = String(expectedRaw);
			if (rel.includes('..')) {
				mismatched.push({ file: rel, expected, actual: 'path-traversal-rejected' });
				issues.push({
					severity: 'error',
					code: 'checksum.path',
					message: `Rejected path traversal in checksum entry: ${rel}`,
				});
				continue;
			}

			if (this.isChecksumPlaceholder(expected)) {
				placeholders.push(rel);
				issues.push({
					severity: 'info',
					code: 'checksum.placeholder',
					message: `Checksum for "${rel}" is a placeholder.`,
				});
				continue;
			}

			const fileUri = joinPath(root, rel.replace(/^\/+/, ''));
			try {
				if (!(await this.fileService.exists(fileUri))) {
					missing.push(rel);
					issues.push({
						severity: 'error',
						code: 'checksum.file.absent',
						message: `Checksum listed for missing file: ${rel}`,
					});
					continue;
				}
				const buf = await this.fileService.readFile(fileUri);
				const actual = `sha256:${await sha256Hex(buf.value.buffer)}`;
				if (normalizeChecksum(actual) === normalizeChecksum(expected)) {
					matched.push(rel);
				} else {
					mismatched.push({ file: rel, expected, actual });
					issues.push({
						severity: 'error',
						code: 'checksum.mismatch',
						message: `Checksum mismatch for "${rel}": expected ${expected}, got ${actual}.`,
					});
				}
			} catch (err) {
				missing.push(rel);
				issues.push({
					severity: 'error',
					code: 'checksum.read',
					message: `Failed to read "${rel}" for checksum: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}

		// Ensure weight files are covered when listed.
		for (const file of pkg.manifest.weightFiles) {
			if (!pkg.checksums.files[file]) {
				issues.push({
					severity: 'warning',
					code: 'checksum.file.missing',
					message: `No checksum entry for weight file "${file}".`,
				});
			}
		}

		const primary = primaryChecksum(pkg.checksums, pkg.manifest);
		if (!primary) {
			issues.push({ severity: 'error', code: 'checksum.primary', message: 'No primary checksum available.' });
		}

		const ok = mismatched.length === 0 && missing.length === 0 && !issues.some(i => i.severity === 'error');
		return { ok, matched, mismatched, missing, placeholders, issues };
	}

	isChecksumPlaceholder(checksum: string): boolean {
		const c = checksum.trim().toLowerCase();
		if (c === FRAME_PACKAGE_CHECKSUM_PLACEHOLDER.toLowerCase()) {
			return true;
		}
		return PLACEHOLDER_PREFIXES.some(p => c.startsWith(p));
	}

	deriveTrustStatus(
		checksum: IFrameModelChecksumVerifyResult,
		signatureStatus: 'unsigned' | 'verified' | 'invalid' | 'unsupported' | 'unknown_key',
	): FrameModelTrustStatus {
		if (signatureStatus === 'invalid' || checksum.mismatched.length > 0 || checksum.missing.length > 0) {
			return FrameModelTrustStatus.Invalid;
		}
		if (signatureStatus === 'verified') {
			return FrameModelTrustStatus.SignatureValid;
		}
		if (checksum.matched.length > 0 && checksum.ok) {
			return FrameModelTrustStatus.ChecksumValid;
		}
		// Unsigned, unknown_key, unsupported, or placeholder-only checksums.
		return FrameModelTrustStatus.Unverified;
	}
}

function normalizeChecksum(value: string): string {
	return value.trim().toLowerCase().replace(/^sha256:/, '');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error('Web Crypto API is unavailable for SHA-256.');
	}
	// Copy into a plain ArrayBuffer — VSBuffer views may be SharedArrayBuffer-backed.
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	const digest = await subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
