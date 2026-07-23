/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canonical payload bytes signed by Frame model packages (Ed25519).
 * Shared by the packager (Node crypto) and the IDE (Web Crypto).
 *
 * payload = UTF-8 of:
 *   frame-model-sig-v1\n
 *   sha256:<manifestHex>\n
 *   sha256:<checksumsHex>\n
 */

export const FRAME_MODEL_SIG_PAYLOAD_PREFIX = 'frame-model-sig-v1';

export function buildFrameModelSignaturePayloadText(manifestSha256Hex: string, checksumsSha256Hex: string): string {
	const m = manifestSha256Hex.replace(/^sha256:/i, '').toLowerCase();
	const c = checksumsSha256Hex.replace(/^sha256:/i, '').toLowerCase();
	return `${FRAME_MODEL_SIG_PAYLOAD_PREFIX}\nsha256:${m}\nsha256:${c}\n`;
}

export function encodeUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const normalized = b64.replace(/\s+/g, '');
	const binary = atob(normalized);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export async function sha256HexBytes(data: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error('Web Crypto API is unavailable for SHA-256.');
	}
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	const digest = await subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
