/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameObservation,
	IFrameTrackGenerationInput,
	IFrameTrackedGeneration,
} from '../common/models.js';

export const IFrameGenerationTracker = createDecorator<IFrameGenerationTracker>('frameGenerationTracker');

/**
 * Tracks Frame-produced generations and observes only accept / in-range edit / reject.
 * Never monitors arbitrary typing.
 */
export interface IFrameGenerationTracker {
	readonly _serviceBrand: undefined;

	readonly onDidChangeGenerations: Event<void>;

	/** Store a temporary generation when Frame produces text. */
	trackGeneration(input: IFrameTrackGenerationInput): IFrameTrackedGeneration;

	getGeneration(generationId: string): IFrameTrackedGeneration | undefined;

	listGenerations(filter?: { status?: IFrameTrackedGeneration['status'] }): readonly IFrameTrackedGeneration[];

	/**
	 * Insert generation into the active editor at the cursor and start
	 * watching only that range. Records `accepted_generation`.
	 */
	acceptGeneration(generationId: string): Promise<IFrameObservation | undefined>;

	/**
	 * Discard a pending generation without inserting. Records `rejected_generation`.
	 */
	rejectGeneration(generationId: string): Promise<IFrameObservation | undefined>;
}
