/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { FrameEdition, FrameRuntimeKind, IFrameModelProfile } from '../common/models.js';

/**
 * Built-in Frame edition profiles (metadata only).
 * No weights are bundled or downloaded — users supply paths later.
 *
 * Primary ids match runtime.json `activeModelId` (e.g. qwen-coder-7b-q4).
 */
export const FRAME_MODEL_PROFILES: readonly IFrameModelProfile[] = [
	{
		id: 'qwen-coder-7b-q4',
		edition: FrameEdition.Efficient,
		name: 'Frame Efficient',
		displayName: 'Frame Efficient — Qwen 7B 4-bit',
		architecture: 'qwen2.5-coder-7b',
		precision: '4-bit',
		quantization: '4-bit',
		memoryRequirementGb: 6,
		storageSizeGb: 4,
		compatibleRuntimes: ['llamacpp', 'mlx', 'stub'],
		description: 'Lowest memory footprint. Intended for laptops with limited RAM. Weights are user-provided.',
	},
	{
		id: 'qwen-coder-7b-q8',
		edition: FrameEdition.Professional,
		name: 'Frame Professional',
		displayName: 'Frame Professional — Qwen 7B 8-bit',
		architecture: 'qwen2.5-coder-7b',
		precision: '8-bit',
		quantization: '8-bit',
		memoryRequirementGb: 10,
		storageSizeGb: 7,
		compatibleRuntimes: ['llamacpp', 'mlx', 'stub'],
		description: 'Balanced quality and memory. Weights are user-provided.',
	},
	{
		id: 'qwen-coder-7b-fp16',
		edition: FrameEdition.Maximum,
		name: 'Frame Maximum',
		displayName: 'Frame Maximum — Qwen 7B FP16',
		architecture: 'qwen2.5-coder-7b',
		precision: 'fp16',
		quantization: 'none (fp16)',
		memoryRequirementGb: 16,
		storageSizeGb: 14,
		compatibleRuntimes: ['llamacpp', 'mlx', 'stub'] as readonly FrameRuntimeKind[],
		description: 'Highest fidelity profile. Requires more RAM/VRAM. Weights are user-provided.',
	},
];

/** Legacy ids from earlier milestones → current profile ids. */
const PROFILE_ALIASES: Readonly<Record<string, string>> = {
	'frame-efficient-qwen7b': 'qwen-coder-7b-q4',
	'frame-professional-qwen7b': 'qwen-coder-7b-q8',
	'frame-maximum-qwen7b': 'qwen-coder-7b-fp16',
};

export function resolveFrameModelId(id: string): string {
	return PROFILE_ALIASES[id] ?? id;
}

export function getFrameModelProfile(id: string): IFrameModelProfile | undefined {
	const resolved = resolveFrameModelId(id);
	return FRAME_MODEL_PROFILES.find(p => p.id === resolved);
}

export function getFrameModelProfileByEdition(edition: FrameEdition): IFrameModelProfile | undefined {
	return FRAME_MODEL_PROFILES.find(p => p.edition === edition);
}
