/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	FrameEdition,
	FrameModelInstallStatus,
	IFrameModelPackage,
	IFrameModelProfile,
} from '../common/models.js';
import { FRAME_MODEL_PROFILES, getFrameModelProfile } from './frameModelProfiles.js';

/** Placeholder checksum — not derived from real weights. */
export const FRAME_PACKAGE_CHECKSUM_PLACEHOLDER = 'sha256:pending-user-weights';

/**
 * Build catalog packages for Frame Efficient / Professional / Maximum.
 * No weight files are referenced as downloadable URLs.
 */
export function listFrameModelPackages(
	statusById?: ReadonlyMap<string, FrameModelInstallStatus>,
	pathById?: ReadonlyMap<string, string | null>,
): readonly IFrameModelPackage[] {
	return FRAME_MODEL_PROFILES.map(profile => packageFromProfile(
		profile,
		statusById?.get(profile.id) ?? FrameModelInstallStatus.Available,
		pathById?.get(profile.id) ?? null,
	));
}

export function getFrameModelPackage(
	id: string,
	status: FrameModelInstallStatus = FrameModelInstallStatus.Available,
	localPath: string | null = null,
): IFrameModelPackage | undefined {
	const profile = getFrameModelProfile(id);
	return profile ? packageFromProfile(profile, status, localPath) : undefined;
}

export function packageFromProfile(
	profile: IFrameModelProfile,
	status: FrameModelInstallStatus,
	localPath: string | null,
	progress?: number,
): IFrameModelPackage {
	return {
		id: profile.id,
		edition: profile.edition,
		modelName: profile.architecture,
		quantization: profile.quantization,
		storageSizeGb: profile.storageSizeGb,
		memoryRequirementGb: profile.memoryRequirementGb,
		status,
		localPath,
		checksumPlaceholder: FRAME_PACKAGE_CHECKSUM_PLACEHOLDER,
		progress,
		displayName: profile.displayName,
		architecture: profile.architecture,
	};
}

export function editionDisplayName(edition: FrameEdition): string {
	switch (edition) {
		case FrameEdition.Efficient:
			return 'Frame Efficient';
		case FrameEdition.Professional:
			return 'Frame Professional';
		case FrameEdition.Maximum:
			return 'Frame Maximum';
		default:
			return String(edition);
	}
}

/** Simulated install root under the workspace (marker only). */
export function simulatedPackageLocalPath(modelId: string): string {
	return `.frame/models/packages/${modelId}/PACKAGE.frame`;
}
