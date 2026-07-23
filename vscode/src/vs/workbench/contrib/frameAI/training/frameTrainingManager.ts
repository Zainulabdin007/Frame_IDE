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
	FrameTrainingBackend,
	FrameTrainingJobStatus,
	IFrameTrainingEstimate,
	IFrameTrainingExample,
	IFrameTrainingJob,
	IFrameTrainingJobOptions,
	IFrameTrainingProbe,
} from '../common/models.js';
import { IFrameHardwareService } from '../hardware/frameHardware.js';
import { IFrameTrainingManager } from './frameTraining.js';

const DEFAULT_MODEL = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';
const DEFAULT_ITERS = 1200;

/**
 * Manages LoRA jobs via tools/frame-lora-train/scripts/training_manager.py.
 * Spawns are detached local processes (Metal MLX preferred on Apple Silicon).
 */
export class FrameTrainingManager extends Disposable implements IFrameTrainingManager {

	declare readonly _serviceBrand: undefined;

	private readonly _jobs = new Map<string, IFrameTrainingJob>();
	private readonly _onDidChangeJobs = this._register(new Emitter<readonly IFrameTrainingJob[]>());
	readonly onDidChangeJobs: Event<readonly IFrameTrainingJob[]> = this._onDidChangeJobs.event;

	private _lastProbe: IFrameTrainingProbe | undefined;
	private _lastEstimate: IFrameTrainingEstimate | undefined;
	private _trainRoot: URI | undefined;
	private _refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFrameHardwareService private readonly hardware: IFrameHardwareService,
	) {
		super();
		this.logService.info('[FrameTraining] Manager ready (MLX preferred on Apple Silicon)');
		void this.refresh();
		this._refreshTimer = setInterval(() => void this.refresh(), 15_000);
		this._register({ dispose: () => { if (this._refreshTimer) { clearInterval(this._refreshTimer); } } });
	}

	listJobs(): readonly IFrameTrainingJob[] {
		return [...this._jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	getJob(id: string): IFrameTrainingJob | undefined {
		return this._jobs.get(id);
	}

	getLastEstimate(): IFrameTrainingEstimate | undefined {
		return this._lastEstimate;
	}

	getLastProbe(): IFrameTrainingProbe | undefined {
		return this._lastProbe;
	}

	async probe(): Promise<IFrameTrainingProbe> {
		const hw = await this.hardware.detect();
		const appleSilicon = !!hw.appleSilicon;
		const root = await this.resolveTrainRoot();
		let mlxAvailable = false;
		let mlxPython: string | null = null;
		let reason: string;

		if (root) {
			const venvPy = joinPath(root, '.venv-lora', 'bin', 'python');
			mlxAvailable = await this.fileService.exists(venvPy);
			if (mlxAvailable) {
				mlxPython = venvPy.fsPath;
			}
		}

		// Prefer live probe from Python when available.
		const live = await this.runManagerJson(['probe']);
		if (live && typeof live === 'object') {
			const backend = (live as { backend?: string }).backend === 'cpu' ? 'cpu' : 'mlx_gpu';
			const probe: IFrameTrainingProbe = {
				appleSilicon: !!(live as { apple_silicon?: boolean }).apple_silicon || appleSilicon,
				mlxAvailable: !!(live as { mlx_importable?: boolean }).mlx_importable || mlxAvailable,
				backend: backend as FrameTrainingBackend,
				reason: String((live as { reason?: string }).reason ?? ''),
				mlxPython: (live as { mlx_python?: string | null }).mlx_python ?? mlxPython,
			};
			this._lastProbe = probe;
			return probe;
		}

		const backend: FrameTrainingBackend = appleSilicon && mlxAvailable ? 'mlx_gpu' : 'cpu';
		if (appleSilicon && mlxAvailable) {
			reason = 'Apple Silicon + .venv-lora detected — training will use Metal GPU (MLX).';
		} else if (appleSilicon) {
			reason = 'Apple Silicon detected, but MLX venv missing. Run tools/frame-lora-train setup (pip install mlx-lm[train]).';
		} else {
			reason = 'Non-Apple Silicon — CPU training fallback (slow).';
		}
		const probe: IFrameTrainingProbe = { appleSilicon, mlxAvailable, backend, reason, mlxPython };
		this._lastProbe = probe;
		return probe;
	}

	async estimate(options?: IFrameTrainingJobOptions): Promise<IFrameTrainingEstimate> {
		const probe = this._lastProbe ?? await this.probe();
		const iters = options?.iters ?? DEFAULT_ITERS;
		const backend = options?.forceCpu ? 'cpu' : probe.backend;

		const live = await this.runManagerJson([
			'estimate',
			'--iters', String(iters),
			...(options?.dataDir ? ['--data-dir', options.dataDir] : []),
			'--backend', backend,
		]);
		if (live && typeof live === 'object') {
			const est: IFrameTrainingEstimate = {
				backend: ((live as { backend?: string }).backend === 'cpu' ? 'cpu' : 'mlx_gpu'),
				iters: Number((live as { iters?: number }).iters) || iters,
				trainRows: Number((live as { train_rows?: number }).train_rows) || 0,
				validRows: Number((live as { valid_rows?: number }).valid_rows) || 0,
				estimatedDurationHours: Number((live as { estimated_duration_hours?: number }).estimated_duration_hours) || 0,
				estimatedRamGb: Number((live as { estimated_ram_gb?: number }).estimated_ram_gb) || 18,
				notes: Array.isArray((live as { notes?: string[] }).notes) ? (live as { notes: string[] }).notes : [],
			};
			this._lastEstimate = est;
			return est;
		}

		const trainRows = await this.countTrainRows(options?.dataDir);
		const secPerIter = backend === 'mlx_gpu' ? 6 : 25;
		const est: IFrameTrainingEstimate = {
			backend,
			iters,
			trainRows,
			validRows: 0,
			estimatedDurationHours: Math.round((iters * secPerIter / 3600) * 10) / 10,
			estimatedRamGb: backend === 'mlx_gpu' ? 18 : 22,
			notes: [
				`Backend: ${backend}`,
				probe.reason,
				'Keep the Mac plugged in overnight for best results.',
			],
		};
		this._lastEstimate = est;
		return est;
	}

	async createJob(input: {
		name: string;
		baseModelId?: string;
		adapterId?: string;
		examples?: readonly IFrameTrainingExample[];
		options?: IFrameTrainingJobOptions;
	}): Promise<IFrameTrainingJob> {
		const probe = this._lastProbe ?? await this.probe();
		const estimate = await this.estimate(input.options);
		const now = Date.now();
		const root = await this.resolveTrainRoot();
		const dataDir = input.options?.dataDir
			?? (root ? joinPath(root, 'data', 'processed').fsPath : undefined);
		const adapterPath = input.options?.adapterPath
			?? (root ? joinPath(root, 'adapters', 'frame-agent-v1').fsPath : undefined);

		const job: IFrameTrainingJob = {
			id: generateUuid(),
			name: input.name,
			baseModelId: input.baseModelId ?? input.options?.model ?? DEFAULT_MODEL,
			adapterId: input.adapterId,
			status: input.options?.scheduleAt ? FrameTrainingJobStatus.Scheduled : FrameTrainingJobStatus.Draft,
			examples: input.examples ?? [],
			createdAt: now,
			updatedAt: now,
			progress: 0,
			backend: estimate.backend,
			iters: input.options?.iters ?? DEFAULT_ITERS,
			estimate,
			probe,
			scheduleAt: input.options?.scheduleAt,
			adapterPath,
			dataDir,
			cpuLimit: !!input.options?.cpuLimit,
		};
		this._jobs.set(job.id, job);
		this._onDidChangeJobs.fire(this.listJobs());
		await this.persistLocalMirror();
		return job;
	}

	async addExamples(jobId: string, examples: readonly IFrameTrainingExample[]): Promise<IFrameTrainingJob | undefined> {
		const job = this._jobs.get(jobId);
		if (!job) {
			return undefined;
		}
		const next: IFrameTrainingJob = {
			...job,
			examples: [...job.examples, ...examples],
			updatedAt: Date.now(),
		};
		this._jobs.set(jobId, next);
		this._onDidChangeJobs.fire(this.listJobs());
		return next;
	}

	async setStatus(jobId: string, status: FrameTrainingJobStatus, error?: string): Promise<IFrameTrainingJob | undefined> {
		const job = this._jobs.get(jobId);
		if (!job) {
			return undefined;
		}
		const next: IFrameTrainingJob = {
			...job,
			status,
			error,
			updatedAt: Date.now(),
		};
		this._jobs.set(jobId, next);
		this._onDidChangeJobs.fire(this.listJobs());
		await this.persistLocalMirror();
		return next;
	}

	async enqueue(jobId: string): Promise<IFrameTrainingJob | undefined> {
		return this.start(jobId);
	}

	async start(jobId: string, options?: IFrameTrainingJobOptions): Promise<IFrameTrainingJob | undefined> {
		const job = this._jobs.get(jobId);
		if (!job) {
			return undefined;
		}
		const estimate = await this.estimate({
			iters: options?.iters ?? job.iters,
			dataDir: options?.dataDir ?? job.dataDir,
			forceCpu: options?.forceCpu,
			cpuLimit: options?.cpuLimit ?? job.cpuLimit,
		});
		this.logService.info(
			`[FrameTraining] Starting job=${jobId} backend=${estimate.backend} ~${estimate.estimatedDurationHours}h RAM~${estimate.estimatedRamGb}GB`,
		);

		const args = [
			'run-now',
			'--name', job.name,
			'--iters', String(options?.iters ?? job.iters ?? DEFAULT_ITERS),
			'--model', job.baseModelId || DEFAULT_MODEL,
		];
		if (job.dataDir || options?.dataDir) {
			args.push('--data-dir', options?.dataDir ?? job.dataDir!);
		}
		if (job.adapterPath || options?.adapterPath) {
			args.push('--adapter-path', options?.adapterPath ?? job.adapterPath!);
		}
		if (options?.cpuLimit ?? job.cpuLimit) {
			args.push('--cpu-limit');
		}
		if (options?.forceCpu) {
			args.push('--force-cpu');
		}
		const schedule = options?.scheduleAt ?? job.scheduleAt;
		if (schedule) {
			args.push('--schedule', schedule);
		}

		const result = await this.runManagerJson(args);
		if (!result || typeof result !== 'object') {
			return this.setStatus(jobId, FrameTrainingJobStatus.Failed, 'Failed to launch training_manager.py — is .venv-lora set up?');
		}

		const pyJob = result as Record<string, unknown>;
		const mapped = this.mapPythonJob(pyJob, job);
		this._jobs.set(jobId, mapped);
		// Also index under python id for refresh merge.
		if (mapped.id !== jobId) {
			this._jobs.set(mapped.id, mapped);
			this._jobs.delete(jobId);
		}
		this._onDidChangeJobs.fire(this.listJobs());
		await this.persistLocalMirror();
		return mapped;
	}

	async pause(jobId: string): Promise<IFrameTrainingJob | undefined> {
		const pyId = this.pythonId(jobId);
		const result = await this.runManagerJson(['pause', '--job-id', pyId]);
		if (result && typeof result === 'object') {
			const mapped = this.mapPythonJob(result as Record<string, unknown>, this._jobs.get(jobId));
			this._jobs.set(mapped.id, mapped);
			this._onDidChangeJobs.fire(this.listJobs());
			return mapped;
		}
		return this.setStatus(jobId, FrameTrainingJobStatus.Paused);
	}

	async resume(jobId: string): Promise<IFrameTrainingJob | undefined> {
		const pyId = this.pythonId(jobId);
		const result = await this.runManagerJson(['resume', '--job-id', pyId]);
		if (result && typeof result === 'object') {
			const mapped = this.mapPythonJob(result as Record<string, unknown>, this._jobs.get(jobId));
			this._jobs.set(mapped.id, mapped);
			this._onDidChangeJobs.fire(this.listJobs());
			return mapped;
		}
		return this.setStatus(jobId, FrameTrainingJobStatus.Running);
	}

	async cancel(jobId: string): Promise<IFrameTrainingJob | undefined> {
		const pyId = this.pythonId(jobId);
		const result = await this.runManagerJson(['cancel', '--job-id', pyId]);
		if (result && typeof result === 'object') {
			const mapped = this.mapPythonJob(result as Record<string, unknown>, this._jobs.get(jobId));
			this._jobs.set(mapped.id, mapped);
			this._onDidChangeJobs.fire(this.listJobs());
			return mapped;
		}
		return this.setStatus(jobId, FrameTrainingJobStatus.Cancelled);
	}

	async schedule(jobId: string, when: string): Promise<IFrameTrainingJob | undefined> {
		const job = this._jobs.get(jobId);
		if (!job) {
			return undefined;
		}
		return this.start(jobId, { scheduleAt: when, iters: job.iters, dataDir: job.dataDir, adapterPath: job.adapterPath, cpuLimit: job.cpuLimit });
	}

	async refresh(): Promise<readonly IFrameTrainingJob[]> {
		const root = await this.resolveTrainRoot();
		if (!root) {
			return this.listJobs();
		}
		const jobsRoot = joinPath(root, 'jobs');
		try {
			if (!(await this.fileService.exists(jobsRoot))) {
				return this.listJobs();
			}
			const entries = await this.fileService.resolve(jobsRoot);
			for (const child of entries.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				const jobFile = joinPath(child.resource, 'job.json');
				if (!(await this.fileService.exists(jobFile))) {
					continue;
				}
				try {
					const raw = (await this.fileService.readFile(jobFile)).value.toString();
					const pyJob = JSON.parse(raw) as Record<string, unknown>;
					const mapped = this.mapPythonJob(pyJob, this._jobs.get(String(pyJob.id)));
					this._jobs.set(mapped.id, mapped);
				} catch (err) {
					this.logService.trace('[FrameTraining] skip bad job file', err);
				}
			}
			this._onDidChangeJobs.fire(this.listJobs());
		} catch (err) {
			this.logService.trace('[FrameTraining] refresh skipped', err);
		}
		return this.listJobs();
	}

	private pythonId(jobId: string): string {
		const job = this._jobs.get(jobId);
		// Python manager ids look like job-<epoch>-<pid>
		if (jobId.startsWith('job-')) {
			return jobId;
		}
		// If we still have the draft UUID, prefer any running python job with same name.
		const match = this.listJobs().find(j => j.id.startsWith('job-') && j.name === job?.name);
		return match?.id ?? jobId;
	}

	private mapPythonJob(py: Record<string, unknown>, fallback?: IFrameTrainingJob): IFrameTrainingJob {
		const statusRaw = String(py.status ?? 'draft');
		const status = this.mapStatus(statusRaw);
		const estimateRaw = py.estimate as Record<string, unknown> | undefined;
		const probeRaw = py.probe as Record<string, unknown> | undefined;
		const estimate: IFrameTrainingEstimate | undefined = estimateRaw ? {
			backend: estimateRaw.backend === 'cpu' ? 'cpu' : 'mlx_gpu',
			iters: Number(estimateRaw.iters) || DEFAULT_ITERS,
			trainRows: Number(estimateRaw.train_rows) || 0,
			validRows: Number(estimateRaw.valid_rows) || 0,
			estimatedDurationHours: Number(estimateRaw.estimated_duration_hours) || 0,
			estimatedRamGb: Number(estimateRaw.estimated_ram_gb) || 18,
			notes: Array.isArray(estimateRaw.notes) ? estimateRaw.notes as string[] : [],
		} : fallback?.estimate;
		const probe: IFrameTrainingProbe | undefined = probeRaw ? {
			appleSilicon: !!probeRaw.apple_silicon,
			mlxAvailable: !!probeRaw.mlx_importable,
			backend: probeRaw.backend === 'cpu' ? 'cpu' : 'mlx_gpu',
			reason: String(probeRaw.reason ?? ''),
			mlxPython: (probeRaw.mlx_python as string | null | undefined) ?? null,
		} : fallback?.probe;

		return {
			id: String(py.id ?? fallback?.id ?? generateUuid()),
			name: String(py.name ?? fallback?.name ?? 'Frame LoRA'),
			baseModelId: String(py.model ?? fallback?.baseModelId ?? DEFAULT_MODEL),
			adapterId: fallback?.adapterId,
			status,
			examples: fallback?.examples ?? [],
			createdAt: fallback?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
			progress: typeof py.progress === 'number' ? py.progress : fallback?.progress,
			error: typeof py.error === 'string' ? py.error : undefined,
			backend: (py.backend === 'cpu' ? 'cpu' : 'mlx_gpu'),
			iters: Number(py.iters) || fallback?.iters,
			estimate,
			probe,
			pid: typeof py.pid === 'number' ? py.pid : null,
			scheduleAt: typeof py.scheduleAt === 'string' ? py.scheduleAt : undefined,
			logFile: typeof py.logFile === 'string' ? py.logFile : undefined,
			adapterPath: typeof py.adapterPath === 'string' ? py.adapterPath : fallback?.adapterPath,
			dataDir: typeof py.dataDir === 'string' ? py.dataDir : fallback?.dataDir,
			cpuLimit: !!py.cpuLimit || !!fallback?.cpuLimit,
		};
	}

	private mapStatus(raw: string): FrameTrainingJobStatus {
		switch (raw) {
			case 'queued': return FrameTrainingJobStatus.Queued;
			case 'scheduled': return FrameTrainingJobStatus.Scheduled;
			case 'running': return FrameTrainingJobStatus.Running;
			case 'paused': return FrameTrainingJobStatus.Paused;
			case 'succeeded': return FrameTrainingJobStatus.Succeeded;
			case 'failed': return FrameTrainingJobStatus.Failed;
			case 'cancelled': return FrameTrainingJobStatus.Cancelled;
			default: return FrameTrainingJobStatus.Draft;
		}
	}

	private async resolveTrainRoot(): Promise<URI | undefined> {
		if (this._trainRoot && await this.fileService.exists(this._trainRoot)) {
			return this._trainRoot;
		}
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		const candidates: URI[] = [];
		if (folder) {
			candidates.push(joinPath(folder, 'tools', 'frame-lora-train'));
			candidates.push(joinPath(folder, '..', 'tools', 'frame-lora-train'));
		}
		// Dev layout: workspace is Frame_IDE
		for (const c of candidates) {
			const marker = joinPath(c, 'scripts', 'training_manager.py');
			if (await this.fileService.exists(marker)) {
				this._trainRoot = c;
				return c;
			}
		}
		return undefined;
	}

	private async countTrainRows(dataDir?: string): Promise<number> {
		const root = await this.resolveTrainRoot();
		const dir = dataDir
			? URI.file(dataDir)
			: root ? joinPath(root, 'data', 'processed') : undefined;
		if (!dir) {
			return 0;
		}
		for (const name of ['train.jsonl', 'frame_agent_train.jsonl']) {
			const file = joinPath(dir, name);
			if (!(await this.fileService.exists(file))) {
				continue;
			}
			try {
				const manifest = joinPath(dir, 'merged_manifest.json');
				if (await this.fileService.exists(manifest)) {
					const raw = JSON.parse((await this.fileService.readFile(manifest)).value.toString()) as { train?: number };
					if (typeof raw.train === 'number') {
						return raw.train;
					}
				}
			} catch {
				// fall through
			}
			return 0;
		}
		return 0;
	}

	private async persistLocalMirror(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return;
		}
		const uri = joinPath(folder, '.frame', 'training', 'jobs.json');
		try {
			const payload = JSON.stringify({ updatedAt: Date.now(), jobs: this.listJobs() }, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(payload));
		} catch (err) {
			this.logService.trace('[FrameTraining] persist mirror skipped', err);
		}
	}

	private async runManagerJson(args: string[]): Promise<unknown | undefined> {
		const root = await this.resolveTrainRoot();
		if (!root) {
			this.logService.warn('[FrameTraining] tools/frame-lora-train not found');
			return undefined;
		}
		const venvPy = joinPath(root, '.venv-lora', 'bin', 'python');
		const script = joinPath(root, 'scripts', 'training_manager.py');
		const python = (await this.fileService.exists(venvPy)) ? venvPy.fsPath : 'python3';
		if (!(await this.fileService.exists(script))) {
			return undefined;
		}

		try {
			const { stdout, stderr, code } = await spawnCapture(python, [script.fsPath, ...args], root.fsPath);
			if (code !== 0) {
				this.logService.warn(`[FrameTraining] manager exit=${code}: ${stderr.slice(0, 400)}`);
			}
			const text = stdout.trim() || stderr.trim();
			const start = text.indexOf('{');
			const startArr = text.indexOf('[');
			const idx = start >= 0 && (startArr < 0 || start < startArr) ? start : startArr;
			if (idx < 0) {
				return undefined;
			}
			return JSON.parse(text.slice(idx));
		} catch (err) {
			this.logService.warn('[FrameTraining] manager spawn failed (sandbox?) — use scripts/run_managed_train.sh', err);
			return undefined;
		}
	}
}

async function spawnCapture(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	// Dynamic import so browser/web bundles do not statically pull node:child_process.
	const cp = await import('child_process');
	return new Promise((resolve, reject) => {
		try {
			const child = cp.spawn(command, args, {
				cwd,
				env: { ...process.env, PYTHONUNBUFFERED: '1' },
			});
			let stdout = '';
			let stderr = '';
			child.stdout?.on('data', (d: Buffer | string) => { stdout += String(d); });
			child.stderr?.on('data', (d: Buffer | string) => { stderr += String(d); });
			child.on('error', reject);
			child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		} catch (err) {
			reject(err);
		}
	});
}
