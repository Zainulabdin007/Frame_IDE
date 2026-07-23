/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FrameAdapterScope,
	FrameAdapterState,
	IFrameAdapterCompatibilityRequest,
	IFrameAdapterCompatibilityResult,
	IFrameAdapterDescriptor,
	IFrameAdapterExportPackage,
	IFrameAdapterMetadata,
	IFrameRegisterAdapterInput,
} from '../common/models.js';

export const IFrameAdapterService = createDecorator<IFrameAdapterService>('frameAdapterService');

/**
 * Adapter lifecycle registry for LoRA side-cars under `.frame/adapters/`.
 * Metadata + WEIGHTS.md instructions on register; real weights via {@link importWeightFile}.
 */
export interface IFrameAdapterService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeAdapters: Event<readonly IFrameAdapterDescriptor[]>;

	/** Scan `.frame/adapters/` and refresh the in-memory registry. */
	discover(folder?: URI): Promise<readonly IFrameAdapterDescriptor[]>;

	listAdapters(): readonly IFrameAdapterDescriptor[];

	getAdapter(id: string): IFrameAdapterDescriptor | undefined;

	/** Register (and persist) an adapter. Writes WEIGHTS.md (no fake weight bytes). */
	registerAdapter(input: IFrameRegisterAdapterInput): Promise<IFrameAdapterDescriptor>;

	/** Load on-disk metadata.json for an adapter. */
	loadMetadata(id: string): Promise<IFrameAdapterMetadata | undefined>;

	setAdapterState(id: string, state: FrameAdapterState): Promise<IFrameAdapterDescriptor | undefined>;

	removeAdapter(id: string): Promise<boolean>;

	/** @deprecated Prefer {@link removeAdapter}. */
	unregisterAdapter(id: string): Promise<boolean>;

	checkCompatibility(id: string, request: IFrameAdapterCompatibilityRequest): IFrameAdapterCompatibilityResult;

	exportAdapter(id: string): Promise<IFrameAdapterExportPackage | undefined>;

	importAdapter(pkg: IFrameAdapterExportPackage, options?: { activate?: boolean; folder?: URI }): Promise<IFrameAdapterDescriptor>;

	/**
	 * Copy a real weight file into `.frame/adapters/<id>/` and update metadata.
	 * Accepts `.gguf` (preferred) or `.safetensors`. Rejects tiny / text placeholders.
	 */
	importWeightFile(adapterId: string, absoluteSourcePath: string): Promise<IFrameAdapterDescriptor | undefined>;

	/**
	 * Register a new adapter from a weight file and copy it under `.frame/adapters/<id>/`.
	 * Used by sidebar Browse / drag-drop.
	 */
	importWeightAsAdapter(absoluteSourcePath: string, options?: {
		activate?: boolean;
		name?: string;
		scope?: FrameAdapterScope;
	}): Promise<IFrameAdapterDescriptor>;

	/** Absolute URI of the linked weight file when present on disk. */
	resolveWeightUri(adapterId: string): Promise<URI | undefined>;

	/**
	 * Copy the linked weight file to an absolute destination path (for other projects).
	 * Throws if no real weights are linked.
	 */
	exportWeightFile(adapterId: string, absoluteDestPath: string): Promise<URI>;
}
