/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameModelChecksumVerifyResult,
	IFrameModelPackageContents,
	IFrameModelVerifyResult,
	FrameModelTrustStatus,
} from '../common/models.js';

export const IFrameModelVerifierService = createDecorator<IFrameModelVerifierService>('frameModelVerifierService');

/**
 * Offline package verification — checksum recompute + signature metadata.
 * Does not execute packages or load inference.
 */
export interface IFrameModelVerifierService {
	readonly _serviceBrand: undefined;

	verify(pkg: IFrameModelPackageContents, options?: { availableDiskGb?: number }): Promise<IFrameModelVerifyResult>;

	/**
	 * Recompute SHA-256 of package files and compare to checksums.json.
	 */
	verifyChecksums(pkg: IFrameModelPackageContents): Promise<IFrameModelChecksumVerifyResult>;

	/** True when checksum is a known placeholder (allowed for offline stubs). */
	isChecksumPlaceholder(checksum: string): boolean;

	deriveTrustStatus(
		checksum: IFrameModelChecksumVerifyResult,
		signatureStatus: 'unsigned' | 'verified' | 'invalid' | 'unsupported' | 'unknown_key',
	): FrameModelTrustStatus;
}
