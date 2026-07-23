/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FrameGenerationStatus,
	FrameObservationChangeType,
	IFrameObservation,
	IFrameTrackGenerationInput,
	IFrameTrackedGeneration,
} from '../common/models.js';
import { IFrameObservationService } from './frameObservation.js';
import { IFrameGenerationTracker } from './frameGenerationTracker.js';

interface IMutableGeneration {
	generationId: string;
	taskId?: string;
	file?: string;
	language?: string;
	content: string;
	timestamp: number;
	project?: string;
	status: FrameGenerationStatus;
	uri?: string;
	startLineNumber?: number;
	startColumn?: number;
	endLineNumber?: number;
	endColumn?: number;
	trackedText?: string;
}

interface IActiveWatch {
	readonly generationId: string;
	readonly model: ITextModel;
	readonly disposable: IDisposable;
}

/**
 * Connects Frame generations to observations.
 * Editor listening is scoped to inserted Frame ranges only.
 */
export class FrameGenerationTrackerService extends Disposable implements IFrameGenerationTracker {

	declare readonly _serviceBrand: undefined;

	private readonly _generations = new Map<string, IMutableGeneration>();
	private readonly _watches = new Map<string, IActiveWatch>();
	private readonly _watchStore = this._register(new DisposableStore());

	private readonly _onDidChangeGenerations = this._register(new Emitter<void>());
	readonly onDidChangeGenerations: Event<void> = this._onDidChangeGenerations.event;

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFrameObservationService private readonly observationService: IFrameObservationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[FrameGeneration] Tracker ready (Frame-generated ranges only)');
	}

	trackGeneration(input: IFrameTrackGenerationInput): IFrameTrackedGeneration {
		const content = extractApplicableContent(input.content);
		const generation: IMutableGeneration = {
			generationId: input.generationId || generateUuid(),
			taskId: input.taskId,
			file: input.file,
			language: input.language,
			content,
			timestamp: Date.now(),
			project: input.project ?? this.workspaceService.getWorkspace().name,
			status: FrameGenerationStatus.Pending,
		};
		this._generations.set(generation.generationId, generation);
		this._onDidChangeGenerations.fire();
		this.logService.trace(`[FrameGeneration] Tracked ${generation.generationId} (${content.length} chars)`);
		return generation;
	}

	getGeneration(generationId: string): IFrameTrackedGeneration | undefined {
		return this._generations.get(generationId);
	}

	listGenerations(filter?: { status?: FrameGenerationStatus }): readonly IFrameTrackedGeneration[] {
		let list = [...this._generations.values()];
		if (filter?.status) {
			list = list.filter(g => g.status === filter.status);
		}
		return list.sort((a, b) => b.timestamp - a.timestamp);
	}

	async acceptGeneration(generationId: string): Promise<IFrameObservation | undefined> {
		const generation = this._generations.get(generationId);
		if (!generation) {
			return undefined;
		}
		if (generation.status === FrameGenerationStatus.Rejected || generation.status === FrameGenerationStatus.Expired) {
			return undefined;
		}

		// Already inserted — treat as explicit accept acknowledgment
		if (generation.status === FrameGenerationStatus.Inserted || generation.status === FrameGenerationStatus.Edited || generation.status === FrameGenerationStatus.Accepted) {
			if (generation.status !== FrameGenerationStatus.Accepted) {
				generation.status = FrameGenerationStatus.Accepted;
				this._onDidChangeGenerations.fire();
			}
			return undefined;
		}

		const editor = this.codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!editor || !model) {
			this.logService.info('[FrameGeneration] Accept skipped — no active editor');
			return undefined;
		}

		const insertText = generation.content;
		if (!insertText.trim()) {
			return undefined;
		}

		const position = editor.getPosition() ?? model.getPositionAt(model.getValueLength());
		const startLine = position.lineNumber;
		const startColumn = position.column;

		const editRange = new Range(startLine, startColumn, startLine, startColumn);
		model.pushEditOperations(
			editor.getSelections(),
			[{ range: editRange, text: insertText }],
			() => null,
		);

		const endPosition = model.getPositionAt(model.getOffsetAt(position) + insertText.length);
		generation.uri = model.uri.toString(true);
		generation.file = generation.file ?? model.uri.path;
		generation.language = generation.language ?? model.getLanguageId();
		generation.startLineNumber = startLine;
		generation.startColumn = startColumn;
		generation.endLineNumber = endPosition.lineNumber;
		generation.endColumn = endPosition.column;
		generation.trackedText = insertText;
		generation.status = FrameGenerationStatus.Inserted;

		this.startWatching(generation, model);

		const observation = await this.observationService.recordObservation({
			before: '',
			after: insertText,
			changeType: FrameObservationChangeType.AcceptedGeneration,
			language: generation.language,
			file: generation.file,
			project: generation.project,
			taskId: generation.taskId,
			generationId: generation.generationId,
			confidence: 0.9,
			diffSummary: `accepted_generation:+${insertText.length}chars`,
		});

		generation.status = FrameGenerationStatus.Accepted;
		this._onDidChangeGenerations.fire();
		this.logService.info(`[FrameGeneration] Accepted ${generation.generationId} into ${generation.file}`);
		return observation;
	}

	async rejectGeneration(generationId: string): Promise<IFrameObservation | undefined> {
		const generation = this._generations.get(generationId);
		if (!generation) {
			return undefined;
		}
		if (generation.status === FrameGenerationStatus.Rejected || generation.status === FrameGenerationStatus.Expired) {
			return undefined;
		}

		// Stop watching; do not delete already-inserted user text from the buffer.
		this.stopWatching(generationId);
		generation.status = FrameGenerationStatus.Rejected;
		this._onDidChangeGenerations.fire();

		const observation = await this.observationService.recordObservation({
			before: generation.content,
			after: '',
			changeType: FrameObservationChangeType.RejectedGeneration,
			language: generation.language,
			file: generation.file,
			project: generation.project,
			taskId: generation.taskId,
			generationId: generation.generationId,
			confidence: 0.85,
			diffSummary: 'rejected_generation:discarded',
		});

		this.logService.info(`[FrameGeneration] Rejected ${generation.generationId}`);
		return observation;
	}

	private startWatching(generation: IMutableGeneration, model: ITextModel): void {
		this.stopWatching(generation.generationId);

		const disposable = model.onDidChangeContent(e => {
			void this.onModelContentChanged(generation.generationId, model, e);
		});
		this._watches.set(generation.generationId, {
			generationId: generation.generationId,
			model,
			disposable,
		});
		this._watchStore.add(disposable);
	}

	private stopWatching(generationId: string): void {
		const watch = this._watches.get(generationId);
		if (!watch) {
			return;
		}
		watch.disposable.dispose();
		this._watches.delete(generationId);
	}

	private async onModelContentChanged(generationId: string, model: ITextModel, event: IModelContentChangedEvent): Promise<void> {
		const generation = this._generations.get(generationId);
		if (!generation || generation.uri !== model.uri.toString(true)) {
			return;
		}
		if (generation.status === FrameGenerationStatus.Rejected || generation.status === FrameGenerationStatus.Expired) {
			return;
		}
		if (
			generation.startLineNumber === undefined
			|| generation.startColumn === undefined
			|| generation.endLineNumber === undefined
			|| generation.endColumn === undefined
		) {
			return;
		}

		const trackedRange = new Range(
			generation.startLineNumber,
			generation.startColumn,
			generation.endLineNumber,
			generation.endColumn,
		);

		// Privacy boundary: ignore edits that do not intersect the Frame generation range
		const intersects = event.changes.some(change => Range.areIntersectingOrTouching(trackedRange, change.range));
		if (!intersects) {
			return;
		}

		const before = generation.trackedText ?? generation.content;
		// Adjust end range by net character delta within the tracked span
		let netDelta = 0;
		for (const change of event.changes) {
			if (!Range.areIntersectingOrTouching(trackedRange, change.range)) {
				continue;
			}
			netDelta += change.text.length - (change.rangeLength ?? 0);
		}

		const startOffset = model.getOffsetAt({ lineNumber: generation.startLineNumber, column: generation.startColumn });
		const previousEndOffset = model.getOffsetAt({ lineNumber: generation.endLineNumber, column: generation.endColumn });
		const newEndOffset = Math.max(startOffset, previousEndOffset + netDelta);
		const clampedEnd = Math.min(newEndOffset, model.getValueLength());
		const endPos = model.getPositionAt(clampedEnd);

		generation.endLineNumber = endPos.lineNumber;
		generation.endColumn = endPos.column;
		const after = model.getValueInRange(new Range(
			generation.startLineNumber,
			generation.startColumn,
			generation.endLineNumber,
			generation.endColumn,
		));

		if (after === before) {
			return;
		}

		generation.trackedText = after;
		generation.status = FrameGenerationStatus.Edited;
		this._onDidChangeGenerations.fire();

		await this.observationService.recordObservation({
			before,
			after,
			changeType: FrameObservationChangeType.EditedGeneration,
			language: generation.language ?? model.getLanguageId(),
			file: generation.file ?? model.uri.path,
			project: generation.project,
			taskId: generation.taskId,
			generationId: generation.generationId,
			confidence: 0.75,
			diffSummary: summarizeDiff(before, after),
		});

		this.logService.trace(`[FrameGeneration] In-range edit on ${generation.generationId}`);
	}

	override dispose(): void {
		for (const id of [...this._watches.keys()]) {
			this.stopWatching(id);
		}
		super.dispose();
	}
}

/** Prefer fenced code blocks from model output; otherwise use trimmed body. */
function extractApplicableContent(raw: string): string {
	const fence = /```(?:[\w+-]*)\n([\s\S]*?)```/g;
	const blocks: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = fence.exec(raw)) !== null) {
		const body = match[1].trim();
		if (body) {
			blocks.push(body);
		}
	}
	if (blocks.length) {
		return blocks.join('\n\n');
	}
	return raw.trim();
}

function summarizeDiff(before: string, after: string): string {
	const beforeLines = before.split(/\r?\n/).length;
	const afterLines = after.split(/\r?\n/).length;
	return `edited_generation:lines ${beforeLines}→${afterLines}, chars ${before.length}→${after.length}`;
}
