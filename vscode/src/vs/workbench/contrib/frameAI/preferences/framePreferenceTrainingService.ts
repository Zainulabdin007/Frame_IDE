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
	FrameAdapterKind,
	FrameAdapterScope,
	FrameAdapterState,
	FrameTrainingJobStatus,
	IFrameCandidatePreference,
	IFrameObservation,
	IFrameTrainingJob,
	IFrameUserPreference,
} from '../common/models.js';
import { IFrameAdapterService } from '../adapters/frameAdapters.js';
import { IFrameObservationService } from './frameObservation.js';
import { IFrameTrainingManager } from '../training/frameTraining.js';
import {
	IFramePreferenceTrainScheduleResult,
	IFramePreferenceTrainingService,
} from './framePreferenceTraining.js';

/** Workspace adapter that receives preference LoRA personalization. */
export const FRAME_PREFS_ADAPTER_ID = 'frame-prefs-user';

const PREFS_TRAIN_ITERS = 300;
/** Coalesce multiple Approves into one train launch. */
const SCHEDULE_DEBOUNCE_MS = 20_000;
const SYSTEM_PROMPT = [
	'You are Frame, a local coding assistant inside Frame IDE.',
	'Be concise. Match the user\'s approved coding preferences when editing code.',
].join('\n');

/**
 * Preference Approve → on-device LoRA schedule.
 * Writes chat-format JSONL under `.frame/training/preferences/` and starts
 * (or debounces) a short MLX LoRA job via {@link IFrameTrainingManager}.
 */
export class FramePreferenceTrainingService extends Disposable implements IFramePreferenceTrainingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _lastJobId: string | undefined;
	private _pendingExamples = 0;
	private _debounce: ReturnType<typeof setTimeout> | undefined;
	private _launchInFlight = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFrameObservationService private readonly observations: IFrameObservationService,
		@IFrameTrainingManager private readonly training: IFrameTrainingManager,
		@IFrameAdapterService private readonly adapters: IFrameAdapterService,
	) {
		super();
		this._register(this.training.onDidChangeJobs(jobs => {
			void this.onJobsChanged(jobs);
		}));
		this._register({
			dispose: () => {
				if (this._debounce) {
					clearTimeout(this._debounce);
					this._debounce = undefined;
				}
			},
		});
	}

	getLastJobId(): string | undefined {
		return this._lastJobId;
	}

	async scheduleFromApprovedPreference(
		candidate: IFrameCandidatePreference,
		preference: IFrameUserPreference,
	): Promise<IFramePreferenceTrainScheduleResult> {
		const folder = this.primaryFolder();
		if (!folder) {
			return {
				preference,
				examplesAdded: 0,
				job: undefined,
				message: 'Preference saved to memory. Open a folder to schedule LoRA personalization.',
			};
		}

		const examples = this.buildExamples(candidate);
		const dataRoot = joinPath(folder, '.frame', 'training', 'preferences');
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'training'));
		await this.ensureDir(dataRoot);

		const added = await this.appendTrainJsonl(dataRoot, examples);
		this._pendingExamples += added;

		await this.ensurePrefsAdapter(candidate, preference, added);

		this.logService.info(
			`[FramePreferenceTrain] Approved "${preference.preference}" → +${added} train rows (pendingLaunch=${this._pendingExamples})`,
		);

		this.queueDebouncedLaunch();

		const existing = this._lastJobId ? this.training.getJob(this._lastJobId) : undefined;
		return {
			preference,
			examplesAdded: added,
			job: existing,
			message: added > 0
				? `Preference saved. LoRA personalization queued (${this._pendingExamples} new example(s); starts in ~${Math.round(SCHEDULE_DEBOUNCE_MS / 1000)}s).`
				: 'Preference saved to memory (no code examples to train on yet).',
		};
	}

	private queueDebouncedLaunch(): void {
		if (this._debounce) {
			clearTimeout(this._debounce);
		}
		this._debounce = setTimeout(() => {
			this._debounce = undefined;
			void this.launchIfNeeded();
		}, SCHEDULE_DEBOUNCE_MS);
	}

	private async launchIfNeeded(): Promise<void> {
		if (this._launchInFlight || this._pendingExamples <= 0) {
			return;
		}
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}

		// Don't stack preference jobs while one is already running/scheduled.
		const busy = this.training.listJobs().some(j =>
			j.adapterId === FRAME_PREFS_ADAPTER_ID
			&& (j.status === FrameTrainingJobStatus.Running
				|| j.status === FrameTrainingJobStatus.Queued
				|| j.status === FrameTrainingJobStatus.Scheduled
				|| j.status === FrameTrainingJobStatus.Paused),
		);
		if (busy) {
			this.logService.info('[FramePreferenceTrain] Existing prefs job still active — examples accumulated for next run.');
			this._onDidChange.fire();
			return;
		}

		this._launchInFlight = true;
		const pending = this._pendingExamples;
		try {
			const probe = await this.training.probe();
			const dataDir = joinPath(folder, '.frame', 'training', 'preferences').fsPath;
			const adapterPath = joinPath(folder, '.frame', 'adapters', FRAME_PREFS_ADAPTER_ID, 'mlx').fsPath;
			await this.ensureDir(joinPath(folder, '.frame', 'adapters', FRAME_PREFS_ADAPTER_ID));
			await this.ensureDir(joinPath(folder, '.frame', 'adapters', FRAME_PREFS_ADAPTER_ID, 'mlx'));

			await this.adapters.setAdapterState(FRAME_PREFS_ADAPTER_ID, FrameAdapterState.Training);

			const job = await this.training.createJob({
				name: `Preference LoRA (${pending} examples)`,
				adapterId: FRAME_PREFS_ADAPTER_ID,
				baseModelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
				options: {
					iters: PREFS_TRAIN_ITERS,
					dataDir,
					adapterPath,
					// CPU machines: schedule overnight; Metal: start soon.
					scheduleAt: probe.backend === 'mlx_gpu' ? undefined : 'overnight',
					cpuLimit: probe.backend !== 'mlx_gpu',
				},
			});

			const started = await this.training.start(job.id, {
				iters: PREFS_TRAIN_ITERS,
				dataDir,
				adapterPath,
				scheduleAt: probe.backend === 'mlx_gpu' ? undefined : 'overnight',
				cpuLimit: probe.backend !== 'mlx_gpu',
			});

			this._lastJobId = started?.id ?? job.id;
			this._pendingExamples = 0;
			this.logService.info(
				`[FramePreferenceTrain] Launched job=${this._lastJobId} backend=${probe.backend} iters=${PREFS_TRAIN_ITERS}`,
			);
			this._onDidChange.fire();
		} catch (err) {
			this.logService.warn(
				`[FramePreferenceTrain] Failed to launch: ${err instanceof Error ? err.message : String(err)}`,
			);
			await this.adapters.setAdapterState(FRAME_PREFS_ADAPTER_ID, FrameAdapterState.Failed);
		} finally {
			this._launchInFlight = false;
		}
	}

	private async onJobsChanged(jobs: readonly IFrameTrainingJob[]): Promise<void> {
		const prefsJobs = jobs.filter(j => j.adapterId === FRAME_PREFS_ADAPTER_ID);
		if (!prefsJobs.length) {
			return;
		}
		const latest = prefsJobs[0];
		if (latest.status === FrameTrainingJobStatus.Succeeded) {
			await this.adapters.setAdapterState(FRAME_PREFS_ADAPTER_ID, FrameAdapterState.Active);
			this.logService.info(`[FramePreferenceTrain] Job ${latest.id} succeeded — prefs adapter Active.`);
			this._onDidChange.fire();
		} else if (latest.status === FrameTrainingJobStatus.Failed || latest.status === FrameTrainingJobStatus.Cancelled) {
			await this.adapters.setAdapterState(FRAME_PREFS_ADAPTER_ID, FrameAdapterState.Failed);
			this._onDidChange.fire();
		}
	}

	private buildExamples(candidate: IFrameCandidatePreference): readonly PreferenceTrainRow[] {
		const rows: PreferenceTrainRow[] = [];
		const obsById = new Map(this.observations.listObservations(500).map(o => [o.id, o]));

		for (const oid of candidate.observationIds) {
			const obs = obsById.get(oid);
			if (!obs) {
				continue;
			}
			const row = this.rowFromObservation(candidate, obs);
			if (row) {
				rows.push(row);
			}
		}

		if (candidate.examples?.length) {
			for (const ex of candidate.examples) {
				if (!ex.before?.trim() && !ex.after?.trim()) {
					continue;
				}
				rows.push(this.rowFromPair(candidate, ex.before, ex.after));
			}
		}

		// Always include at least one preference-instruction example.
		rows.push({
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{
					role: 'user',
					content: `Remember this coding preference for this project:\n"${candidate.preference}"`,
				},
				{
					role: 'assistant',
					content: `Understood. I will follow: ${candidate.preference}`,
				},
			],
			meta: {
				source: 'preference-approval',
				preferenceId: candidate.id,
				signalId: candidate.signalId,
				kind: 'instruction',
			},
		});

		return rows;
	}

	private rowFromObservation(candidate: IFrameCandidatePreference, obs: IFrameObservation): PreferenceTrainRow | undefined {
		const before = (obs.before ?? '').trim();
		const after = (obs.after ?? '').trim();
		if (!before && !after) {
			return undefined;
		}
		if (before === after) {
			return undefined;
		}
		return this.rowFromPair(candidate, before, after || before, obs);
	}

	private rowFromPair(
		candidate: IFrameCandidatePreference,
		before: string,
		after: string,
		obs?: IFrameObservation,
	): PreferenceTrainRow {
		const lang = candidate.language ?? obs?.language ?? 'code';
		return {
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{
					role: 'user',
					content: [
						`Apply this preference: ${candidate.preference}`,
						obs?.file ? `File: ${obs.file}` : undefined,
						`Rewrite the following ${lang} to match:`,
						'```',
						before.slice(0, 6000),
						'```',
					].filter(Boolean).join('\n'),
				},
				{
					role: 'assistant',
					content: [
						'```',
						after.slice(0, 6000),
						'```',
						`Applied preference: ${candidate.preference}`,
					].join('\n'),
				},
			],
			meta: {
				source: 'preference-approval',
				preferenceId: candidate.id,
				signalId: candidate.signalId,
				observationId: obs?.id,
				changeType: obs?.changeType,
				kind: 'before-after',
			},
		};
	}

	private async appendTrainJsonl(dataRoot: URI, rows: readonly PreferenceTrainRow[]): Promise<number> {
		if (!rows.length) {
			return 0;
		}
		const trainUri = joinPath(dataRoot, 'train.jsonl');
		const validUri = joinPath(dataRoot, 'valid.jsonl');
		const existing = await this.readJsonlLines(trainUri);
		const newLines = rows.map(r => JSON.stringify(r));
		const all = [...existing, ...newLines];
		await this.fileService.writeFile(trainUri, VSBuffer.fromString(all.join('\n') + '\n'));

		// Keep a small validation holdout (last 10% or at least 1).
		const validCount = Math.max(1, Math.min(20, Math.ceil(all.length * 0.1)));
		const validLines = all.slice(-validCount);
		await this.fileService.writeFile(validUri, VSBuffer.fromString(validLines.join('\n') + '\n'));
		return rows.length;
	}

	private async readJsonlLines(uri: URI): Promise<string[]> {
		try {
			if (!(await this.fileService.exists(uri))) {
				return [];
			}
			const buf = await this.fileService.readFile(uri);
			return buf.value.toString().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async ensurePrefsAdapter(
		candidate: IFrameCandidatePreference,
		preference: IFrameUserPreference,
		examplesAdded: number,
	): Promise<void> {
		const existing = this.adapters.getAdapter(FRAME_PREFS_ADAPTER_ID);
		if (!existing) {
			await this.adapters.registerAdapter({
				id: FRAME_PREFS_ADAPTER_ID,
				name: 'User preference LoRA',
				scope: FrameAdapterScope.User,
				kind: FrameAdapterKind.LoRA,
				state: FrameAdapterState.Training,
				baseModelId: 'qwen-coder-7b-q4',
				version: '0.1.0',
				description: 'On-device LoRA personalization from approved Learning preferences.',
				rank: 16,
				tags: ['preference', 'user', 'personalization'],
				language: candidate.language,
			});
		} else {
			await this.adapters.setAdapterState(FRAME_PREFS_ADAPTER_ID, FrameAdapterState.Training);
		}
		// Bump trainingExamples count when metadata supports update via register overwrite — best-effort log.
		this.logService.trace(
			`[FramePreferenceTrain] Adapter ${FRAME_PREFS_ADAPTER_ID} ready (+${examplesAdded} for ${preference.id})`,
		);
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}
}

interface PreferenceTrainRow {
	readonly messages: readonly { readonly role: string; readonly content: string }[];
	readonly meta: Record<string, unknown>;
}
