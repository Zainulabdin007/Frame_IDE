/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameCandidatePreference, IFrameTrainingJob, IFrameUserPreference } from '../common/models.js';

export const IFramePreferenceTrainingService = createDecorator<IFramePreferenceTrainingService>('framePreferenceTrainingService');

export interface IFramePreferenceTrainScheduleResult {
	readonly preference: IFrameUserPreference;
	readonly examplesAdded: number;
	readonly job: IFrameTrainingJob | undefined;
	readonly message: string;
}

/**
 * Closes the preference → LoRA loop:
 * Approve → export local examples → schedule/start on-device train → mark prefs adapter.
 */
export interface IFramePreferenceTrainingService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Last preference-personalization job id (if any). */
	getLastJobId(): string | undefined;

	/**
	 * After a preference is approved into memory: write training rows and
	 * schedule/start a local LoRA job (debounced). Never uploads or downloads.
	 */
	scheduleFromApprovedPreference(
		candidate: IFrameCandidatePreference,
		preference: IFrameUserPreference,
	): Promise<IFramePreferenceTrainScheduleResult>;
}
