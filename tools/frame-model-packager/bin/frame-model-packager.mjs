#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frame Model Packager CLI
 *
 * Offline only — never downloads models, never loads inference, never calls cloud APIs.
 * By default does NOT copy real weight bytes into the package (stub + checksum only).
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../lib/build.mjs';
import { validatePackageDir } from '../lib/validate.mjs';
import { sha256File } from '../lib/checksums.mjs';
import { generateKeyPairFiles, signPackage } from '../lib/sign.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function printHelp() {
	console.log(`Frame Model Packager — offline .frame-model tooling

Usage:
  frame-model-packager build --metadata <file> [--model <path>] [--out <dir>]
  frame-model-packager checksum --file <path>
  frame-model-packager validate --package <dir>
  frame-model-packager gen-keypair --key-id <id> --out <dir>
  frame-model-packager sign --package <dir> --private-key <pem> --key-id <id> [--signer <name>]
  frame-model-packager help

Notes:
  • Never downloads or contacts the network.
  • Does not bundle real model weights by default.
  • sign uses Node crypto Ed25519; private keys are never shipped by Frame.
  • Import the generated *.public.json into .frame/models/keys/ for IDE verification.
`);
}

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (!next || next.startsWith('--')) {
				args[key] = true;
			} else {
				args[key] = next;
				i++;
			}
		} else {
			args._.push(a);
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0] || 'help';

	if (cmd === 'help' || args.help) {
		printHelp();
		return;
	}

	if (cmd === 'checksum') {
		const file = args.file;
		if (!file) {
			throw new Error('--file is required for checksum');
		}
		const abs = resolve(file);
		const digest = await sha256File(abs);
		console.log(`sha256:${digest}`);
		console.log(abs);
		return;
	}

	if (cmd === 'validate') {
		const pkg = args.package;
		if (!pkg) {
			throw new Error('--package is required for validate');
		}
		const result = await validatePackageDir(resolve(pkg));
		for (const issue of result.issues) {
			console.log(`[${issue.severity}] ${issue.code}: ${issue.message}`);
		}
		if (!result.ok) {
			process.exitCode = 1;
			console.error('Validation FAILED');
			return;
		}
		console.log(`Validation OK (formatVersion ${result.manifest.formatVersion})`);
		return;
	}

	if (cmd === 'gen-keypair') {
		const keyId = args['key-id'] || args.keyId;
		if (!keyId) {
			throw new Error('--key-id is required for gen-keypair');
		}
		const outDir = resolve(args.out || join(process.cwd(), 'frame-keys'));
		await mkdir(outDir, { recursive: true });
		const result = await generateKeyPairFiles({ outDir, keyId });
		console.log(`Generated Ed25519 key pair for ${keyId}`);
		console.log(`  private: ${result.privatePath}  (KEEP SECRET — do not commit)`);
		console.log(`  public pem: ${result.publicPath}`);
		console.log(`  public json (import into Frame): ${result.publicJsonPath}`);
		return;
	}

	if (cmd === 'sign') {
		const pkg = args.package;
		const privateKey = args['private-key'] || args.privateKey;
		const keyId = args['key-id'] || args.keyId;
		if (!pkg || !privateKey || !keyId) {
			throw new Error('sign requires --package, --private-key, and --key-id');
		}
		const result = await signPackage({
			packageDir: resolve(pkg),
			privateKeyPath: resolve(privateKey),
			keyId,
			signer: args.signer,
		});
		console.log(`Signed package at ${result.packageRoot}`);
		console.log(`  signature: ${result.signaturePath}`);
		console.log(`  keyId: ${result.signature.keyId}`);
		console.log(`  algorithm: ${result.signature.algorithm}`);
		console.log('Import the matching public key JSON into .frame/models/keys/ to verify in Frame IDE.');
		return;
	}

	if (cmd === 'build') {
		const metadataPath = args.metadata;
		if (!metadataPath) {
			throw new Error('--metadata is required for build');
		}
		const outDir = resolve(args.out || join(process.cwd(), 'frame-model-out'));
		const modelPath = args.model ? resolve(args.model) : undefined;
		const packageVersion = args['package-version'];

		const result = await buildPackage({
			metadataPath: resolve(metadataPath),
			modelPath,
			outDir,
			packageVersion,
			toolRoot: ROOT,
		});

		console.log(`Built package at: ${result.packageRoot}`);
		console.log(`  manifest: ${result.manifestPath}`);
		console.log(`  checksums: ${result.checksumsPath}`);
		console.log(`  model stub: ${result.modelStubPath}`);
		console.log(`  formatVersion: ${result.manifest.formatVersion}`);
		console.log(`  id: ${result.manifest.id}`);
		console.log('Note: real weight bytes were NOT copied (offline stub package).');
		return;
	}

	printHelp();
	throw new Error(`Unknown command: ${cmd}`);
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
