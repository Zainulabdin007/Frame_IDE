/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Maps IFrameInferenceContext (serialized over IPC) into prompts for node-llama-cpp.
 * Deterministic truncation + light token optimizer — no cloud, no inference.
 */

/** Budgets tuned for 7B Q4_K_M (~local laptop latency). */
const DEFAULT_BUDGET = {
	systemChars: 6_500,
	userChars: 5_500,
	ragChunkChars: 700,
	maxRagChunks: 4,
	maxMemories: 3,
	maxPreferences: 3,
	maxSymbols: 8,
	maxHistoryTurns: 4,
	activeFileChars: 3_500,
	selectionChars: 2_000,
};

/** Tools advertised to the model (keeps the system prompt small). */
export const FRAME_WORKER_TOOLS = Object.freeze([
	'readFile',
	'listFiles',
	'searchWorkspace',
	'grepWorkspace',
	'findSymbol',
	'findReferences',
	'gitStatus',
	'gitDiff',
]);

/** @deprecated Use FRAME_WORKER_TOOLS — kept for older call sites. */
export const FRAME_PRIORITY_TOOLS = FRAME_WORKER_TOOLS;

/** @type {Readonly<Record<string, string>>} */
const TOOL_ARG_HINTS = Object.freeze({
	readFile: '{ "path": "<workspace-relative path>", "maxBytes"?: number }',
	searchWorkspace: '{ "query": "<string>", "limit"?: number }',
	grepWorkspace: '{ "pattern": "<substring>", "limit"?: number }',
	listFiles: '{ "path"?: "<dir>", "limit"?: number }',
	gitStatus: '{}',
	gitDiff: '{ "path"?: "<path>" }',
	findSymbol: '{ "name": "<symbol>", "limit"?: number }',
	findReferences: '{ "name": "<symbol>", "limit"?: number }',
});

/**
 * System-prompt appendix that teaches the model the ```frame-tool convention.
 * @param {readonly string[]} [toolNames]
 * @returns {string}
 */
export function buildToolCallingInstructions(toolNames = FRAME_WORKER_TOOLS) {
	const names = toolNames.length ? toolNames : FRAME_WORKER_TOOLS;
	const lines = names.map(name => {
		const hint = TOOL_ARG_HINTS[name] ?? '{ }';
		return `- ${name} — arguments: ${hint}`;
	});
	return [
		'Tool calling:',
		'When you need workspace information, emit exactly one tool call as a fenced block on its own:',
		'```frame-tool',
		'{"name":"readFile","arguments":{"path":"relative/path"}}',
		'```',
		'Available tools:',
		...lines,
		'Rules:',
		'- Emit at most one ```frame-tool block per reply.',
		'- Read before editing. Prefer readFile / grepWorkspace / findSymbol.',
		'- Do not invent tool results; wait for the IDE to return them.',
		'- If you do not need tools, answer normally with no frame-tool block.',
	].join('\n');
}

/**
 * Teach the model how to propose workspace edits (applied via chat Apply UI).
 * @returns {string}
 */
export function buildEditPlanInstructions() {
	return [
		'File edits:',
		'When the user asks you to create/change/delete files, read them first if needed, then end with ONE fenced plan:',
		'```frame-edit-plan',
		'{"summary":"short description","operations":[{"kind":"modify","path":"src/file.ts","newContent":"...full file contents...","reason":"why"}]}',
		'```',
		'Operation kinds: create {path,content}, modify {path,newContent}, delete {path}, rename {fromPath,toPath}.',
		'For modify/create, put the FULL file contents in content/newContent (not a patch).',
		'Keep prose brief; the plan is what the IDE applies after the user clicks Apply.',
	].join('\n');
}

/**
 * Rank RAG-like chunks by simple lexical overlap with the user request.
 * @param {string} request
 * @param {any[]} chunks
 * @param {number} limit
 */
export function optimizeChunks(request, chunks, limit) {
	const terms = tokenize(request);
	const scored = chunks.map((c, index) => {
		const hay = `${chunkPath(c)} ${c.symbolName ?? ''} ${c.text ?? c.content ?? ''}`.toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (hay.includes(t)) {
				score += 1;
			}
		}
		// Prefer chunks that already carry a retrieval score.
		if (typeof c.score === 'number') {
			score += c.score;
		}
		return { c, score, index };
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, limit).map(s => s.c);
}

/**
 * @param {any} context
 * @param {{
 *   readonly budget?: Partial<typeof DEFAULT_BUDGET>,
 *   readonly enableTools?: boolean,
 *   readonly tools?: readonly string[],
 * }} [options]
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function mapInferenceContext(context, options = {}) {
	const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
	const ctx = context && typeof context === 'object' ? context : {};
	const enableTools = options.enableTools !== false;
	const request = String(ctx.request ?? ctx.userMessage ?? '').trim() || '(empty request)';

	const preferences = optimizeMemories(
		asArray(ctx.preferences ?? ctx.memory?.preferences)
			.filter(isMemoryLike)
			.filter(m => isPreferenceKind(m) || hasPreferenceTag(m)),
		request,
		budget.maxPreferences,
	);
	const projectMemories = optimizeMemories(
		asArray(ctx.memories ?? ctx.memory?.project ?? ctx.memory)
			.filter(isMemoryLike)
			.filter(m => !isPreferenceKind(m) && !hasPreferenceTag(m)),
		request,
		budget.maxMemories,
	);
	const ragChunks = optimizeChunks(
		request,
		[
			...asArray(ctx.relatedChunks ?? ctx.rag?.documents ?? ctx.rag),
			...asArray(ctx.documentationChunks),
		],
		budget.maxRagChunks,
	);
	const adapters = asArray(ctx.adapters?.active ?? ctx.activeAdapters).slice(0, 3);
	const symbols = asArray(ctx.relatedSymbols ?? ctx.knowledge?.symbols)
		.slice(0, budget.maxSymbols);
	const history = asArray(ctx.messages).slice(-budget.maxHistoryTurns);

	const systemParts = [
		'You are Frame, a fast local coding assistant for this workspace.',
		'Be concise. Prefer tools + edit plans over long explanations.',
		'',
		'Active preferences:',
		formatMemories(preferences) || '(none)',
		'',
		'Project notes:',
		formatMemories(projectMemories) || '(none)',
		'',
		'Symbols:',
		formatSymbols(symbols) || '(none)',
		'',
		'Relevant code:',
		formatRag(ragChunks, budget.ragChunkChars) || '(none)',
	];

	if (adapters.length) {
		systemParts.push('', 'Active adapters:', formatAdapters(adapters));
	}

	if (enableTools) {
		systemParts.push('', buildToolCallingInstructions(options.tools ?? FRAME_WORKER_TOOLS));
	}
	systemParts.push('', buildEditPlanInstructions());

	if (typeof ctx.systemPrompt === 'string' && ctx.systemPrompt.trim()) {
		systemParts.push('', 'Notes:', truncate(ctx.systemPrompt.trim(), 800));
	}

	const userParts = [];
	if (history.length) {
		userParts.push('Recent turns:');
		for (const turn of history) {
			const role = String(turn.role ?? 'user');
			const content = truncate(String(turn.content ?? ''), 800);
			if (content) {
				userParts.push(`[${role}] ${content}`);
			}
		}
		userParts.push('');
	}

	if (ctx.activeRelativePath) {
		userParts.push(`Active file: ${ctx.activeRelativePath}`);
	}
	if (ctx.activeFileContent) {
		userParts.push('Active file contents:', '```', truncate(String(ctx.activeFileContent), budget.activeFileChars), '```', '');
	}
	if (ctx.selectedCode) {
		userParts.push('Selected code:', truncate(String(ctx.selectedCode), budget.selectionChars), '');
	}

	userParts.push('User request:', request);

	return {
		systemPrompt: truncate(systemParts.join('\n'), budget.systemChars),
		userPrompt: truncate(userParts.join('\n'), budget.userChars),
	};
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function tokenize(text) {
	return String(text || '')
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter(t => t.length > 2)
		.slice(0, 40);
}

function optimizeMemories(list, request, limit) {
	const terms = tokenize(request);
	const scored = list.map((m, index) => {
		const hay = memoryText(m).toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (hay.includes(t)) {
				score += 1;
			}
		}
		return { m, score, index };
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, limit).map(s => s.m);
}

/** IDE sends IFrameMemoryEntry as { key, value }; also accept content/text/summary. */
function isMemoryLike(m) {
	if (!m || typeof m !== 'object') {
		return false;
	}
	return typeof m.content === 'string'
		|| typeof m.text === 'string'
		|| typeof m.summary === 'string'
		|| typeof m.value === 'string'
		|| typeof m.preference === 'string';
}

function memoryText(m) {
	return String(m.content ?? m.text ?? m.summary ?? m.value ?? m.preference ?? '').trim();
}

function isPreferenceKind(m) {
	const kind = String(m.kind ?? m.scope ?? m.type ?? '').toLowerCase();
	return kind.includes('prefer') || kind === 'user';
}

function hasPreferenceTag(m) {
	const tags = asArray(m.tags).map(t => String(t).toLowerCase());
	return tags.includes('preference') || tags.includes('active');
}

function formatMemories(list) {
	return list.map((m, i) => {
		const text = memoryText(m);
		if (!text) {
			return '';
		}
		const title = m.title ? `${m.title}: ` : (m.key && m.key !== 'preference' ? `${m.key}: ` : '');
		return `${i + 1}. ${title}${truncate(text, 400)}`;
	}).filter(Boolean).join('\n');
}

function formatAdapters(list) {
	return list.map((a, i) => {
		const name = a.displayName ?? a.name ?? a.id ?? 'adapter';
		const edition = a.edition ? ` [${a.edition}]` : '';
		const desc = a.description ? ` — ${truncate(String(a.description), 160)}` : '';
		return `${i + 1}. ${name}${edition}${desc}`;
	}).join('\n');
}

function formatSymbols(list) {
	return list.map((s, i) => {
		const kind = s.kind ?? 'symbol';
		const name = s.name ?? '?';
		const path = s.path ? ` @ ${s.path}` : '';
		return `${i + 1}. (${kind}) ${name}${path}`;
	}).join('\n');
}

function chunkPath(c) {
	if (typeof c.relativePath === 'string' && c.relativePath) {
		return c.relativePath;
	}
	if (typeof c.path === 'string' && c.path) {
		return c.path;
	}
	if (typeof c.uri === 'string' && c.uri) {
		return c.uri;
	}
	if (c.uri && typeof c.uri === 'object') {
		if (typeof c.uri.path === 'string') {
			return c.uri.path;
		}
		if (typeof c.uri.fsPath === 'string') {
			return c.uri.fsPath;
		}
	}
	return 'chunk';
}

function formatRag(chunks, perChunk) {
	return chunks.map((c, i) => {
		const path = chunkPath(c);
		const symbol = c.symbolName ? ` · ${c.symbolName}` : '';
		const text = truncate(String(c.text ?? c.content ?? ''), perChunk);
		return `--- ${i + 1}. ${path}${symbol} ---\n${text}`;
	}).join('\n\n');
}

function truncate(text, max) {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, Math.max(0, max - 16))}\n…[truncated]`;
}
