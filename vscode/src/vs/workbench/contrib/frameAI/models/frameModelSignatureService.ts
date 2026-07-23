/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import {
	FrameModelSignatureAlgorithm,
	IFrameModelPackageContents,
	IFrameModelPackageCryptoVerifyResult,
	IFrameModelPackageSignature,
	IFrameModelSignatureVerifyResult,
} from '../common/models.js';
import { FrameModelEd25519Verifier } from './frameModelEd25519Verifier.js';
import { IFrameModelKeyStore } from './frameModelKeyStore.js';
import {
	emptySignatureMetadata,
	IFrameModelSignatureMetadata,
	IFrameModelSignatureService,
	mapCryptoStatusToSignatureStatus,
	signatureValueOf,
} from './frameModelSignature.js';

const KNOWN_ALGORITHMS: readonly FrameModelSignatureAlgorithm[] = [
	'none',
	'pending',
	'ed25519',
	'rsa-pss-sha256',
];

/**
 * Offline signature service: metadata checks + Ed25519 package verification.
 */
export class FrameModelSignatureService implements IFrameModelSignatureService {

	declare readonly _serviceBrand: undefined;

	private readonly ed25519: FrameModelEd25519Verifier;

	constructor(
		@IFileService fileService: IFileService,
		@IFrameModelKeyStore private readonly keyStore: IFrameModelKeyStore,
	) {
		this.ed25519 = new FrameModelEd25519Verifier(fileService, keyStore);
	}

	toMetadata(signature: IFrameModelPackageSignature | null | undefined): IFrameModelSignatureMetadata {
		if (!signature || typeof signature !== 'object') {
			return emptySignatureMetadata();
		}
		const algorithm = String(signature.algorithm || 'none').toLowerCase();
		return {
			algorithm,
			keyId: signature.keyId ?? null,
			signer: signature.signer ?? null,
			signatureValue: signatureValueOf(signature),
			createdAt: signature.createdAt ?? signature.signedAt ?? null,
		};
	}

	verify(signature: IFrameModelPackageSignature | null | undefined): IFrameModelSignatureVerifyResult {
		const meta = this.toMetadata(signature);

		if (!meta.algorithm || meta.algorithm === 'none') {
			if (meta.signatureValue) {
				return {
					status: 'invalid',
					message: 'Signature value present but algorithm is "none".',
					algorithm: meta.algorithm,
					keyId: meta.keyId,
					signer: meta.signer,
				};
			}
			return {
				status: 'unsigned',
				message: 'Unsigned local package — no signature.',
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (!this.isKnownAlgorithm(meta.algorithm)) {
			return {
				status: 'unsupported',
				message: `Unsupported signature algorithm "${meta.algorithm}".`,
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (meta.algorithm === 'pending') {
			return {
				status: 'unsigned',
				message: 'Signature algorithm is pending — treat as unsigned.',
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (!meta.signatureValue) {
			return {
				status: 'invalid',
				message: `Algorithm "${meta.algorithm}" declared without signatureValue.`,
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (meta.algorithm === 'ed25519' && meta.keyId && !this.keyStore.getKey(meta.keyId)) {
			return {
				status: 'unknown_key',
				message: `Public key "${meta.keyId}" is not available locally.`,
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (!this.isCryptographicallySupported(meta.algorithm)) {
			return {
				status: 'unsupported',
				message: `Algorithm "${meta.algorithm}" has no cryptographic verifier.`,
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		if (meta.algorithm === 'ed25519') {
			// Sync path must NOT claim cryptographic verification — digests are async-only.
			return {
				status: 'unsupported',
				message: 'Ed25519 key is registered locally, but sync verify() cannot prove digests. Call verifyPackageSignature() for cryptographic verification.',
				algorithm: meta.algorithm,
				keyId: meta.keyId,
				signer: meta.signer,
			};
		}

		return {
			status: 'unsupported',
			message: `Algorithm "${meta.algorithm}" has no synchronous verifier — use verifyPackageSignature() when available.`,
			algorithm: meta.algorithm,
			keyId: meta.keyId,
			signer: meta.signer,
		};
	}

	async verifyPackageSignature(pkg: IFrameModelPackageContents): Promise<IFrameModelPackageCryptoVerifyResult> {
		await this.keyStore.refresh();
		return this.ed25519.verifyPackage(pkg, pkg.manifest.signature);
	}

	supportedAlgorithms(): readonly FrameModelSignatureAlgorithm[] {
		return KNOWN_ALGORITHMS;
	}

	isCryptographicallySupported(algorithm: string): boolean {
		return algorithm.toLowerCase() === 'ed25519';
	}

	private isKnownAlgorithm(algorithm: string): boolean {
		return (KNOWN_ALGORITHMS as readonly string[]).includes(algorithm.toLowerCase());
	}
}

export function cryptoResultToLegacy(
	result: IFrameModelPackageCryptoVerifyResult,
): IFrameModelSignatureVerifyResult {
	return {
		status: mapCryptoStatusToSignatureStatus(result.status),
		message: result.message,
		algorithm: result.algorithm,
		keyId: result.keyId,
	};
}
