/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { access, mkdir, readFile, writeFile, constants as fsConstants } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256FilePrefixed, sha256TextPrefixed } from './checksums.mjs';
import { normalizeMetadata } from './manifest.mjs';

async function exists(path) {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build an offline frame-model package directory.
 * Never copies real weight bytes — writes a stub under model/ and optional source-ref.
 */
export async function buildPackage({ metadataPath, modelPath, outDir, packageVersion }) {
	const raw = JSON.parse(await readFile(metadataPath, 'utf8'));
	const manifest = normalizeMetadata(raw, { packageVersion });

	const packageRoot = join(outDir, 'frame-model');
	const modelDir = join(packageRoot, 'model');
	await mkdir(modelDir, { recursive: true });

	const stubRel = manifest.weightFiles[0] || 'model/weights.placeholder';
	const stubName = stubRel.replace(/^model\//, '');
	const modelStubPath = join(modelDir, stubName);

	const stubBody = [
		'# Frame model weight placeholder',
		'# Real model weights are NOT bundled by the Frame packager.',
		'# Users own their weights; Frame only manages local package metadata.',
		modelPath ? `# Referenced source (not copied): ${modelPath}` : '# No --model path supplied.',
		`# Package id: ${manifest.id}`,
		`# Created: ${new Date().toISOString()}`,
		'',
	].join('\n');

	await writeFile(modelStubPath, stubBody, 'utf8');

	if (modelPath) {
		if (!(await exists(modelPath))) {
			throw new Error(`Model path does not exist: ${modelPath}`);
		}
		// Record source reference only — do not copy weight bytes.
		const sourceRef = {
			format: 'frame-model-source-ref',
			version: 1,
			sourcePath: modelPath,
			sourceBaseName: basename(modelPath),
			note: 'User-owned weights were not copied into this package. Import your weights separately or replace the stub.',
			sourceChecksum: await sha256FilePrefixed(modelPath),
			createdAt: Date.now(),
		};
		await writeFile(join(modelDir, 'source-ref.json'), JSON.stringify(sourceRef, null, 2) + '\n', 'utf8');
	}

	const manifestPath = join(packageRoot, 'manifest.json');
	const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
	await writeFile(manifestPath, manifestJson, 'utf8');

	const checksumFiles = {
		'manifest.json': await sha256TextPrefixed(manifestJson),
		[stubRel]: await sha256FilePrefixed(modelStubPath),
	};

	if (modelPath && (await exists(join(modelDir, 'source-ref.json')))) {
		checksumFiles['model/source-ref.json'] = await sha256FilePrefixed(join(modelDir, 'source-ref.json'));
	}

	const checksums = { version: 1, files: checksumFiles };
	const checksumsPath = join(packageRoot, 'checksums.json');
	await writeFile(checksumsPath, JSON.stringify(checksums, null, 2) + '\n', 'utf8');

	// Optional JSON envelope sibling for tooling tests (not a zip).
	const envelopePath = join(outDir, `${manifest.id}.frame-model`);
	await writeFile(envelopePath, JSON.stringify({
		format: 'frame-model',
		manifest,
		checksums,
		packageRoot,
	}, null, 2) + '\n', 'utf8');

	return {
		outDir,
		packageRoot,
		manifestPath,
		checksumsPath,
		modelStubPath,
		envelopePath,
		manifest,
		checksums,
	};
}
