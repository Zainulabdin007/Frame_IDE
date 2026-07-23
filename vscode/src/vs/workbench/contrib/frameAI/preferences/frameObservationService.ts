/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FrameObservationChangeType,
	FramePersistentMemoryKind,
	FramePreferenceLifecycle,
	IFrameCandidatePreference,
	IFrameObservation,
	IFrameRecordObservationInput,
	IFrameUserPreference,
} from '../common/models.js';
import { IFramePersistentMemoryService } from '../memory/persistentMemory.js';
import { IFrameObservationService } from './frameObservation.js';
import { PreferenceAnalyzer } from './preferenceAnalyzer.js';

/** Min observations before Observed → Candidate. */
const CANDIDATE_MIN_OBSERVATIONS = 2;
/** Min distinct sessions boosts confidence (approval still required). */
const CONFIRM_MIN_SESSIONS = 2;
/** Confidence floor to surface as candidate. */
const CANDIDATE_MIN_CONFIDENCE = 0.45;

/**
 * Records observations, extracts candidate preferences, and promotes
 * approved ones into `.frame/memory/preferences.json` via persistent memory.
 */
export class FrameObservationService extends Disposable implements IFrameObservationService {

	declare readonly _serviceBrand: undefined;

	private readonly analyzer = new PreferenceAnalyzer();
	private readonly _observations = new Map<string, IFrameObservation>();
	private readonly _candidates = new Map<string, IFrameCandidatePreference>();
	private _folder: URI | undefined;
	private _loadPromise: Promise<void> | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFramePersistentMemoryService private readonly persistentMemory: IFramePersistentMemoryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._loadPromise = undefined;
			this._folder = undefined;
			this._observations.clear();
			this._candidates.clear();
			void this.ensureLoaded();
		}));
		void this.ensureLoaded();
	}

	async recordObservation(input: IFrameRecordObservationInput): Promise<IFrameObservation> {
		await this.ensureLoaded();

		const observation: IFrameObservation = {
			id: generateUuid(),
			timestamp: input.timestamp ?? Date.now(),
			project: input.project ?? this.workspaceService.getWorkspace().name,
			language: input.language,
			file: input.file,
			before: input.before,
			after: input.after,
			changeType: input.changeType,
			confidence: clamp01(input.confidence ?? defaultConfidence(input.changeType)),
			sessionId: input.sessionId,
			taskId: input.taskId,
			generationId: input.generationId,
			diffSummary: input.diffSummary,
		};

		const hits = this.analyzer.analyzeObservation(observation);
		const withSignals: IFrameObservation = {
			...observation,
			signalIds: hits.map(h => h.signalId),
		};
		this._observations.set(withSignals.id, withSignals);

		for (const hit of hits) {
			this.ingestSignal(hit.signalId, hit.preference, hit.language, hit.confidence, withSignals, hit.beforeSnippet, hit.afterSnippet);
		}

		await this.persist();
		this._onDidChange.fire();
		this.logService.trace(`[FrameObservation] Recorded ${withSignals.changeType} (${hits.length} signals)`);
		return withSignals;
	}

	listObservations(limit = 200): readonly IFrameObservation[] {
		return [...this._observations.values()]
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, limit);
	}

	getCandidatePreferences(filter?: { lifecycle?: FramePreferenceLifecycle }): readonly IFrameCandidatePreference[] {
		let list = [...this._candidates.values()];
		if (filter?.lifecycle) {
			list = list.filter(c => c.lifecycle === filter.lifecycle);
		} else {
			// Default: surface candidates awaiting approval (not rejected/active)
			list = list.filter(c =>
				c.lifecycle === FramePreferenceLifecycle.Candidate
				|| c.lifecycle === FramePreferenceLifecycle.Observed
				|| c.lifecycle === FramePreferenceLifecycle.Confirmed,
			);
		}
		return list.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
	}

	async approvePreference(candidateId: string): Promise<IFrameUserPreference | undefined> {
		await this.ensureLoaded();
		const candidate = this._candidates.get(candidateId);
		if (!candidate) {
			return undefined;
		}
		if (candidate.lifecycle === FramePreferenceLifecycle.Rejected) {
			return undefined;
		}

		const confirmed: IFrameCandidatePreference = {
			...candidate,
			lifecycle: FramePreferenceLifecycle.Confirmed,
			updatedAt: Date.now(),
			confidence: Math.max(candidate.confidence, 0.75),
		};
		this._candidates.set(candidateId, confirmed);

		const memoryPref = await this.persistentMemory.savePreference({
			id: candidate.memoryPreferenceId ?? generateUuid(),
			preference: confirmed.preference,
			language: confirmed.language,
			confidence: confirmed.confidence,
			observations: confirmed.observationCount,
			accepted: Math.max(1, confirmed.observationCount),
			rejected: 0,
			tags: ['preference', 'active', 'observation-engine', confirmed.signalId],
		});

		const active: IFrameCandidatePreference = {
			...confirmed,
			lifecycle: FramePreferenceLifecycle.Active,
			memoryPreferenceId: memoryPref.id,
			updatedAt: Date.now(),
		};
		this._candidates.set(candidateId, active);

		await this.persist();
		this._onDidChange.fire();
		this.logService.info(`[FrameObservation] Preference activated: ${active.preference}`);
		return memoryPref;
	}

	async rejectPreference(candidateId: string): Promise<IFrameCandidatePreference | undefined> {
		await this.ensureLoaded();
		const candidate = this._candidates.get(candidateId);
		if (!candidate) {
			return undefined;
		}

		const rejected: IFrameCandidatePreference = {
			...candidate,
			lifecycle: FramePreferenceLifecycle.Rejected,
			confidence: Math.min(candidate.confidence, 0.2),
			updatedAt: Date.now(),
		};
		this._candidates.set(candidateId, rejected);

		if (candidate.memoryPreferenceId) {
			const existing = this.persistentMemory.get(candidate.memoryPreferenceId);
			if (existing && existing.kind === FramePersistentMemoryKind.Preference) {
				await this.persistentMemory.update(candidate.memoryPreferenceId, {
					rejected: (existing.rejected ?? 0) + 1,
					confidence: Math.min(existing.confidence, 0.2),
					tags: [...(existing.tags ?? []).filter(t => t !== 'active'), 'rejected'],
				});
			}
		}

		await this.persist();
		this._onDidChange.fire();
		return rejected;
	}

	async reanalyze(): Promise<readonly IFrameCandidatePreference[]> {
		await this.ensureLoaded();
		const preserved = new Map<string, IFrameCandidatePreference>();
		for (const [key, candidate] of this._candidates) {
			if (candidate.lifecycle === FramePreferenceLifecycle.Active
				|| candidate.lifecycle === FramePreferenceLifecycle.Rejected) {
				preserved.set(key, candidate);
			}
		}
		this._candidates.clear();
		for (const [key, candidate] of preserved) {
			this._candidates.set(key, candidate);
		}
		for (const observation of this._observations.values()) {
			const hits = this.analyzer.analyzeObservation(observation);
			for (const hit of hits) {
				this.ingestSignal(hit.signalId, hit.preference, hit.language, hit.confidence, observation, hit.beforeSnippet, hit.afterSnippet);
			}
		}
		await this.persist();
		this._onDidChange.fire();
		return this.getCandidatePreferences();
	}

	private ingestSignal(
		signalId: string,
		preference: string,
		language: string | undefined,
		hitConfidence: number,
		observation: IFrameObservation,
		beforeSnippet: string,
		afterSnippet: string,
	): void {
		const key = candidateKey(signalId, language);
		const existing = this._candidates.get(key);
		const sessionId = observation.sessionId ?? `anon-${observation.id.slice(0, 8)}`;

		if (!existing) {
			this._candidates.set(key, {
				id: key,
				preference,
				signalId,
				language,
				lifecycle: FramePreferenceLifecycle.Observed,
				observationIds: [observation.id],
				sessionIds: [sessionId],
				observationCount: 1,
				confidence: hitConfidence,
				examples: [{ before: beforeSnippet, after: afterSnippet }],
				createdAt: observation.timestamp,
				updatedAt: observation.timestamp,
			});
			return;
		}

		if (existing.lifecycle === FramePreferenceLifecycle.Rejected || existing.lifecycle === FramePreferenceLifecycle.Active) {
			// Still accumulate counts for future training signals, but don't revive automatically
			const observationIds = unique([...existing.observationIds, observation.id]);
			const sessionIds = unique([...existing.sessionIds, sessionId]);
			this._candidates.set(key, {
				...existing,
				observationIds,
				sessionIds,
				observationCount: observationIds.length,
				updatedAt: Date.now(),
			});
			return;
		}

		const observationIds = unique([...existing.observationIds, observation.id]);
		const sessionIds = unique([...existing.sessionIds, sessionId]);
		const observationCount = observationIds.length;
		const confidence = scoreConfidence(hitConfidence, observationCount, sessionIds.length, observation.changeType);
		const examples = [...(existing.examples ?? []), { before: beforeSnippet, after: afterSnippet }].slice(-5);

		let lifecycle = existing.lifecycle;
		if (observationCount >= CANDIDATE_MIN_OBSERVATIONS && confidence >= CANDIDATE_MIN_CONFIDENCE) {
			lifecycle = FramePreferenceLifecycle.Candidate;
		}
		// Confirmed requires explicit user approval — never auto-promote past Candidate

		this._candidates.set(key, {
			...existing,
			preference,
			lifecycle,
			observationIds,
			sessionIds,
			observationCount,
			confidence,
			examples,
			updatedAt: Date.now(),
		});
	}

	private async ensureLoaded(): Promise<void> {
		if (!this._loadPromise) {
			const pending = this.loadFromDisk().finally(() => {
				if (this._loadPromise === pending) {
					this._loadPromise = undefined;
				}
			});
			this._loadPromise = pending;
		}
		await this._loadPromise;
	}

	private async loadFromDisk(): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		this._folder = folder;
		const root = joinPath(folder, '.frame', 'memory');
		try {
			const obsBuf = await this.fileService.readFile(joinPath(root, 'observations.jsonl'));
			for (const line of obsBuf.value.toString().split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				const row = JSON.parse(trimmed) as IFrameObservation;
				this._observations.set(row.id, row);
			}
		} catch {
			// none yet
		}
		try {
			const candBuf = await this.fileService.readFile(joinPath(root, 'candidate-preferences.json'));
			const parsed = JSON.parse(candBuf.value.toString()) as IFrameCandidatePreference[];
			if (Array.isArray(parsed)) {
				for (const row of parsed) {
					this._candidates.set(row.id, row);
				}
			}
		} catch {
			// none yet
		}
		this.logService.info(`[FrameObservation] Loaded ${this._observations.size} observations, ${this._candidates.size} candidates`);
	}

	private async persist(): Promise<void> {
		const folder = this._folder ?? this.primaryFolder();
		if (!folder) {
			return;
		}
		this._folder = folder;
		const root = joinPath(folder, '.frame', 'memory');
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(root);

		const obsLines = [...this._observations.values()]
			.sort((a, b) => a.timestamp - b.timestamp)
			.map(o => JSON.stringify(o))
			.join('\n') + (this._observations.size ? '\n' : '');
		await this.fileService.writeFile(joinPath(root, 'observations.jsonl'), VSBuffer.fromString(obsLines));

		const candidates = [...this._candidates.values()];
		await this.fileService.writeFile(
			joinPath(root, 'candidate-preferences.json'),
			VSBuffer.fromString(JSON.stringify(candidates, null, 2) + '\n'),
		);
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}

function candidateKey(signalId: string, language: string | undefined): string {
	return `${signalId}::${(language ?? 'any').toLowerCase()}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function defaultConfidence(changeType: FrameObservationChangeType): number {
	switch (changeType) {
		case FrameObservationChangeType.Accepted:
		case FrameObservationChangeType.AcceptedGeneration:
			return 0.9;
		case FrameObservationChangeType.Rejected:
		case FrameObservationChangeType.RejectedGeneration:
			return 0.85;
		case FrameObservationChangeType.Reverted:
			return 0.8;
		case FrameObservationChangeType.Edited:
		case FrameObservationChangeType.EditedGeneration:
		case FrameObservationChangeType.ManualModification:
			return 0.7;
		case FrameObservationChangeType.Generated:
		default:
			return 0.4;
	}
}

function scoreConfidence(
	base: number,
	observationCount: number,
	sessionCount: number,
	changeType: FrameObservationChangeType,
): number {
	let score = base;
	score += Math.min(0.25, (observationCount - 1) * 0.08);
	if (sessionCount >= CONFIRM_MIN_SESSIONS) {
		score += 0.1;
	}
	if (
		changeType === FrameObservationChangeType.Accepted
		|| changeType === FrameObservationChangeType.AcceptedGeneration
		|| changeType === FrameObservationChangeType.ManualModification
	) {
		score += 0.05;
	}
	if (
		changeType === FrameObservationChangeType.Rejected
		|| changeType === FrameObservationChangeType.RejectedGeneration
		|| changeType === FrameObservationChangeType.Reverted
	) {
		score -= 0.15;
	}
	return clamp01(score);
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) {
		return 0;
	}
	return Math.min(1, Math.max(0, n));
}
