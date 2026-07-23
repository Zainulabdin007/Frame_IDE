/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameCandidatePreference, IFrameUserPreference } from '../common/models.js';

export const IFramePreferenceReviewService = createDecorator<IFramePreferenceReviewService>('framePreferenceReviewService');

/**
 * User-facing review of candidate preferences.
 * Preferences never become active without explicit approval.
 */
export interface IFramePreferenceReviewService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Candidates awaiting user Approve / Reject (excludes rejected & dismissed). */
	getPendingPreferences(): readonly IFrameCandidatePreference[];

	approvePreference(id: string): Promise<IFrameUserPreference | undefined>;

	rejectPreference(id: string): Promise<IFrameCandidatePreference | undefined>;

	/** Hide from the Learning list without approving (local dismiss). */
	markReviewed(id: string): Promise<void>;
}
