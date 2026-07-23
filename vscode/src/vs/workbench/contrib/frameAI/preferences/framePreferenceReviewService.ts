/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FramePreferenceLifecycle,
	IFrameCandidatePreference,
	IFrameUserPreference,
} from '../common/models.js';
import { IFrameObservationService } from './frameObservation.js';
import { IFramePreferenceReviewService } from './framePreferenceReview.js';

interface IReviewDismissState {
	readonly dismissedIds: string[];
}

/**
 * Review facade over the observation engine.
 * Approve → PersistentMemory active preference.
 * Reject / markReviewed → hidden from pending list.
 */
export class FramePreferenceReviewService extends Disposable implements IFramePreferenceReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly _dismissed = new Set<string>();
	private _folder: URI | undefined;
	private _loadPromise: Promise<void> | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFrameObservationService private readonly observations: IFrameObservationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.observations.onDidChange(() => this._onDidChange.fire()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._loadPromise = undefined;
			this._folder = undefined;
			this._dismissed.clear();
			void this.ensureLoaded();
		}));
		void this.ensureLoaded();
	}

	getPendingPreferences(): readonly IFrameCandidatePreference[] {
		return this.observations
			.getCandidatePreferences({ lifecycle: FramePreferenceLifecycle.Candidate })
			.filter(c => !this._dismissed.has(c.id))
			.sort((a, b) => b.confidence - a.confidence || b.observationCount - a.observationCount);
	}

	async approvePreference(id: string): Promise<IFrameUserPreference | undefined> {
		await this.ensureLoaded();
		this._dismissed.delete(id);
		const result = await this.observations.approvePreference(id);
		await this.persistDismissed();
		this._onDidChange.fire();
		if (result) {
			this.logService.info(`[FramePreferenceReview] Approved → active memory: ${result.preference}`);
		}
		return result;
	}

	async rejectPreference(id: string): Promise<IFrameCandidatePreference | undefined> {
		await this.ensureLoaded();
		const result = await this.observations.rejectPreference(id);
		this._dismissed.add(id);
		await this.persistDismissed();
		this._onDidChange.fire();
		if (result) {
			this.logService.info(`[FramePreferenceReview] Rejected (will not resurface): ${result.preference}`);
		}
		return result;
	}

	async markReviewed(id: string): Promise<void> {
		await this.ensureLoaded();
		this._dismissed.add(id);
		await this.persistDismissed();
		this._onDidChange.fire();
	}

	private async ensureLoaded(): Promise<void> {
		if (!this._loadPromise) {
			const pending = this.loadDismissed().finally(() => {
				if (this._loadPromise === pending) {
					this._loadPromise = undefined;
				}
			});
			this._loadPromise = pending;
		}
		await this._loadPromise;
	}

	private async loadDismissed(): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		this._folder = folder;
		try {
			const buf = await this.fileService.readFile(joinPath(folder, '.frame', 'memory', 'preference-review.json'));
			const parsed = JSON.parse(buf.value.toString()) as IReviewDismissState;
			if (Array.isArray(parsed.dismissedIds)) {
				for (const id of parsed.dismissedIds) {
					this._dismissed.add(id);
				}
			}
		} catch {
			// none yet
		}
	}

	private async persistDismissed(): Promise<void> {
		const folder = this._folder ?? this.primaryFolder();
		if (!folder) {
			return;
		}
		this._folder = folder;
		const root = joinPath(folder, '.frame', 'memory');
		try {
			await this.fileService.createFolder(joinPath(folder, '.frame'));
		} catch { /* exists */ }
		try {
			await this.fileService.createFolder(root);
		} catch { /* exists */ }

		const state: IReviewDismissState = {
			dismissedIds: [...this._dismissed],
		};
		await this.fileService.writeFile(
			joinPath(root, 'preference-review.json'),
			VSBuffer.fromString(JSON.stringify(state, null, 2) + '\n'),
		);
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}
}
