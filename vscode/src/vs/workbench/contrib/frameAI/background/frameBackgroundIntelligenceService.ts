/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { runWhenGlobalIdle } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFrameKnowledgeService } from '../knowledge/frameKnowledgeService.js';
import { IFrameObservationService } from '../preferences/frameObservation.js';
import { IFramePreferenceReviewService } from '../preferences/framePreferenceReview.js';
import { IFrameRagService } from '../rag/frameRag.js';
import {
	IFrameBackgroundIntelligence,
	IFrameBackgroundIntelligenceStatus,
} from './frameBackgroundIntelligence.js';

/** Reindex RAG when the last index is older than this (6 hours). */
const RAG_STALE_MS = 6 * 60 * 60 * 1000;
/** Delay before first idle pass after DI construction. */
const STARTUP_IDLE_TIMEOUT_MS = 8_000;
/** Recurring background passes (15 minutes). */
const RECURRING_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Background Intelligence Engine — local idle maintenance only.
 * Uses knowledge, RAG, observation, and preference-review services.
 * Never downloads, never opens network sockets.
 */
export class FrameBackgroundIntelligenceService extends Disposable implements IFrameBackgroundIntelligence {

	declare readonly _serviceBrand: undefined;

	private _running = false;
	private _queued = false;
	private _lastRunAt: number | null = null;
	private _lastAction: string | undefined;
	private _passCount = 0;

	constructor(
		@IFrameKnowledgeService private readonly knowledge: IFrameKnowledgeService,
		@IFrameRagService private readonly rag: IFrameRagService,
		@IFrameObservationService private readonly observations: IFrameObservationService,
		@IFramePreferenceReviewService private readonly preferenceReview: IFramePreferenceReviewService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[FrameBackground] Engine registered — scheduling idle pass (local only)');
		this._register(runWhenGlobalIdle(() => {
			void this.runIdlePass();
		}, STARTUP_IDLE_TIMEOUT_MS));

		const intervalHandle = setInterval(() => {
			runWhenGlobalIdle(() => {
				void this.runIdlePass();
			});
		}, RECURRING_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(intervalHandle)));
		this.logService.info(`[FrameBackground] Recurring idle passes every ${RECURRING_INTERVAL_MS / 60_000} min`);
	}

	getStatus(): IFrameBackgroundIntelligenceStatus {
		return {
			running: this._running,
			lastRunAt: this._lastRunAt,
			lastAction: this._lastAction,
		};
	}

	async runIdlePass(): Promise<void> {
		if (this._running) {
			this._queued = true;
			return;
		}
		this._running = true;
		this._passCount += 1;
		const pass = this._passCount;
		this._lastAction = 'starting';
		this.logService.info(`[FrameBackground] Idle pass #${pass} starting (local only)`);
		try {
			this._lastAction = 'knowledge.ensureIndexed';
			await this.knowledge.ensureIndexed();

			const ragStatus = this.rag.getStatus();
			const stale = !ragStatus.ready
				|| !ragStatus.lastIndexedAt
				|| (Date.now() - ragStatus.lastIndexedAt) > RAG_STALE_MS;
			if (stale) {
				this._lastAction = 'rag.reindex';
				await this.rag.reindex();
			}

			this._lastAction = 'observations.reanalyze';
			await this.observations.reanalyze();

			const pending = this.preferenceReview.getPendingPreferences();
			this._lastAction = `preferenceCandidates:${pending.length}`;
			this._lastRunAt = Date.now();
			this.logService.info(
				`[FrameBackground] Idle pass #${pass} complete — prefs pending=${pending.length} ragReady=${this.rag.getStatus().ready}`,
			);
		} catch (err) {
			this._lastAction = `error:${err instanceof Error ? err.message : String(err)}`;
			this.logService.warn(`[FrameBackground] Idle pass #${pass} failed (local only)`, err);
		} finally {
			this._running = false;
			if (this._queued) {
				this._queued = false;
				void this.runIdlePass();
			}
		}
	}
}
