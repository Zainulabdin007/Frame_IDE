/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameAdapterPrecisionWarning,
	IFrameModelImportResult,
	IFrameModelPackageContents,
	IFrameModelVerifyResult,
} from '../common/models.js';

export const IFrameModelImportService = createDecorator<IFrameModelImportService>('frameModelImportService');

/**
 * Offline import of user-owned `.frame-model` packages into Frame storage.
 * No network, no inference, no package execution.
 */
export interface IFrameModelImportService {
	readonly _serviceBrand: undefined;

	readonly onDidImport: Event<IFrameModelImportResult>;

	/** Open a local file/folder picker for `.frame-model` packages. */
	pickPackage(): Promise<URI | undefined>;

	readPackage(source: URI): Promise<IFrameModelPackageContents>;

	validatePackage(source: URI): Promise<IFrameModelVerifyResult>;

	/**
	 * Validate + copy into `.frame/models/imported/<id>/` + register.
	 * Does not activate or load weights.
	 */
	importPackage(source: URI, options?: { activate?: boolean }): Promise<IFrameModelImportResult>;

	/** Activate an already-imported/registered model; returns adapter precision warnings. */
	activateImportedModel(modelId: string): Promise<{
		ok: boolean;
		warnings: readonly IFrameAdapterPrecisionWarning[];
	}>;

	checkAdapterPrecisionWarnings(modelId: string): Promise<readonly IFrameAdapterPrecisionWarning[]>;
}
