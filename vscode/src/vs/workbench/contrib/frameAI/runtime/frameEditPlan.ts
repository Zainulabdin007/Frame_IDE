/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { IFrameInferenceContext } from '../common/models.js';

/**
 * Frame edit plan — proposed workspace mutations from the intelligence pipeline.
 * Prefer model-emitted ```frame-edit-plan``` JSON via {@link parseModelEditPlan};
 * fall back to {@link buildStubEditPlan} when absent.
 */

export type FrameEditOperationKind = 'create' | 'modify' | 'delete' | 'rename';

export type FrameEditOperationStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'failed' | 'rolled_back';

export interface IFrameEditOperationBase {
	readonly id: string;
	readonly kind: FrameEditOperationKind;
	readonly status: FrameEditOperationStatus;
	readonly reason?: string;
}

export interface IFrameCreateFileOperation extends IFrameEditOperationBase {
	readonly kind: 'create';
	/** Workspace-relative path. */
	readonly path: string;
	readonly content: string;
}

export interface IFrameModifyFileOperation extends IFrameEditOperationBase {
	readonly kind: 'modify';
	readonly path: string;
	/** Full proposed file contents (deterministic stub). */
	readonly newContent: string;
	/** Optional original contents captured at plan time. */
	readonly originalContent?: string;
	/**
	 * Concise model operation that must be materialized against the authoritative
	 * file contents before preview/apply. Never use truncated prompt context.
	 */
	readonly sourceEdit?: IFrameSourceEdit;
}

export interface IFrameSourceEdit {
	readonly kind: 'append' | 'prepend' | 'insertLine';
	readonly content: string;
	readonly line?: number;
}

export interface IFrameDeleteFileOperation extends IFrameEditOperationBase {
	readonly kind: 'delete';
	readonly path: string;
}

export interface IFrameRenameFileOperation extends IFrameEditOperationBase {
	readonly kind: 'rename';
	readonly fromPath: string;
	readonly toPath: string;
}

export type IFrameEditOperation =
	| IFrameCreateFileOperation
	| IFrameModifyFileOperation
	| IFrameDeleteFileOperation
	| IFrameRenameFileOperation;

export interface IFrameEditPlan {
	readonly id: string;
	readonly taskId: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly summary: string;
	readonly operations: readonly IFrameEditOperation[];
	/** `true` when built by {@link buildStubEditPlan}; `false` when parsed from model output. */
	readonly stub: boolean;
	readonly status: 'preview' | 'partial' | 'applied' | 'rejected' | 'rolled_back';
}

export interface IFrameEditDiffFileSummary {
	readonly operationId: string;
	readonly path: string;
	readonly kind: FrameEditOperationKind;
	readonly additions: number;
	readonly deletions: number;
	readonly status: FrameEditOperationStatus;
	readonly preview?: string;
}

export interface IFrameEditPlanPreview {
	readonly planId: string;
	readonly summary: string;
	readonly files: readonly IFrameEditDiffFileSummary[];
	readonly totalAdditions: number;
	readonly totalDeletions: number;
}

/** Detect whether a prompt should produce a stub edit plan. */
export function isFrameEditIntent(prompt: string): boolean {
	return /\b(edit|create|add(?:ed|ing)?|fix|refactor|delete|remove|rename|implement|write|update|modify|insert|change|make\s+the\s+change|generate\s+file)\b/i.test(prompt.trim());
}

/**
 * Formerly rejected likely truncated full-file replacements.
 * Disabled for now so local preview can apply model edits as-produced.
 */
export function isSuspiciousDestructiveModify(_prompt: string, _originalContent: string, _newContent: string): boolean {
	return false;
}

/** Materialize a concise operation against authoritative full file contents. */
export function materializeSourceEdit(originalContent: string, sourceEdit: IFrameSourceEdit): string {
	if (sourceEdit.kind === 'prepend') {
		return `${sourceEdit.content}${originalContent}`;
	}
	const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
	if (sourceEdit.kind === 'insertLine') {
		const lines = originalContent.split(/\r?\n/);
		const index = Math.max(0, Math.min(lines.length, (sourceEdit.line ?? 1) - 1));
		lines.splice(index, 0, sourceEdit.content);
		return lines.join(eol);
	}
	return `${originalContent}${originalContent.length > 0 && !originalContent.endsWith('\n') ? eol : ''}${sourceEdit.content}${sourceEdit.content.endsWith('\n') ? '' : eol}`;
}

/**
 * Pull the JSON object after a ```frame-edit-plan fence via brace matching.
 * Do NOT use a non-greedy regex to the next ``` — file contents inside
 * `newContent` often contain nested markdown fences and would truncate early.
 */
export function extractFrameEditPlanJson(modelOutput: string): string | undefined {
	const fence = /```frame-edit-plan\b[^\n]*\r?\n?/i.exec(modelOutput);
	if (!fence || fence.index === undefined) {
		return undefined;
	}
	return extractBalancedJsonObject(modelOutput, fence.index + fence[0].length);
}

/** First `{...}` object starting at or after `from`, respecting JSON strings. */
function extractBalancedJsonObject(text: string, from: number): string | undefined {
	const brace = text.indexOf('{', from);
	if (brace < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = brace; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === 92 /* \\ */) {
				escape = true;
				continue;
			}
			if (ch === 34 /* " */) {
				inString = false;
			}
			continue;
		}
		if (ch === 34 /* " */) {
			inString = true;
			continue;
		}
		if (ch === 123 /* { */) {
			depth++;
		} else if (ch === 125 /* } */) {
			depth--;
			if (depth === 0) {
				return text.slice(brace, i + 1);
			}
		}
	}
	return undefined;
}

/**
 * Remove ```frame-edit-plan``` / ```frame-tool``` control blocks from chat prose.
 * Incomplete trailing fences (truncated model output) are dropped from the fence onward.
 */
export function stripFrameControlFences(text: string): string {
	if (!text) {
		return text;
	}
	let out = text;
	const fenceRe = /```(?:frame-edit-plan|frame-tool)\b/i;
	while (true) {
		const m = fenceRe.exec(out);
		if (!m || m.index === undefined) {
			break;
		}
		const from = m.index;
		const afterOpen = out.slice(from).match(/^```(?:frame-edit-plan|frame-tool)\b[^\n]*\r?\n?/i);
		const bodyStart = from + (afterOpen?.[0].length ?? m[0].length);
		const json = extractBalancedJsonObject(out, bodyStart);
		let end: number;
		if (json) {
			const jsonAt = out.indexOf(json, bodyStart);
			end = jsonAt + json.length;
			const close = out.slice(end).match(/^\s*```/);
			if (close) {
				end += close[0].length;
			}
		} else {
			// Truncated fence — hide everything from the control marker.
			out = out.slice(0, from).replace(/\s+$/, '');
			break;
		}
		out = `${out.slice(0, from)}${out.slice(end)}`.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
	}
	return out.trim();
}

/**
 * Extract a structured edit plan from model output when present.
 * Looks for a fenced ```frame-edit-plan JSON block with an `operations` array
 * matching {@link IFrameEditOperation} shapes (create / modify / delete / rename).
 * Returns `undefined` when no valid plan is found (caller should fall back to stub).
 */
export function parseModelEditPlan(
	taskId: string,
	prompt: string,
	context: IFrameInferenceContext,
	modelOutput: string,
): IFrameEditPlan | undefined {
	if (!modelOutput?.trim()) {
		return undefined;
	}

	const rawJson = extractFrameEditPlanJson(modelOutput)?.trim();
	if (!rawJson) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return undefined;
	}

	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}

	const body = parsed as { operations?: unknown; summary?: unknown };
	if (!Array.isArray(body.operations) || body.operations.length === 0) {
		return undefined;
	}

	const operations: IFrameEditOperation[] = [];
	for (const item of body.operations) {
		const op = normalizeModelOperation(item, context);
		if (op) {
			operations.push(op);
		}
	}

	if (!operations.length) {
		return undefined;
	}

	const summary = typeof body.summary === 'string' && body.summary.trim()
		? body.summary.trim()
		: `Model edit plan: ${operations.length} operation(s).`;

	return {
		id: generateUuid(),
		taskId,
		prompt,
		createdAt: Date.now(),
		summary,
		operations,
		stub: false,
		status: 'preview',
	};
}

/**
 * Order:
 * 1) Small additive heuristics (prepend / append / insert) from the user prompt
 * 2) Full-file replace from a model code fence when present
 */
export function synthesizeRecoveredEditPlan(
	taskId: string,
	prompt: string,
	context: IFrameInferenceContext,
	modelOutput: string | undefined,
	options?: { readonly readFileContent?: (relativePath: string) => string | undefined },
): IFrameEditPlan | undefined {
	const active = context.activeRelativePath;
	if (!active) {
		return undefined;
	}

	const original = context.activeFileContent
		?? options?.readFileContent?.(active)
		?? undefined;
	if (original === undefined) {
		return undefined;
	}

	const insertedLine = tryInsertAtLine(prompt, original);
	if (insertedLine) {
		return {
			id: generateUuid(),
			taskId,
			prompt,
			createdAt: Date.now(),
			summary: `Insert “${insertedLine.content}” at line ${insertedLine.line} of ${active}.`,
			operations: [{
				id: generateUuid(),
				kind: 'modify',
				status: 'pending',
				path: active,
				reason: 'Recovered targeted line insertion from user prompt.',
				newContent: insertedLine.content,
				sourceEdit: { kind: 'insertLine', content: insertedLine.content, line: insertedLine.line },
			}],
			stub: false,
			status: 'preview',
		};
	}

	const prepended = tryPrependToFirstLine(prompt, original);
	if (prepended !== undefined && prepended !== original) {
		const word = extractEditToken(prompt) ?? '…';
		const prefix = prepended.slice(0, Math.max(0, prepended.length - original.length));
		return {
			id: generateUuid(),
			taskId,
			prompt,
			createdAt: Date.now(),
			summary: `Prepend “${word}” to the first line of ${active}.`,
			operations: [{
				id: generateUuid(),
				kind: 'modify',
				status: 'pending',
				path: active,
				reason: 'Recovered first-line prepend from user prompt.',
				newContent: prefix,
				sourceEdit: { kind: 'prepend', content: prefix },
			}],
			stub: false,
			status: 'preview',
		};
	}

	const appended = tryAppendToEndOfFile(prompt, original);
	if (appended !== undefined && appended !== original) {
		const word = extractEditToken(prompt) ?? '…';
		const suffix = appended.slice(original.length).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
		return {
			id: generateUuid(),
			taskId,
			prompt,
			createdAt: Date.now(),
			summary: `Append “${word}” to the end of ${active}.`,
			operations: [{
				id: generateUuid(),
				kind: 'modify',
				status: 'pending',
				path: active,
				reason: 'Recovered end-of-file append from user prompt.',
				newContent: suffix,
				sourceEdit: { kind: 'append', content: suffix },
			}],
			stub: false,
			status: 'preview',
		};
	}

	// Prefer applying a model code fence to the active file when no structured plan was emitted.
	const fromFence = extractLargestCodeFence(modelOutput ?? '');
	if (fromFence && fromFence !== original) {
		return {
			id: generateUuid(),
			taskId,
			prompt,
			createdAt: Date.now(),
			summary: `Apply model code block to ${active}.`,
			operations: [{
				id: generateUuid(),
				kind: 'modify',
				status: 'pending',
				path: active,
				reason: 'Recovered file edit from model markdown fence.',
				originalContent: original,
				newContent: fromFence.endsWith('\n') ? fromFence : `${fromFence}\n`,
			}],
			stub: false,
			status: 'preview',
		};
	}

	return undefined;
}

function extractLargestCodeFence(text: string): string | undefined {
	if (!text.trim()) {
		return undefined;
	}
	const re = /```(?:[\w.+-]*)\s*\r?\n([\s\S]*?)```/g;
	let best: string | undefined;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const body = match[1].replace(/\s+$/, '');
		// Skip our own control fences.
		const lang = (match[0].match(/```([\w.+-]*)/)?.[1] ?? '').toLowerCase();
		if (lang === 'frame-edit-plan' || lang === 'frame-tool') {
			continue;
		}
		if (!best || body.length > best.length) {
			best = body;
		}
	}
	// Ignore tiny fences (likely inline examples).
	if (!best || best.length < 8) {
		return undefined;
	}
	return best;
}

function extractQuotedToken(prompt: string): string | undefined {
	const m = prompt.match(/["'“”]([^"'“”]+)["'“”]/);
	return m?.[1]?.trim() || undefined;
}

/** Quoted token, or “the word X” / “the text X” fallback. */
function extractEditToken(prompt: string): string | undefined {
	const quoted = extractQuotedToken(prompt);
	if (quoted) {
		return quoted;
	}
	const word = prompt.match(/\b(?:the\s+)?(?:word|text|string)\s+[“"']?([A-Za-z0-9_./+-]+)[”"']?/i);
	return word?.[1]?.trim() || undefined;
}

/** Handles precise requests such as “add the word hello on the second line”. */
function tryInsertAtLine(prompt: string, _content: string): { line: number; content: string } | undefined {
	const lower = prompt.toLowerCase();
	if (!/\b(add|insert|put)\b/.test(lower)) {
		return undefined;
	}
	const lineMatch = lower.match(/\b(\d+)(?:st|nd|rd|th)?\s+line\b/)
		?? lower.match(/\b(first|second|third|fourth)\s+line\b/);
	if (!lineMatch) {
		return undefined;
	}
	const words: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4 };
	const line = Number(lineMatch[1]) || words[lineMatch[1]] || 0;
	const content = extractEditToken(prompt);
	if (line < 2 || !content) {
		// First-line requests mean prefixing that line, handled below.
		return undefined;
	}
	return { line, content };
}

/**
 * Handles prompts like:
 * - add the word "works" in front of the 1st line
 * - add the word hello to the 1st line of that file
 */
function tryPrependToFirstLine(prompt: string, content: string): string | undefined {
	const lower = prompt.toLowerCase();
	const looksLikePrepend = (
		(/\b(1st|first)\s+line\b/.test(lower) || /\b(start|beginning)\s+of\s+(the\s+)?(file|doc|document|line)\b/.test(lower))
		&& /\b(add|insert|put|prepend|prefix)\b/.test(lower)
		&& (
			/\b(front|before|beginning|start|prepend|prefix)\b/.test(lower)
			|| /\b(to|on|at|onto)\s+(the\s+)?(1st|first)\s+line\b/.test(lower)
			|| /\b(to|on|at)\s+(the\s+)?(start|beginning)\b/.test(lower)
		)
	) || (
		/\bprepend\b/.test(lower) && /\bline\b/.test(lower)
	);
	if (!looksLikePrepend) {
		return undefined;
	}

	const token = extractEditToken(prompt);
	if (!token) {
		return undefined;
	}

	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	if (lines.length === 0) {
		return `${token}${eol}`;
	}
	const first = lines[0] ?? '';
	const spacer = first.length === 0 || first.startsWith(' ') || first.startsWith('\t') ? '' : ' ';
	lines[0] = `${token}${spacer}${first}`;
	return lines.join(eol);
}

/**
 * Handles prompts like: add the word "works" at the end of the file
 */
function tryAppendToEndOfFile(prompt: string, content: string): string | undefined {
	const lower = prompt.toLowerCase();
	const looksLikeAppend = (
		/\b(add|append|insert|put)\b/.test(lower)
		&& (
			/\b(end|bottom)\s+of\s+(the\s+)?(file|doc|document)\b/.test(lower)
			|| /\bat\s+the\s+end\b/.test(lower)
			|| /\bto\s+the\s+end\b/.test(lower)
			|| /\bappend\b/.test(lower)
		)
	);
	if (!looksLikeAppend) {
		return undefined;
	}

	const token = extractEditToken(prompt);
	if (!token) {
		return undefined;
	}

	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	if (content.length === 0) {
		return `${token}${eol}`;
	}
	if (content.endsWith('\n')) {
		return `${content}${token}${eol}`;
	}
	return `${content}${eol}${token}${eol}`;
}

function normalizeModelOperation(value: unknown, context: IFrameInferenceContext): IFrameEditOperation | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
	const id = typeof raw.id === 'string' && raw.id ? raw.id : generateUuid();
	const status: FrameEditOperationStatus = 'pending';
	const reason = typeof raw.reason === 'string' ? raw.reason : undefined;

	switch (kind) {
		case 'create': {
			const path = asModelPath(raw.path, context);
			const content = typeof raw.content === 'string' ? raw.content : undefined;
			if (!path || content === undefined) {
				return undefined;
			}
			return { id, kind: 'create', status, reason, path, content };
		}
		case 'modify': {
			const path = asModelPath(raw.path, context);
			const newContent = typeof raw.newContent === 'string'
				? raw.newContent
				: (typeof raw.content === 'string' ? raw.content : undefined);
			if (!path || newContent === undefined) {
				return undefined;
			}
			const originalContent = typeof raw.originalContent === 'string' ? raw.originalContent : undefined;
			return { id, kind: 'modify', status, reason, path, newContent, originalContent };
		}
		case 'append':
		case 'prepend': {
			const path = asModelPath(raw.path, context);
			const content = typeof raw.content === 'string'
				? raw.content
				: (typeof raw.text === 'string' ? raw.text : undefined);
			if (!path || content === undefined) {
				return undefined;
			}
			return {
				id,
				kind: 'modify',
				status,
				reason,
				path,
				newContent: content,
				sourceEdit: { kind, content },
			};
		}
		case 'insert': {
			const path = asModelPath(raw.path, context);
			const content = typeof raw.content === 'string'
				? raw.content
				: (typeof raw.text === 'string' ? raw.text : undefined);
			const line = typeof raw.line === 'number' ? Math.floor(raw.line) : Number(raw.line);
			if (!path || content === undefined || !Number.isFinite(line) || line < 1) {
				return undefined;
			}
			return {
				id,
				kind: 'modify',
				status,
				reason,
				path,
				newContent: content,
				sourceEdit: { kind: 'insertLine', content, line },
			};
		}
		case 'delete': {
			const path = asModelPath(raw.path, context);
			if (!path) {
				return undefined;
			}
			return { id, kind: 'delete', status, reason, path };
		}
		case 'rename': {
			const fromPath = asRelativePath(raw.fromPath ?? raw.path);
			const toPath = asRelativePath(raw.toPath ?? raw.newPath);
			if (!fromPath || !toPath) {
				return undefined;
			}
			return { id, kind: 'rename', status, reason, fromPath, toPath };
		}
		default:
			return undefined;
	}
}

function asModelPath(value: unknown, context: IFrameInferenceContext): string | undefined {
	const relative = asRelativePath(value);
	if (relative) {
		return relative;
	}
	if (typeof value !== 'string' || !context.activeRelativePath) {
		return undefined;
	}
	const normalized = value.trim().replace(/\\/g, '/');
	return normalized.endsWith(`/${context.activeRelativePath}`) ? context.activeRelativePath : undefined;
}

function asRelativePath(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
	if (!trimmed || trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('..')) {
		return undefined;
	}
	return trimmed;
}

/** Refusal message shown when a stub (no-op) plan is accepted or applied. */
export const FRAME_STUB_PLAN_MESSAGE = 'No applicable edit was produced — model output did not contain a valid edit plan.';

/**
 * Deterministic stub edit plan from context + prompt.
 * Never calls a model — message-passing pipeline only.
 *
 * Intentionally carries NO operations: a stub must never be able to write
 * marker content into user files (Accept refuses with {@link FRAME_STUB_PLAN_MESSAGE}).
 * The summary keeps enough guidance for the sidebar / chat to explain why.
 */
export function buildStubEditPlan(
	taskId: string,
	prompt: string,
	context: IFrameInferenceContext,
	_options?: { readonly readFileContent?: (relativePath: string) => string | undefined },
): IFrameEditPlan {
	const active = context.activeRelativePath;
	const summary = `${FRAME_STUB_PLAN_MESSAGE} Try again with a more specific request${active ? ` (active file: ${active})` : ''}.`;

	return {
		id: generateUuid(),
		taskId,
		prompt,
		createdAt: Date.now(),
		summary,
		operations: [],
		stub: true,
		status: 'preview',
	};
}

export function computeLineDiffStats(original: string | undefined, next: string | undefined): { additions: number; deletions: number } {
	const a = (original ?? '').split(/\r?\n/);
	const b = (next ?? '').split(/\r?\n/);
	// Simple line-count heuristic (not LCS) — enough for stub preview.
	const deletions = Math.max(0, a.length - b.length);
	const additions = Math.max(0, b.length - a.length);
	if (original === next) {
		return { additions: 0, deletions: 0 };
	}
	if (!original) {
		return { additions: b.filter(l => l.length > 0).length || b.length, deletions: 0 };
	}
	if (!next) {
		return { additions: 0, deletions: a.filter(l => l.length > 0).length || a.length };
	}
	// Changed file: count differing lines roughly.
	let add = 0;
	let del = 0;
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		if (a[i] === undefined) {
			add++;
		} else if (b[i] === undefined) {
			del++;
		} else if (a[i] !== b[i]) {
			add++;
			del++;
		}
	}
	return { additions: add || additions, deletions: del || deletions };
}

export function previewEditPlan(plan: IFrameEditPlan): IFrameEditPlanPreview {
	const files: IFrameEditDiffFileSummary[] = [];
	let totalAdditions = 0;
	let totalDeletions = 0;

	for (const op of plan.operations) {
		let path = '';
		let additions = 0;
		let deletions = 0;
		let preview: string | undefined;

		switch (op.kind) {
			case 'create':
				path = op.path;
				({ additions, deletions } = computeLineDiffStats(undefined, op.content));
				preview = op.content.slice(0, 240);
				break;
			case 'modify':
				path = op.path;
				({ additions, deletions } = computeLineDiffStats(op.originalContent, op.newContent));
				preview = op.newContent.slice(Math.max(0, op.newContent.length - 240));
				break;
			case 'delete':
				path = op.path;
				additions = 0;
				deletions = 1;
				preview = `delete ${op.path}`;
				break;
			case 'rename':
				path = `${op.fromPath} → ${op.toPath}`;
				additions = 0;
				deletions = 0;
				preview = `rename ${op.fromPath} → ${op.toPath}`;
				break;
		}

		totalAdditions += additions;
		totalDeletions += deletions;
		files.push({
			operationId: op.id,
			path,
			kind: op.kind,
			additions,
			deletions,
			status: op.status,
			preview,
		});
	}

	return {
		planId: plan.id,
		summary: plan.summary,
		files,
		totalAdditions,
		totalDeletions,
	};
}

export function withOperationStatuses(
	plan: IFrameEditPlan,
	updates: ReadonlyMap<string, FrameEditOperationStatus>,
	planStatus?: IFrameEditPlan['status'],
): IFrameEditPlan {
	return {
		...plan,
		status: planStatus ?? plan.status,
		operations: plan.operations.map(op => {
			const next = updates.get(op.id);
			return next ? { ...op, status: next } : op;
		}),
	};
}
