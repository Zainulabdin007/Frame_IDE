/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Offline Ed25519 signing using Node crypto only.
 * Never ships or transmits private keys.
 */

import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PAYLOAD_PREFIX = 'frame-model-sig-v1';

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

function buildPayloadText(manifestHex, checksumsHex) {
	return `${PAYLOAD_PREFIX}\nsha256:${manifestHex}\nsha256:${checksumsHex}\n`;
}

/**
 * Sign an existing frame-model package directory.
 *
 * @param {{ packageDir: string, privateKeyPath: string, keyId: string, signer?: string }} opts
 */
export async function signPackage({ packageDir, privateKeyPath, keyId, signer }) {
	let packageRoot = packageDir;
	const nestedManifest = join(packageDir, 'frame-model', 'manifest.json');
	try {
		await readFile(nestedManifest);
		packageRoot = join(packageDir, 'frame-model');
	} catch {
		// use packageDir as root
	}

	const manifestPath = join(packageRoot, 'manifest.json');
	const checksumsPath = join(packageRoot, 'checksums.json');
	const signaturePath = join(packageRoot, 'signature.json');

	const manifestBytes = await readFile(manifestPath);
	const checksumsBytes = await readFile(checksumsPath);
	const payload = Buffer.from(
		buildPayloadText(sha256Hex(manifestBytes), sha256Hex(checksumsBytes)),
		'utf8',
	);

	const pem = await readFile(privateKeyPath, 'utf8');
	const privateKey = createPrivateKey(pem);
	if (privateKey.asymmetricKeyType !== 'ed25519') {
		throw new Error('Private key must be Ed25519 (PKCS8 PEM).');
	}

	const signature = nodeSign(null, payload, privateKey);
	const signatureValue = signature.toString('base64');

	const record = {
		algorithm: 'ed25519',
		keyId,
		signer: signer || null,
		signatureValue,
		value: signatureValue,
		createdAt: Date.now(),
		signedAt: Date.now(),
		note: 'Ed25519 signature over sha256(manifest.json)+sha256(checksums.json). Offline only.',
	};

	await writeFile(signaturePath, JSON.stringify(record, null, 2) + '\n', 'utf8');

	// Public key export hint for the user (not written into package by default).
	return {
		packageRoot,
		signaturePath,
		signature: record,
		payloadPreview: payload.toString('utf8').trim(),
	};
}

/**
 * Generate an Ed25519 key pair for local development.
 * Private key stays on the caller's disk — never bundled by Frame.
 */
export async function generateKeyPairFiles({ outDir, keyId }) {
	const { generateKeyPairSync } = await import('node:crypto');
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
	const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
	const pubDer = publicKey.export({ type: 'spki', format: 'der' });
	const pubB64 = Buffer.from(pubDer).toString('base64');

	const privatePath = join(outDir, `${keyId}.private.pem`);
	const publicPath = join(outDir, `${keyId}.public.pem`);
	const publicJsonPath = join(outDir, `${keyId}.public.json`);

	await writeFile(privatePath, privPem, 'utf8');
	await writeFile(publicPath, pubPem, 'utf8');
	await writeFile(publicJsonPath, JSON.stringify({
		keyId,
		algorithm: 'ed25519',
		owner: 'local',
		publicKey: pubB64,
		createdAt: Date.now(),
		note: 'Import this JSON into Frame via .frame/models/keys/ — never commit private.pem.',
	}, null, 2) + '\n', 'utf8');

	return { privatePath, publicPath, publicJsonPath, publicKeyBase64: pubB64 };
}
