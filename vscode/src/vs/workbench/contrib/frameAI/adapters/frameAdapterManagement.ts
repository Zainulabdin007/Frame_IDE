/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameAdapterCompatibilityResult,
	IFrameAdapterDescriptor,
	IFrameAdapterExportPackage,
	IFrameAdapterMetadata,
} from '../common/models.js';

export const IFrameAdapterManagementService = createDecorator<IFrameAdapterManagementService>('frameAdapterManagementService');

/** UI list row for the Frame AI Adapters panel. */
export interface IFrameAdapterListItem {
	readonly descriptor: IFrameAdapterDescriptor;
	readonly compatible: boolean;
	readonly compatibility: IFrameAdapterCompatibilityResult;
	readonly imported: boolean;
	/** True when a real `.gguf` / `.safetensors` file is on disk. */
	readonly weightsLinked: boolean;
	readonly weightBytes?: number;
	/** Workspace-relative folder, e.g. `.frame/adapters/<id>`. */
	readonly storagePath?: string;
}

export interface IFrameAdapterGroups {
	readonly active: readonly IFrameAdapterListItem[];
	readonly available: readonly IFrameAdapterListItem[];
	readonly imported: readonly IFrameAdapterListItem[];
}

export interface IFrameAdapterDetails {
	readonly descriptor: IFrameAdapterDescriptor;
	readonly metadata: IFrameAdapterMetadata;
	readonly compatibility: IFrameAdapterCompatibilityResult;
	readonly weightsLinked: boolean;
	readonly weightAbsolutePath?: string;
	readonly weightBytes?: number;
}

export interface IFrameAdapterPackageValidation {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly pkg?: IFrameAdapterExportPackage;
}

/**
 * User-facing adapter management helpers for the Frame AI sidebar.
 * All mutations delegate to {@link IFrameAdapterService} — no training / models.
 */
export interface IFrameAdapterManagementService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	getGroupedAdapters(): IFrameAdapterGroups;

	getDetails(id: string): Promise<IFrameAdapterDetails | undefined>;

	activate(id: string): Promise<IFrameAdapterDescriptor | undefined>;

	deactivate(id: string): Promise<IFrameAdapterDescriptor | undefined>;

	remove(id: string): Promise<boolean>;

	exportAdapter(id: string): Promise<IFrameAdapterExportPackage | undefined>;

	/** Parse + validate a portable package JSON string (does not import). */
	validatePackageJson(raw: string): IFrameAdapterPackageValidation;

	importPackageJson(raw: string, options?: { activate?: boolean }): Promise<IFrameAdapterDescriptor>;

	/**
	 * Copy a real `.gguf` / `.safetensors` weight file into the adapter folder.
	 * Prefer GGUF for node-llama-cpp.
	 */
	importWeightFile(adapterId: string, absoluteSourcePath: string): Promise<IFrameAdapterDescriptor | undefined>;

	/** Create a new adapter from a weight file (Browse / drop). */
	importWeightAsAdapter(absoluteSourcePath: string, options?: { activate?: boolean; name?: string }): Promise<IFrameAdapterDescriptor>;

	/** Copy linked weight file to an absolute path for reuse in other projects. */
	exportWeightFile(adapterId: string, absoluteDestPath: string): Promise<string>;

	/** Absolute path of linked weight file, if present. */
	resolveWeightPath(adapterId: string): Promise<string | undefined>;

	refresh(): Promise<void>;
}
