/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Keep in sync with FRAME_MODEL_FORMAT_VERSION in frameAI/common/models.ts */
export const FRAME_MODEL_FORMAT_VERSION = 2;
export const FRAME_MODEL_FORMAT_VERSION_MIN = 1;

export function createUnsignedSignature() {
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

export function normalizeMetadata(raw, overrides = {}) {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Metadata must be a JSON object.');
	}
	const id = String(raw.id || '').trim();
	if (!id) {
		throw new Error('metadata.id is required.');
	}
	const edition = String(raw.edition || 'efficient').toLowerCase();
	const precision = String(raw.precision || raw.quantization || '4-bit');
	const architecture = String(raw.architecture || raw.modelFamily || 'qwen2.5-coder-7b');
	const modelFamily = String(raw.modelFamily || architecture);
	const parameterCount = String(raw.parameterCount || '7B');
	const packageVersion = String(overrides.packageVersion || raw.packageVersion || '1.0.0');
	const compatibleRuntimes = Array.isArray(raw.compatibleRuntimes)
		? raw.compatibleRuntimes
		: ['stub', 'llamacpp', 'mlx'];

	return {
		format: 'frame-model',
		formatVersion: FRAME_MODEL_FORMAT_VERSION,
		id,
		edition,
		modelName: String(raw.modelName || raw.name || id),
		architecture,
		modelFamily,
		parameterCount,
		precision,
		quantization: String(raw.quantization || precision),
		packageVersion,
		storageSizeGb: Number(raw.storageSizeGb) || 0,
		memoryRequirementGb: Number(raw.memoryRequirementGb || raw.requiredMemoryGb) || 0,
		weightFiles: Array.isArray(raw.weightFiles) && raw.weightFiles.length
			? raw.weightFiles.map(String)
			: ['model/weights.placeholder'],
		description: raw.description ? String(raw.description) : undefined,
		compatibleRuntimes,
		signature: raw.signature && typeof raw.signature === 'object'
			? {
				algorithm: raw.signature.algorithm === 'pending' ? 'pending' : 'none',
				value: raw.signature.value ?? null,
				signedAt: raw.signature.signedAt ?? null,
				keyId: raw.signature.keyId ?? null,
				note: raw.signature.note || 'Signature placeholder — cryptography not implemented.',
			}
			: createUnsignedSignature(),
	};
}

export function validateFormatVersion(formatVersion) {
	const issues = [];
	if (!Number.isFinite(formatVersion) || formatVersion < FRAME_MODEL_FORMAT_VERSION_MIN) {
		issues.push({
			severity: 'error',
			code: 'formatVersion.tooOld',
			message: `formatVersion ${formatVersion} is below minimum ${FRAME_MODEL_FORMAT_VERSION_MIN}.`,
		});
	} else if (formatVersion > FRAME_MODEL_FORMAT_VERSION) {
		issues.push({
			severity: 'error',
			code: 'formatVersion.tooNew',
			message: `formatVersion ${formatVersion} is newer than supported ${FRAME_MODEL_FORMAT_VERSION}.`,
		});
	} else if (formatVersion < FRAME_MODEL_FORMAT_VERSION) {
		issues.push({
			severity: 'info',
			code: 'formatVersion.migrate',
			message: `Manifest formatVersion ${formatVersion} can migrate to ${FRAME_MODEL_FORMAT_VERSION}.`,
		});
	}
	return issues;
}
