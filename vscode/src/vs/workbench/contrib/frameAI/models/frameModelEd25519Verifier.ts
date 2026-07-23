/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	FrameModelPackageCryptoStatus,
	IFrameModelPackageContents,
	IFrameModelPackageCryptoVerifyResult,
	IFrameModelPackageSignature,
} from '../common/models.js';
import { IFrameModelKeyStore } from './frameModelKeyStore.js';
import {
	base64ToBytes,
	buildFrameModelSignaturePayloadText,
	encodeUtf8,
	sha256HexBytes,
} from './frameModelSignaturePayload.js';
import { FRAME_MODEL_CHECKSUMS_FILE, FRAME_MODEL_MANIFEST_FILE, FRAME_MODEL_SIGNATURE_FILE } from './frameModelPackageReader.js';
import { signatureValueOf } from './frameModelSignature.js';

/**
 * Offline Ed25519 verification of Frame model packages.
 * Uses Web Crypto (platform) — no network, no external crypto libraries.
 */
export class FrameModelEd25519Verifier {

	constructor(
		private readonly fileService: IFileService,
		private readonly keyStore: IFrameModelKeyStore,
	) { }

	async verifyPackage(
		pkg: IFrameModelPackageContents,
		signature?: IFrameModelPackageSignature | null,
	): Promise<IFrameModelPackageCryptoVerifyResult> {
		const root = URI.parse(pkg.packageRootUri);
		const fileSig = await this.readSignatureFile(root);
		const sig = signature ?? fileSig ?? pkg.manifest.signature;
		const algorithm = String(sig?.algorithm || 'none').toLowerCase();
		const keyId = sig?.keyId ?? null;
		const signatureValue = signatureValueOf(sig);

		if (!algorithm || algorithm === 'none' || algorithm === 'pending') {
			return {
				status: FrameModelPackageCryptoStatus.Unsigned,
				keyId,
				algorithm,
				message: 'Package is unsigned (no Ed25519 signature).',
			};
		}

		if (algorithm !== 'ed25519') {
			return {
				status: FrameModelPackageCryptoStatus.Unsupported,
				keyId,
				algorithm,
				message: `Algorithm "${algorithm}" is not Ed25519.`,
			};
		}

		if (!signatureValue) {
			return {
				status: FrameModelPackageCryptoStatus.Invalid,
				keyId,
				algorithm,
				message: 'Ed25519 signatureValue is missing.',
			};
		}

		if (!keyId) {
			return {
				status: FrameModelPackageCryptoStatus.Invalid,
				keyId: null,
				algorithm,
				message: 'Ed25519 signature requires keyId.',
			};
		}

		const key = this.keyStore.getKey(keyId);
		if (!key) {
			return {
				status: FrameModelPackageCryptoStatus.UnknownKey,
				keyId,
				algorithm,
				message: `Public key "${keyId}" is not available locally under .frame/models/keys/.`,
			};
		}

		try {
			const payload = await this.buildPayload(pkg);
			const ok = await verifyEd25519(key.publicKey, signatureValue, payload);
			if (!ok) {
				return {
					status: FrameModelPackageCryptoStatus.Invalid,
					keyId,
					algorithm,
					message: 'Ed25519 signature does not match manifest.json + checksums.json.',
				};
			}
			return {
				status: FrameModelPackageCryptoStatus.Verified,
				keyId,
				algorithm,
				message: 'Ed25519 signature verified against local public key.',
			};
		} catch (err) {
			return {
				status: FrameModelPackageCryptoStatus.Invalid,
				keyId,
				algorithm,
				message: `Ed25519 verification failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private async buildPayload(pkg: IFrameModelPackageContents): Promise<Uint8Array> {
		const root = URI.parse(pkg.packageRootUri);
		const manifestUri = joinPath(root, FRAME_MODEL_MANIFEST_FILE);
		const checksumsUri = joinPath(root, FRAME_MODEL_CHECKSUMS_FILE);

		const manifestBuf = (await this.fileService.readFile(manifestUri)).value;
		const checksumsBuf = (await this.fileService.readFile(checksumsUri)).value;

		const manifestHex = await sha256HexBytes(manifestBuf.buffer);
		const checksumsHex = await sha256HexBytes(checksumsBuf.buffer);
		const text = buildFrameModelSignaturePayloadText(manifestHex, checksumsHex);
		return encodeUtf8(text);
	}

	private async readSignatureFile(root: URI): Promise<IFrameModelPackageSignature | undefined> {
		const uri = joinPath(root, FRAME_MODEL_SIGNATURE_FILE);
		try {
			if (!(await this.fileService.exists(uri))) {
				return undefined;
			}
			const raw = (await this.fileService.readFile(uri)).value.toString();
			return JSON.parse(raw) as IFrameModelPackageSignature;
		} catch {
			return undefined;
		}
	}
}

async function verifyEd25519(publicKeySpkiBase64: string, signatureBase64: string, payload: Uint8Array): Promise<boolean> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error('Web Crypto API is unavailable for Ed25519.');
	}
	const spki = base64ToBytes(publicKeySpkiBase64);
	const signature = base64ToBytes(signatureBase64);
	const key = await subtle.importKey(
		'spki',
		toArrayBuffer(spki),
		{ name: 'Ed25519' },
		false,
		['verify'],
	);
	return subtle.verify({ name: 'Ed25519' }, key, toArrayBuffer(signature), toArrayBuffer(payload));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
