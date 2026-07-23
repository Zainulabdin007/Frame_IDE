/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameEdition,
	FrameModelTrustStatus,
	IFrameModelCompatibilityRequest,
	IFrameModelCompatibilityResult,
	IFrameModelDescriptor,
	IFrameModelProfile,
	IFrameModelRegistrySignature,
} from '../common/models.js';

export const IFrameModelService = createDecorator<IFrameModelService>('frameModelService');

/**
 * Model profile registry for Frame editions.
 *
 * Catalog + `.frame/models/registry.json` only — no downloads, no weight load.
 */
export interface IFrameModelService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeModels: Event<readonly IFrameModelDescriptor[]>;

	/** Built-in Frame Efficient / Professional / Maximum profiles. */
	listProfiles(): readonly IFrameModelProfile[];

	getProfile(id: string): IFrameModelProfile | undefined;

	getProfileByEdition(edition: FrameEdition): IFrameModelProfile | undefined;

	/** Register (install metadata) a catalog profile into the local registry. */
	registerModel(id: string, options?: {
		localPath?: string | null;
		packageVersion?: string;
		checksum?: string;
		trustStatus?: FrameModelTrustStatus;
		signature?: IFrameModelRegistrySignature;
	}): Promise<IFrameModelDescriptor>;

	/** Models marked installed in `.frame/models/registry.json`. */
	listInstalledModels(): readonly IFrameModelDescriptor[];

	/** All catalog profiles with installed/active flags. */
	listModels(): readonly IFrameModelDescriptor[];

	getModel(id: string): IFrameModelDescriptor | undefined;

	getActiveModel(): IFrameModelDescriptor | undefined;

	/** Select active model metadata — does not load weights. */
	selectActiveModel(id: string): Promise<IFrameModelDescriptor | undefined>;

	setModelLocalPath(id: string, localPath: string | null): Promise<IFrameModelDescriptor | undefined>;

	unregisterModel(id: string): Promise<boolean>;

	checkCompatibility(id: string, request?: IFrameModelCompatibilityRequest): IFrameModelCompatibilityResult;

	/** Reload registry from disk. */
	refresh(): Promise<void>;
}
