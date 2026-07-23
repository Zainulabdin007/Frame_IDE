/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Streaming inference via node-llama-cpp.
 * Emits tokens through the existing worker IPC protocol (caller sends streamToken).
 * Parses ```frame-tool blocks and runs a toolRequest ↔ toolResult loop.
 */

import { LlamaChatSession } from 'node-llama-cpp';
import { FRAME_WORKER_TOOLS, mapInferenceContext } from './frameContextMapper.mjs';

/** Matches a complete ```frame-tool ... ``` fence. */
const FRAME_TOOL_FENCE_RE = /```frame-tool\s*\r?\n([\s\S]*?)```/;

/**
 * @typedef {object} FrameToolCall
 * @property {string} name
 * @property {Record<string, unknown>} args
 * @property {string} raw
 * @property {number} index
 */

/**
 * @typedef {object} FrameInferenceEngineOptions
 * @property {(token: string) => void} onToken
 * @property {() => boolean} [isCancelled]
 * @property {number} [timeoutMs]
 * @property {number} [maxTokens]
 * @property {string} [systemPromptOverride]
 * @property {boolean} [enableTools]
 * @property {readonly string[]} [tools]
 * @property {number} [maxToolRounds]
 * @property {(tool: string, args: Readonly<Record<string, unknown>>) => Promise<{
 *   success: boolean,
 *   data?: unknown,
 *   error?: string,
 * }>} [requestTool]
 */

/**
 * Parse a complete ```frame-tool fence from model text.
 * @param {string} text
 * @param {readonly string[]} [allowedTools]
 * @returns {FrameToolCall | null}
 */
export function extractFrameToolCall(text, allowedTools = FRAME_WORKER_TOOLS) {
	const match = FRAME_TOOL_FENCE_RE.exec(text);
	if (!match) {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(match[1].trim());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}
	const name = typeof parsed.name === 'string'
		? parsed.name
		: (typeof parsed.tool === 'string' ? parsed.tool : '');
	if (!name || !allowedTools.includes(name)) {
		return null;
	}
	const rawArgs = parsed.arguments ?? parsed.args ?? {};
	const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
		? /** @type {Record<string, unknown>} */ (rawArgs)
		: {};
	return {
		name,
		args,
		raw: match[0],
		index: match.index ?? 0,
	};
}

/**
 * Strip ```frame-tool fences from text (for cleaner final / visible output).
 * @param {string} text
 * @returns {string}
 */
export function stripFrameToolFences(text) {
	return text
		.replace(/```frame-tool\s*\r?\n[\s\S]*?```/g, '')
		.replace(/```frame-tool\s*\r?\n[\s\S]*$/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Format a tool result for the next prompt turn.
 * @param {string} tool
 * @param {{ success: boolean, data?: unknown, error?: string }} result
 * @returns {string}
 */
export function formatToolResultPrompt(tool, result) {
	const payload = result.success
		? { success: true, data: result.data ?? null }
		: { success: false, error: result.error ?? 'unknown error' };
	let body;
	try {
		body = JSON.stringify(payload, null, 2);
	} catch {
		body = String(result.error ?? result.data ?? '');
	}
	if (body.length > 12_000) {
		body = `${body.slice(0, 12_000)}\n…[truncated]`;
	}
	return [
		`Tool result for ${tool}:`,
		body,
		'',
		'Continue answering the user. Emit another ```frame-tool block only if you still need a tool; otherwise give your final answer with no frame-tool block.',
	].join('\n');
}

/**
 * Run generate against a loaded model/context, with optional tool round-trips.
 *
 * @param {{ session?: any, model?: any, context: any }} loaded
 * @param {any} inferenceContext
 * @param {FrameInferenceEngineOptions} options
 * @returns {Promise<{ text: string, status: string, cancelled: boolean, toolRounds: number }>}
 */
export async function runInference(loaded, inferenceContext, options) {
	if (!loaded?.context || !loaded?.sequence) {
		throw new Error('Model runtime not loaded.');
	}

	const enableToolsPreferred = options.enableTools !== false && typeof options.requestTool === 'function';
	let enableTools = enableToolsPreferred;
	const allowedTools = options.tools?.length ? options.tools : FRAME_WORKER_TOOLS;
	const maxToolRounds = options.maxToolRounds ?? 4;
	const { systemPrompt, userPrompt } = mapInferenceContext(inferenceContext, {
		enableTools: enableToolsPreferred,
		tools: allowedTools,
	});
	const system = options.systemPromptOverride?.trim() || systemPrompt;
	const timeoutMs = options.timeoutMs ?? 180_000;
	const maxTokens = options.maxTokens ?? 1024;

	// Dispose prior chat session but KEEP the context sequence for the next turn.
	const prev = loaded.session;
	loaded.session = null;
	try {
		prev?.dispose?.({ disposeSequence: false });
	} catch {
		try {
			prev?.dispose?.();
		} catch {
			// ignore
		}
	}

	// Per-request session reuses the durable sequence allocated at load time.
	const session = new LlamaChatSession({
		contextSequence: loaded.sequence,
		systemPrompt: system,
	});
	loaded.session = session;

	const visibleParts = [];
	const deadline = Date.now() + timeoutMs;
	let toolRounds = 0;
	let nextPrompt = userPrompt;
	let forcedFinal = false;

	try {
		while (true) {
			if (options.isCancelled?.()) {
				return {
					text: visibleParts.join(''),
					status: 'cancelled',
					cancelled: true,
					toolRounds,
				};
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new Error(`Generation timeout after ${timeoutMs}ms`);
			}

			const round = await promptOnce(session, nextPrompt, {
				onToken: options.onToken,
				isCancelled: options.isCancelled,
				timeoutMs: remainingMs,
				maxTokens,
				visibleParts,
				allowedTools,
				enableTools,
			});

			if (round.cancelled) {
				return {
					text: visibleParts.join(''),
					status: 'cancelled',
					cancelled: true,
					toolRounds,
				};
			}

			if (!enableTools || !round.toolCall) {
				const text = visibleParts.join('') || stripFrameToolFences(round.rawText);
				return {
					text,
					status: 'ok',
					cancelled: false,
					toolRounds,
				};
			}

			if (toolRounds >= maxToolRounds) {
				if (forcedFinal) {
					const text = visibleParts.join('') || stripFrameToolFences(round.rawText) || 'Tool call limit reached.';
					return {
						text,
						status: 'ok',
						cancelled: false,
						toolRounds,
					};
				}
				forcedFinal = true;
				enableTools = false;
				nextPrompt = 'Tool call limit reached. Give your final answer now with no ```frame-tool block.';
				continue;
			}

			toolRounds++;
			const toolCall = round.toolCall;
			const toolResult = await options.requestTool(toolCall.name, toolCall.args);
			if (options.isCancelled?.()) {
				return {
					text: visibleParts.join(''),
					status: 'cancelled',
					cancelled: true,
					toolRounds,
				};
			}
			nextPrompt = formatToolResultPrompt(toolCall.name, toolResult);
		}
	} finally {
		try {
			// Keep the durable sequence alive for the next generate turn.
			session.dispose?.({ disposeSequence: false });
		} catch {
			try {
				session.dispose?.();
			} catch {
				// ignore
			}
		}
		if (loaded.session === session) {
			loaded.session = null;
		}
	}
}

/**
 * Single session.prompt with streaming + mid-generation tool-fence detection.
 *
 * @param {any} session
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<{ rawText: string, toolCall: FrameToolCall | null, cancelled: boolean }>}
 */
async function promptOnce(session, prompt, opts) {
	const parts = [];
	/** @type {FrameToolCall | null} */
	let toolCall = null;
	let abortedForTool = false;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(new Error('Generation timeout')), opts.timeoutMs);

	const onAbortCheck = setInterval(() => {
		if (opts.isCancelled?.()) {
			abort.abort(new Error('cancelled'));
		}
	}, 50);

	/** How much of `parts` has already been forwarded via onToken (excludes tool fences). */
	let emittedUpTo = 0;

	const flushVisible = () => {
		const full = parts.join('');
		const fenceStart = full.search(/```frame-tool\b/);
		const closed = fenceStart >= 0 && /```frame-tool\s*\r?\n[\s\S]*?```/.test(full.slice(fenceStart));
		// Hold back an open fence, but don't stall forever on incomplete fences.
		const holdOpen = fenceStart >= 0 && !closed && (full.length - fenceStart) < 2_500;
		const visibleEnd = holdOpen ? fenceStart : full.length;
		if (visibleEnd > emittedUpTo) {
			const token = full.slice(emittedUpTo, visibleEnd);
			if (token) {
				opts.visibleParts.push(token);
				opts.onToken(token);
			}
			emittedUpTo = visibleEnd;
		}
	};

	try {
		const text = await session.prompt(prompt, {
			signal: abort.signal,
			stopOnAbortSignal: true,
			maxTokens: opts.maxTokens,
			onTextChunk: (chunk) => {
				if (opts.isCancelled?.()) {
					abort.abort(new Error('cancelled'));
					return;
				}
				const token = String(chunk ?? '');
				if (!token) {
					return;
				}
				parts.push(token);
				if (opts.enableTools) {
					const full = parts.join('');
					const call = extractFrameToolCall(full, opts.allowedTools);
					flushVisible();
					if (call) {
						toolCall = call;
						abortedForTool = true;
						abort.abort(new Error('tool_call'));
					}
				} else {
					opts.visibleParts.push(token);
					opts.onToken(token);
				}
			},
		});
		const rawText = parts.join('') || String(text ?? '');
		if (opts.enableTools && !toolCall) {
			toolCall = extractFrameToolCall(rawText, opts.allowedTools);
		}
		flushVisible();
		return {
			rawText,
			toolCall,
			cancelled: !!opts.isCancelled?.(),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const reason = abort.signal.reason;
		const reasonMsg = reason instanceof Error ? reason.message : String(reason ?? '');
		const toolAbort = abortedForTool || /tool_call/i.test(msg) || /tool_call/i.test(reasonMsg);
		const cancelled = !!opts.isCancelled?.()
			|| ((/cancel/i.test(msg) || /cancel/i.test(reasonMsg)) && !toolAbort);
		const rawText = parts.join('');
		if (toolAbort || toolCall) {
			if (!toolCall) {
				toolCall = extractFrameToolCall(rawText, opts.allowedTools);
			}
			flushVisible();
			return { rawText, toolCall, cancelled: false };
		}
		if (cancelled) {
			flushVisible();
			return { rawText, toolCall: null, cancelled: true };
		}
		if (/timeout/i.test(msg) || /timeout/i.test(reasonMsg)) {
			throw new Error(`Generation timeout after ${opts.timeoutMs}ms`);
		}
		throw err instanceof Error ? err : new Error(String(err));
	} finally {
		clearTimeout(timer);
		clearInterval(onAbortCheck);
	}
}
