/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	FramePreferenceLifecycle,
	IFrameCandidatePreference,
	IFrameObservation,
	IFrameRecordObservationInput,
	IFrameUserPreference,
} from '../common/models.js';

export const IFrameObservationService = createDecorator<IFrameObservationService>('frameObservationService');

/**
 * Preference Observation Engine — records coding behavior signals and
 * manages candidate preferences. Does not train models or apply edits.
 */
export interface IFrameObservationService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	recordObservation(input: IFrameRecordObservationInput): Promise<IFrameObservation>;

	listObservations(limit?: number): readonly IFrameObservation[];

	getCandidatePreferences(filter?: { lifecycle?: FramePreferenceLifecycle }): readonly IFrameCandidatePreference[];

	approvePreference(candidateId: string): Promise<IFrameUserPreference | undefined>;

	rejectPreference(candidateId: string): Promise<IFrameCandidatePreference | undefined>;

	/** Re-run analyzer over stored observations (local heuristics only). */
	reanalyze(): Promise<readonly IFrameCandidatePreference[]>;
}
