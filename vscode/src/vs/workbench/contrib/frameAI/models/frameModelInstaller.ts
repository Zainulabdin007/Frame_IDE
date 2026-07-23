/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameEdition,
	IFrameEditionRecommendation,
	IFrameModelPackage,
} from '../common/models.js';

export const IFrameModelInstallerService = createDecorator<IFrameModelInstallerService>('frameModelInstallerService');

/**
 * Simulated model package installer.
 *
 * Lifecycle only — never downloads weights or calls cloud APIs.
 */
export interface IFrameModelInstallerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePackages: Event<readonly IFrameModelPackage[]>;

	listPackages(): readonly IFrameModelPackage[];

	getPackage(id: string): IFrameModelPackage | undefined;

	/**
	 * Simulate install: available → downloading → installed → verified.
	 * Writes a local marker file; does not fetch weights.
	 */
	installPackage(id: string): Promise<IFrameModelPackage>;

	removePackage(id: string): Promise<boolean>;

	verifyInstallation(id: string): Promise<IFrameModelPackage | undefined>;

	/** Mark verified package active via model registry + runtime config. */
	activatePackage(id: string): Promise<IFrameModelPackage | undefined>;

	/**
	 * Recommend Frame Efficient / Professional / Maximum from hardware.
	 */
	recommendBestEdition(): Promise<IFrameEditionRecommendation>;

	recommendBestEditionForEdition(edition: FrameEdition): IFrameEditionRecommendation | undefined;
}
