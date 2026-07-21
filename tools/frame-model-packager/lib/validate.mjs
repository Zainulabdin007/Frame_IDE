/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { access, readFile, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';
import { FRAME_MODEL_FORMAT_VERSION, validateFormatVersion } from './manifest.mjs';

async function exists(path) {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate a built package directory (frame-model/ or parent containing it).
 */
export async function validatePackageDir(dir) {
	const issues = [];
	let packageRoot = dir;
	if (await exists(join(dir, 'frame-model', 'manifest.json'))) {
		packageRoot = join(dir, 'frame-model');
	} else if (!(await exists(join(dir, 'manifest.json')))) {
		return {
			ok: false,
			manifest: null,
			issues: [{
				severity: 'error',
				code: 'manifest.missing',
				message: 'manifest.json not found (expected frame-model/manifest.json).',
			}],
		};
	}

	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
	} catch (err) {
		return {
			ok: false,
			manifest: null,
			issues: [{
				severity: 'error',
				code: 'manifest.invalid',
				message: `Cannot read manifest.json: ${err instanceof Error ? err.message : String(err)}`,
			}],
		};
	}

	if (manifest.format !== 'frame-model') {
		issues.push({ severity: 'error', code: 'manifest.format', message: 'format must be "frame-model".' });
	}
	issues.push(...validateFormatVersion(Number(manifest.formatVersion) || 0));

	for (const key of ['id', 'modelName', 'architecture', 'quantization', 'packageVersion']) {
		if (!manifest[key]) {
			issues.push({ severity: 'error', code: `manifest.${key}`, message: `manifest.${key} is required.` });
		}
	}
	if (manifest.memoryRequirementGb === undefined && manifest.requiredMemoryGb === undefined) {
		issues.push({ severity: 'error', code: 'manifest.memory', message: 'required memory (memoryRequirementGb) is required.' });
	}
	if (!manifest.modelFamily) {
		issues.push({ severity: 'warning', code: 'manifest.modelFamily', message: 'modelFamily is recommended.' });
	}
	if (!manifest.parameterCount) {
		issues.push({ severity: 'warning', code: 'manifest.parameterCount', message: 'parameterCount is recommended.' });
	}
	if (!Array.isArray(manifest.compatibleRuntimes) || !manifest.compatibleRuntimes.length) {
		issues.push({ severity: 'warning', code: 'manifest.runtimes', message: 'compatibleRuntimes should list backends.' });
	}
	if (!manifest.signature || manifest.signature.algorithm === 'none') {
		issues.push({
			severity: 'info',
			code: 'signature.placeholder',
			message: 'signature is a placeholder — cryptography not implemented.',
		});
	}

	if (!(await exists(join(packageRoot, 'checksums.json')))) {
		issues.push({ severity: 'error', code: 'checksums.missing', message: 'checksums.json is required.' });
	} else {
		try {
			const checksums = JSON.parse(await readFile(join(packageRoot, 'checksums.json'), 'utf8'));
			if (!checksums.files || typeof checksums.files !== 'object') {
				issues.push({ severity: 'error', code: 'checksums.files', message: 'checksums.files map is required.' });
			}
		} catch {
			issues.push({ severity: 'error', code: 'checksums.invalid', message: 'checksums.json is not valid JSON.' });
		}
	}

	const modelDir = join(packageRoot, 'model');
	if (!(await exists(modelDir))) {
		issues.push({ severity: 'warning', code: 'model.dir', message: 'model/ directory is missing.' });
	}

	const weightFiles = Array.isArray(manifest.weightFiles) ? manifest.weightFiles : [];
	for (const rel of weightFiles) {
		const abs = join(packageRoot, rel);
		if (!(await exists(abs))) {
			issues.push({
				severity: 'warning',
				code: 'weights.missing',
				message: `Listed weight file missing (placeholder OK): ${rel}`,
			});
		}
	}

	if (Number(manifest.formatVersion) === FRAME_MODEL_FORMAT_VERSION) {
		issues.push({
			severity: 'info',
			code: 'formatVersion.current',
			message: `formatVersion ${FRAME_MODEL_FORMAT_VERSION} is current.`,
		});
	}

	return {
		ok: !issues.some(i => i.severity === 'error'),
		manifest,
		issues,
		packageRoot,
	};
}
