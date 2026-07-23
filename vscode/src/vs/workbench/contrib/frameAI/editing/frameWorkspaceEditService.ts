/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath, dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ResourceEdit, ResourceFileEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	buildStubEditPlan,
	FRAME_STUB_PLAN_MESSAGE,
	FrameEditOperationStatus,
	IFrameEditDiffFileSummary,
	IFrameEditOperation,
	IFrameEditPlan,
	IFrameEditPlanPreview,
	isFrameEditIntent,
	isSuspiciousDestructiveModify,
	materializeSourceEdit,
	parseModelEditPlan,
	previewEditPlan,
	synthesizeRecoveredEditPlan,
	withOperationStatuses,
} from '../runtime/frameEditPlan.js';
import { IFrameInferenceContext } from '../common/models.js';
import { resolveSafeWorkspacePath } from '../runtime/tools/frameToolPath.js';

export const IFrameWorkspaceEditService = createDecorator<IFrameWorkspaceEditService>('frameWorkspaceEditService');

export interface IFrameEditApplyResult {
	readonly ok: boolean;
	readonly plan: IFrameEditPlan;
	readonly appliedOperationIds: readonly string[];
	readonly failedOperationIds: readonly string[];
	readonly message: string;
	readonly rollbackId?: string;
}

export interface IFrameEditMemoryRecord {
	readonly id: string;
	readonly timestamp: number;
	readonly prompt: string;
	readonly planId: string;
	readonly acceptedFiles: readonly string[];
	readonly rejectedFiles: readonly string[];
	readonly executionResult: string;
	readonly taskId?: string;
}

export interface IFrameWorkspaceEditService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePlans: Event<void>;

	getPendingPlan(): IFrameEditPlan | undefined;

	getPreview(planId?: string): IFrameEditPlanPreview | undefined;

	/**
	 * Propose an edit plan for preview.
	 * Tries {@link parseModelEditPlan} on `modelOutput` first; falls back to {@link buildStubEditPlan}.
	 */
	proposeStubPlan(taskId: string, prompt: string, context: IFrameInferenceContext, modelOutput?: string): Promise<IFrameEditPlan>;

	setPendingPlan(plan: IFrameEditPlan | undefined): void;

	/**
	 * Silently drop a superseded pending plan (e.g. a pre-inference stub replaced
	 * by a model-derived plan) without recording a user rejection.
	 */
	dismissPlan(planId: string): void;

	/**
	 * Mark pending operations as applied by an external writer (e.g. Chat Apply).
	 * Records undo snapshots from current disk content (falling back to each op's
	 * `originalContent`) and fires {@link onDidChangePlans} so the sidebar stops
	 * offering a stale Accept. When `operationIds` is omitted, all pending ops
	 * are marked.
	 */
	markExternallyApplied(planId: string, operationIds?: readonly string[]): Promise<void>;

	validatePlan(plan: IFrameEditPlan): { ok: boolean; issues: readonly string[] };

	/** Build VS Code workspace/resource edits for the given plan (or selected ops). */
	buildWorkspaceEdit(plan: IFrameEditPlan, operationIds?: readonly string[]): ResourceEdit[];

	acceptAll(): Promise<IFrameEditApplyResult>;

	rejectAll(): Promise<void>;

	acceptOperation(operationId: string): Promise<IFrameEditApplyResult>;

	rejectOperation(operationId: string): Promise<void>;

	undoLastApply(): Promise<boolean>;

	getLastMemoryRecord(): IFrameEditMemoryRecord | undefined;
}

interface IRollbackSnapshot {
	readonly id: string;
	readonly planId: string;
	readonly createdAt: number;
	readonly entries: readonly {
		readonly path: string;
		readonly kind: 'file' | 'missing';
		readonly content?: string;
	}[];
}

/**
 * Validates, previews, applies, and rolls back Frame edit plans.
 * Uses the file service — never downloads or runs models.
 */
export class FrameWorkspaceEditService extends Disposable implements IFrameWorkspaceEditService {

	declare readonly _serviceBrand: undefined;

	private static readonly READ_CACHE_MAX_ENTRIES = 50;
	private static readonly READ_CACHE_TTL_MS = 30_000;

	private _pending: IFrameEditPlan | undefined;
	private _rollback: IRollbackSnapshot | undefined;
	private _lastMemory: IFrameEditMemoryRecord | undefined;
	/** LRU cache of recent async file reads for sync stub/recovery lookups. */
	private readonly _readCache = new Map<string, { readonly content: string; readonly at: number }>();

	private readonly _onDidChangePlans = this._register(new Emitter<void>());
	readonly onDidChangePlans: Event<void> = this._onDidChangePlans.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[FrameEdit] Workspace edit service ready (model plan parse + stub fallback)');
	}

	getPendingPlan(): IFrameEditPlan | undefined {
		return this._pending;
	}

	getPreview(planId?: string): IFrameEditPlanPreview | undefined {
		const plan = planId
			? (this._pending?.id === planId ? this._pending : undefined)
			: this._pending;
		return plan ? previewEditPlan(plan) : undefined;
	}

	setPendingPlan(plan: IFrameEditPlan | undefined): void {
		this._pending = plan;
		this._onDidChangePlans.fire();
	}

	dismissPlan(planId: string): void {
		if (!this._pending || this._pending.id !== planId) {
			return;
		}
		this._pending = undefined;
		this._onDidChangePlans.fire();
		this.logService.info(`[FrameEdit] Dismissed superseded plan ${planId}`);
	}

	async markExternallyApplied(planId: string, operationIds?: readonly string[]): Promise<void> {
		const plan = this._pending;
		if (!plan || plan.id !== planId) {
			return;
		}
		const targets = plan.operations.filter(op =>
			(op.status === 'pending' || op.status === 'accepted')
			&& (!operationIds || operationIds.includes(op.id)),
		);
		if (!targets.length) {
			return;
		}

		// Snapshot current disk content BEFORE the external writer touches the
		// files; when the file cannot be read, fall back to the originalContent
		// captured at plan time so undo still has something faithful to restore.
		const entries: IRollbackSnapshot['entries'][number][] = [];
		for (const op of targets) {
			for (const path of this.pathsTouched(op)) {
				const current = await this.readRelative(path);
				if (current !== undefined) {
					entries.push({ path, kind: 'file', content: current });
				} else if (op.kind === 'modify' && op.originalContent !== undefined) {
					entries.push({ path, kind: 'file', content: op.originalContent });
				} else {
					entries.push({ path, kind: 'missing' });
				}
			}
		}
		this._rollback = { id: generateUuid(), planId, createdAt: Date.now(), entries };

		const updates = new Map<string, FrameEditOperationStatus>();
		for (const op of targets) {
			updates.set(op.id, 'applied');
		}
		const next = withOperationStatuses(plan, updates);
		const remaining = next.operations.some(o => o.status === 'pending' || o.status === 'accepted');
		this._pending = withOperationStatuses(next, updates, remaining ? 'partial' : 'applied');
		this.recordMemory(this._pending, targets.map(o => this.opPath(o)), [], 'applied_external');
		this._onDidChangePlans.fire();
		this.logService.info(`[FrameEdit] Plan ${planId} marked externally applied (${targets.length} op(s))`);
	}

	async proposeStubPlan(taskId: string, prompt: string, context: IFrameInferenceContext, modelOutput?: string): Promise<IFrameEditPlan> {
		const parsed = modelOutput ? parseModelEditPlan(taskId, prompt, context, modelOutput) : undefined;
		const recovered = parsed ?? synthesizeRecoveredEditPlan(taskId, prompt, context, modelOutput, {
			readFileContent: (rel) => this.readRelativeSyncCache(rel),
		});
		let plan = recovered ?? buildStubEditPlan(taskId, prompt, context, {
			readFileContent: (rel) => this.readRelativeSyncCache(rel),
		});
		let next = await this.hydrateOriginalContents(plan);
		const destructive = next.operations.some(op =>
			op.kind === 'modify'
			&& isSuspiciousDestructiveModify(prompt, op.originalContent ?? '', op.newContent)
		);
		if (destructive) {
			// A valid JSON plan can still be truncated by the model's token limit.
			// Prefer a deterministic additive recovery; otherwise suppress Apply.
			const safeRecovery = synthesizeRecoveredEditPlan(taskId, prompt, context, modelOutput, {
				readFileContent: (rel) => this.readRelativeSyncCache(rel),
			});
			plan = safeRecovery ?? buildStubEditPlan(taskId, prompt, context, {
				readFileContent: (rel) => this.readRelativeSyncCache(rel),
			});
			next = await this.hydrateOriginalContents(plan);
			this.logService.warn('[FrameEdit] Rejected destructive/truncated model replacement; using safe recovery or stub.');
		}
		this._pending = next;
		this._onDidChangePlans.fire();
		this.logService.info(
			`[FrameEdit] ${next.stub ? 'Stub' : 'Model/recovered'} plan ${next.id} with ${next.operations.length} ops`,
		);
		return next;
	}

	private async hydrateOriginalContents(plan: IFrameEditPlan): Promise<IFrameEditPlan> {
		// Fill original contents asynchronously for preview, safety checks, and undo accuracy.
		const ops: IFrameEditOperation[] = [];
		for (const op of plan.operations) {
			if (op.kind === 'modify' && op.sourceEdit) {
				const original = await this.readRelative(op.path);
				if (original === undefined) {
					ops.push({ ...op, originalContent: '', newContent: op.sourceEdit.content });
					continue;
				}
				const newContent = materializeSourceEdit(original, op.sourceEdit);
				ops.push({ ...op, originalContent: original, newContent });
			} else if (op.kind === 'modify' && op.originalContent === undefined) {
				const original = await this.readRelative(op.path);
				ops.push({ ...op, originalContent: original ?? '' });
			} else {
				ops.push(op);
			}
		}
		return { ...plan, operations: ops };
	}

	validatePlan(plan: IFrameEditPlan): { ok: boolean; issues: readonly string[] } {
		const issues: string[] = [];
		const folder = this.primaryFolder();
		if (!plan.operations.length) {
			issues.push('Plan has no operations.');
		}
		for (const op of plan.operations) {
			if (op.kind === 'create' || op.kind === 'modify' || op.kind === 'delete') {
				if (!folder) {
					issues.push(`No workspace folder for ${op.kind}: ${op.path}`);
				} else {
					const resolved = resolveSafeWorkspacePath(folder, op.path);
					if (!resolved.ok) {
						issues.push(`Unsafe path in ${op.kind}: ${op.path} (${resolved.error})`);
					}
				}
			}
			if (op.kind === 'modify' && isSuspiciousDestructiveModify(plan.prompt, op.originalContent ?? '', op.newContent)) {
				issues.push(`Suspicious destructive replacement blocked: ${op.path}`);
			}
			if (op.kind === 'rename') {
				if (!folder) {
					issues.push(`No workspace folder for rename: ${op.fromPath} → ${op.toPath}`);
				} else {
					const from = resolveSafeWorkspacePath(folder, op.fromPath);
					const to = resolveSafeWorkspacePath(folder, op.toPath);
					if (!from.ok || !to.ok) {
						issues.push(`Unsafe rename paths: ${op.fromPath} → ${op.toPath}`);
					}
				}
			}
		}
		return { ok: issues.length === 0, issues };
	}

	buildWorkspaceEdit(plan: IFrameEditPlan, operationIds?: readonly string[]): ResourceEdit[] {
		const folder = this.primaryFolder();
		if (!folder) {
			return [];
		}
		const targets = plan.operations.filter(o => !operationIds || operationIds.includes(o.id));
		const edits: ResourceEdit[] = [];
		for (const op of targets) {
			switch (op.kind) {
				case 'create': {
					const resolved = resolveSafeWorkspacePath(folder, op.path);
					if (!resolved.ok) {
						break;
					}
					edits.push(new ResourceFileEdit(undefined, resolved.uri, {
						contents: Promise.resolve(VSBuffer.fromString(op.content)),
						overwrite: false,
					}));
					break;
				}
				case 'modify': {
					const resolved = resolveSafeWorkspacePath(folder, op.path);
					if (!resolved.ok) {
						break;
					}
					edits.push(new ResourceFileEdit(undefined, resolved.uri, {
						contents: Promise.resolve(VSBuffer.fromString(op.newContent)),
						overwrite: true,
					}));
					break;
				}
				case 'delete': {
					const resolved = resolveSafeWorkspacePath(folder, op.path);
					if (!resolved.ok) {
						break;
					}
					edits.push(new ResourceFileEdit(resolved.uri, undefined, { recursive: true, ignoreIfNotExists: true }));
					break;
				}
				case 'rename': {
					const from = resolveSafeWorkspacePath(folder, op.fromPath);
					const to = resolveSafeWorkspacePath(folder, op.toPath);
					if (!from.ok || !to.ok) {
						break;
					}
					edits.push(new ResourceFileEdit(from.uri, to.uri, { overwrite: true }));
					break;
				}
			}
		}
		return edits;
	}

	async acceptAll(): Promise<IFrameEditApplyResult> {
		const plan = this._pending;
		if (!plan) {
			return { ok: false, plan: emptyPlan(), appliedOperationIds: [], failedOperationIds: [], message: 'No pending edit plan.' };
		}
		const pendingOps = plan.operations.filter(o => o.status === 'pending' || o.status === 'accepted');
		return this.applyOperations(plan, pendingOps.map(o => o.id));
	}

	async rejectAll(): Promise<void> {
		const plan = this._pending;
		if (!plan) {
			return;
		}
		const updates = new Map<string, FrameEditOperationStatus>();
		for (const op of plan.operations) {
			if (op.status === 'pending' || op.status === 'accepted') {
				updates.set(op.id, 'rejected');
			}
		}
		this._pending = withOperationStatuses(plan, updates, 'rejected');
		this.recordMemory(this._pending, [], this._pending.operations.map(o => this.opPath(o)), 'rejected');
		this._onDidChangePlans.fire();
	}

	async acceptOperation(operationId: string): Promise<IFrameEditApplyResult> {
		const plan = this._pending;
		if (!plan) {
			return { ok: false, plan: emptyPlan(), appliedOperationIds: [], failedOperationIds: [], message: 'No pending edit plan.' };
		}
		return this.applyOperations(plan, [operationId]);
	}

	async rejectOperation(operationId: string): Promise<void> {
		const plan = this._pending;
		if (!plan) {
			return;
		}
		const op = plan.operations.find(o => o.id === operationId);
		if (!op) {
			return;
		}
		const updates = new Map<string, FrameEditOperationStatus>([[operationId, 'rejected']]);
		const next = withOperationStatuses(plan, updates);
		const allDone = next.operations.every(o => o.status === 'rejected' || o.status === 'applied' || o.status === 'failed');
		this._pending = withOperationStatuses(next, updates, allDone ? 'rejected' : 'partial');
		this.recordMemory(this._pending, [], [this.opPath(op)], 'rejected_file');
		this._onDidChangePlans.fire();
	}

	async undoLastApply(): Promise<boolean> {
		const snap = this._rollback;
		const folder = this.primaryFolder();
		if (!snap || !folder) {
			return false;
		}
		try {
			for (const entry of [...snap.entries].reverse()) {
				const uri = joinPath(folder, entry.path);
				if (entry.kind === 'missing') {
					if (await this.fileService.exists(uri)) {
						await this.fileService.del(uri, { recursive: true });
					}
					this._readCache.delete(entry.path);
				} else if (entry.content !== undefined) {
					await this.ensureParent(uri);
					await this.fileService.writeFile(uri, VSBuffer.fromString(entry.content));
					this.cacheRead(entry.path, entry.content);
				}
			}
			if (this._pending) {
				const updates = new Map<string, FrameEditOperationStatus>();
				for (const op of this._pending.operations) {
					if (op.status === 'applied') {
						updates.set(op.id, 'rolled_back');
					}
				}
				this._pending = withOperationStatuses(this._pending, updates, 'rolled_back');
			}
			this._rollback = undefined;
			this._onDidChangePlans.fire();
			this.logService.info(`[FrameEdit] Rollback ${snap.id} complete`);
			return true;
		} catch (err) {
			this.logService.error(`[FrameEdit] Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	getLastMemoryRecord(): IFrameEditMemoryRecord | undefined {
		return this._lastMemory;
	}

	/** Exposed for orchestrator intent checks. */
	static isEditIntent(prompt: string): boolean {
		return isFrameEditIntent(prompt);
	}

	private async applyOperations(plan: IFrameEditPlan, operationIds: readonly string[]): Promise<IFrameEditApplyResult> {
		// Stub plans intentionally carry no operations — refuse instead of writing junk.
		if (plan.stub && !plan.operations.length) {
			return {
				ok: false,
				plan,
				appliedOperationIds: [],
				failedOperationIds: [],
				message: FRAME_STUB_PLAN_MESSAGE,
			};
		}
		const validation = this.validatePlan(plan);
		if (!validation.ok) {
			return {
				ok: false,
				plan,
				appliedOperationIds: [],
				failedOperationIds: [...operationIds],
				message: validation.issues.join('; '),
			};
		}

		const folder = this.primaryFolder();
		if (!folder) {
			return {
				ok: false,
				plan,
				appliedOperationIds: [],
				failedOperationIds: [...operationIds],
				message: 'Open a workspace folder before applying edits.',
			};
		}

		const targets = plan.operations.filter(o => operationIds.includes(o.id) && o.status !== 'rejected' && o.status !== 'applied');
		for (const op of targets) {
			if (op.kind !== 'modify') {
				continue;
			}
			const current = await this.readRelative(op.path);
			if (current === undefined) {
				return {
					ok: false,
					plan,
					appliedOperationIds: [],
					failedOperationIds: [op.id],
					message: `File changed or disappeared before apply: ${op.path}`,
				};
			}
			if (op.originalContent !== undefined && current !== op.originalContent) {
				return {
					ok: false,
					plan,
					appliedOperationIds: [],
					failedOperationIds: [op.id],
					message: `File changed after the edit was proposed; regenerate the plan: ${op.path}`,
				};
			}
			if (isSuspiciousDestructiveModify(plan.prompt, current, op.newContent)) {
				return {
					ok: false,
					plan,
					appliedOperationIds: [],
					failedOperationIds: [op.id],
					message: `Unsafe destructive replacement blocked: ${op.path}`,
				};
			}
		}
		const snapshotEntries: IRollbackSnapshot['entries'][number][] = [];

		// Snapshot before apply
		for (const op of targets) {
			for (const path of this.pathsTouched(op)) {
				const uri = joinPath(folder, path);
				if (await this.fileService.exists(uri)) {
					try {
						const buf = await this.fileService.readFile(uri);
						snapshotEntries.push({ path, kind: 'file', content: buf.value.toString() });
					} catch {
						snapshotEntries.push({ path, kind: 'missing' });
					}
				} else {
					snapshotEntries.push({ path, kind: 'missing' });
				}
			}
		}
		const rollbackId = generateUuid();
		this._rollback = { id: rollbackId, planId: plan.id, createdAt: Date.now(), entries: snapshotEntries };

		const updates = new Map<string, FrameEditOperationStatus>();
		const applied: string[] = [];
		const failed: string[] = [];

		for (const op of targets) {
			try {
				await this.applyOne(folder, op);
				updates.set(op.id, 'applied');
				applied.push(op.id);
			} catch (err) {
				this.logService.warn(`[FrameEdit] Op ${op.id} failed: ${err instanceof Error ? err.message : String(err)}`);
				updates.set(op.id, 'failed');
				failed.push(op.id);
				// Best-effort: stop further ops and leave rollback available
				break;
			}
		}

		const nextStatus = failed.length
			? 'partial'
			: plan.operations.every(o => updates.get(o.id) === 'applied' || o.status === 'applied' || o.status === 'rejected')
				? 'applied'
				: 'partial';
		this._pending = withOperationStatuses(plan, updates, nextStatus as IFrameEditPlan['status']);
		this.recordMemory(
			this._pending,
			applied.map(id => this.opPath(plan.operations.find(o => o.id === id)!)),
			failed.map(id => this.opPath(plan.operations.find(o => o.id === id)!)),
			failed.length ? 'partial_apply' : 'applied',
		);
		this._onDidChangePlans.fire();

		return {
			ok: failed.length === 0,
			plan: this._pending,
			appliedOperationIds: applied,
			failedOperationIds: failed,
			message: failed.length
				? `Applied ${applied.length}, failed ${failed.length}. Use Undo to restore snapshots.`
				: `Applied ${applied.length} edit(s).`,
			rollbackId,
		};
	}

	private async applyOne(folder: URI, op: IFrameEditOperation): Promise<void> {
		switch (op.kind) {
			case 'create': {
				const uri = joinPath(folder, op.path);
				if (await this.fileService.exists(uri)) {
					throw new Error(`Refusing to create — file already exists: ${op.path}. Use modify instead.`);
				}
				await this.ensureParent(uri);
				await this.fileService.writeFile(uri, VSBuffer.fromString(op.content));
				this.cacheRead(op.path, op.content);
				return;
			}
			case 'modify': {
				const uri = joinPath(folder, op.path);
				await this.ensureParent(uri);
				await this.fileService.writeFile(uri, VSBuffer.fromString(op.newContent));
				this.cacheRead(op.path, op.newContent);
				return;
			}
			case 'delete': {
				const uri = joinPath(folder, op.path);
				if (await this.fileService.exists(uri)) {
					await this.fileService.del(uri, { recursive: true });
				}
				this._readCache.delete(op.path);
				return;
			}
			case 'rename': {
				const from = joinPath(folder, op.fromPath);
				const to = joinPath(folder, op.toPath);
				await this.ensureParent(to);
				await this.fileService.move(from, to, true);
				this._readCache.delete(op.fromPath);
				this._readCache.delete(op.toPath);
				return;
			}
		}
	}

	private pathsTouched(op: IFrameEditOperation): string[] {
		switch (op.kind) {
			case 'create':
			case 'modify':
			case 'delete':
				return [op.path];
			case 'rename':
				return [op.fromPath, op.toPath];
		}
	}

	private opPath(op: IFrameEditOperation): string {
		switch (op.kind) {
			case 'create':
			case 'modify':
			case 'delete':
				return op.path;
			case 'rename':
				return `${op.fromPath}→${op.toPath}`;
		}
	}

	private async readRelative(rel: string): Promise<string | undefined> {
		const folder = this.primaryFolder();
		if (!folder) {
			return undefined;
		}
		const uri = joinPath(folder, rel);
		try {
			if (!(await this.fileService.exists(uri))) {
				this._readCache.delete(rel);
				return undefined;
			}
			const content = (await this.fileService.readFile(uri)).value.toString();
			this.cacheRead(rel, content);
			return content;
		} catch {
			this._readCache.delete(rel);
			return undefined;
		}
	}

	/** Fresh-enough (<30s) entry from the async read cache, for sync stub/recovery lookups. */
	private readRelativeSyncCache(rel: string): string | undefined {
		const entry = this._readCache.get(rel);
		if (!entry || Date.now() - entry.at > FrameWorkspaceEditService.READ_CACHE_TTL_MS) {
			return undefined;
		}
		return entry.content;
	}

	private cacheRead(rel: string, content: string): void {
		// Re-insert to refresh LRU order (Map preserves insertion order).
		this._readCache.delete(rel);
		this._readCache.set(rel, { content, at: Date.now() });
		while (this._readCache.size > FrameWorkspaceEditService.READ_CACHE_MAX_ENTRIES) {
			const oldest = this._readCache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this._readCache.delete(oldest);
		}
	}

	private recordMemory(
		plan: IFrameEditPlan,
		accepted: readonly string[],
		rejected: readonly string[],
		executionResult: string,
	): void {
		this._lastMemory = {
			id: generateUuid(),
			timestamp: Date.now(),
			prompt: plan.prompt,
			planId: plan.id,
			acceptedFiles: accepted,
			rejectedFiles: rejected,
			executionResult,
			taskId: plan.taskId,
		};
		this.persistMemory(this._lastMemory).catch(err => this.logService.warn('[FrameEdit] Failed to persist edit memory record', err));
	}

	private async persistMemory(record: IFrameEditMemoryRecord): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const dir = joinPath(folder, '.frame', 'memory', 'edits');
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'memory'));
		await this.ensureDir(dir);
		const uri = joinPath(dir, `${record.timestamp}-${record.id.slice(0, 8)}.json`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(record, null, 2) + '\n'));
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async ensureParent(uri: URI): Promise<void> {
		await this.ensureDir(dirname(uri));
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}

function emptyPlan(): IFrameEditPlan {
	return {
		id: 'none',
		taskId: 'none',
		prompt: '',
		createdAt: Date.now(),
		summary: 'No plan',
		operations: [],
		stub: true,
		status: 'rejected',
	};
}

export type { IFrameEditDiffFileSummary };
