/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameModelPackageCryptoStatus,
	FrameModelSignatureAlgorithm,
	IFrameModelPackageContents,
	IFrameModelPackageCryptoVerifyResult,
	IFrameModelPackageSignature,
	IFrameModelSignatureVerifyResult,
} from '../common/models.js';

/**
 * Canonical signature metadata for Frame model packages.
 */
export interface IFrameModelSignatureMetadata {
	readonly algorithm: FrameModelSignatureAlgorithm | string;
	readonly keyId: string | null;
	readonly signer: string | null;
	readonly signatureValue: string | null;
	readonly createdAt: number | null;
}

/**
 * Future / optional signer interface — packager implements signing offline.
 */
export interface IFrameModelPackageSigner {
	readonly algorithm: FrameModelSignatureAlgorithm;
	sign(_payload: Uint8Array, _keyId: string): Promise<IFrameModelSignatureMetadata>;
}

/**
 * Cryptographic verifier interface (Ed25519 implements this).
 */
export interface IFrameModelPackageSignatureVerifier {
	readonly algorithm: FrameModelSignatureAlgorithm;
	verify(_payload: Uint8Array, _signature: IFrameModelSignatureMetadata): Promise<boolean>;
}

export const IFrameModelSignatureService = createDecorator<IFrameModelSignatureService>('frameModelSignatureService');

/**
 * Offline signature verification — metadata + Ed25519 package crypto.
 */
export interface IFrameModelSignatureService {
	readonly _serviceBrand: undefined;

	/** Normalize manifest signature into canonical metadata. */
	toMetadata(signature: IFrameModelPackageSignature | null | undefined): IFrameModelSignatureMetadata;

	/**
	 * Lightweight metadata check (no file crypto).
	 * Returns: unsigned | verified | invalid | unsupported | unknown_key
	 */
	verify(signature: IFrameModelPackageSignature | null | undefined): IFrameModelSignatureVerifyResult;

	/**
	 * Full package verification:
	 * Read signature metadata → find local public key → verify Ed25519 over manifest+checksums.
	 */
	verifyPackageSignature(pkg: IFrameModelPackageContents): Promise<IFrameModelPackageCryptoVerifyResult>;

	supportedAlgorithms(): readonly FrameModelSignatureAlgorithm[];

	isCryptographicallySupported(algorithm: string): boolean;
}

export function emptySignatureMetadata(): IFrameModelSignatureMetadata {
	return {
		algorithm: 'none',
		keyId: null,
		signer: null,
		signatureValue: null,
		createdAt: null,
	};
}

export function signatureValueOf(signature: IFrameModelPackageSignature | null | undefined): string | null {
	if (!signature) {
		return null;
	}
	const v = signature.signatureValue ?? signature.value ?? null;
	return v === undefined || v === '' ? null : v;
}

export function mapCryptoStatusToSignatureStatus(
	status: FrameModelPackageCryptoStatus,
): IFrameModelSignatureVerifyResult['status'] {
	switch (status) {
		case FrameModelPackageCryptoStatus.Verified:
			return 'verified';
		case FrameModelPackageCryptoStatus.Invalid:
			return 'invalid';
		case FrameModelPackageCryptoStatus.UnknownKey:
			return 'unknown_key';
		case FrameModelPackageCryptoStatus.Unsupported:
			return 'unsupported';
		case FrameModelPackageCryptoStatus.Unsigned:
		default:
			return 'unsigned';
	}
}
