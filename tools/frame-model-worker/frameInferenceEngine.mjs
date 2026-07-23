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
 * Detect a complete ```frame-tool fence whose body is NOT valid JSON.
 * extractFrameToolCall returns null for these, which used to make the broken
 * fence silently become the final answer. Returns the parse error so the
 * caller can run one corrective round.
 *
 * @param {string} text
 * @returns {{ message: string, raw: string } | null}
 */
export function detectFrameToolParseError(text) {
	const match = FRAME_TOOL_FENCE_RE.exec(text);
	if (!match) {
		return null;
	}
	try {
		JSON.parse(match[1].trim());
		return null;
	} catch (err) {
		return {
			message: err instanceof Error ? err.message : String(err),
			raw: match[0],
		};
	}
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
 * @param {string} [originalRequest]
 * @returns {string}
 */
export function formatToolResultPrompt(tool, result, originalRequest = '') {
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
		`The IDE completed ${tool}. This is the authoritative result:`,
		body,
		'',
		originalRequest ? `Original user request:\n${originalRequest}` : '',
		'Use the result above now. Do not request the same tool with the same arguments again.',
		'If the user requested a file change, produce the final ```frame-edit-plan``` now. Otherwise answer normally.',
	].filter(Boolean).join('\n');
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
	const maxTokens = options.maxTokens ?? 4096;
	const originalRequest = String(inferenceContext?.request ?? inferenceContext?.userMessage ?? '').trim();

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
	let invalidToolJsonRetried = false;
	const completedToolCalls = new Set();
	/** @type {Map<string, string>} toolKey → error message of the failed attempt */
	const failedToolCalls = new Map();

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

			// Keep intermediate "I need to read..." chatter out of the answer.
			// Only commit visible text from the round that actually finishes.
			const roundVisibleParts = [];
			const round = await promptOnce(session, nextPrompt, {
				// Tool-capable rounds are buffered because we cannot know whether
				// their prose is a final answer until generation completes.
				onToken: enableTools ? () => {} : options.onToken,
				isCancelled: options.isCancelled,
				timeoutMs: remainingMs,
				maxTokens,
				visibleParts: roundVisibleParts,
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
				// A closed ```frame-tool fence with broken JSON parses to no toolCall;
				// give the model one corrective round instead of shipping the broken fence.
				const parseError = enableTools ? detectFrameToolParseError(round.rawText) : null;
				if (parseError && !invalidToolJsonRetried) {
					invalidToolJsonRetried = true;
					nextPrompt = [
						`Your frame-tool block was invalid JSON: ${parseError.message}.`,
						'Emit exactly one valid ```frame-tool block ({"name":"<tool>","arguments":{...}}) or answer without tools.',
					].join('\n');
					continue;
				}
				visibleParts.push(...roundVisibleParts);
				let text = visibleParts.join('') || stripFrameToolFences(round.rawText);
				if (parseError) {
					// Retry already used — give up gracefully and hide the broken fence.
					text = stripFrameToolFences(text);
				}
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
			const toolKey = `${toolCall.name}:${stableStringify(toolCall.args)}`;
			if (completedToolCalls.has(toolKey)) {
				// Small local models can loop on an identical successful read.
				// Force a final answer instead of executing/displaying it again.
				forcedFinal = true;
				enableTools = false;
				nextPrompt = [
					`You already received a successful ${toolCall.name} result for these arguments:`,
					stableStringify(toolCall.args),
					'Do not call tools again. Use the result already in this conversation and answer the original user request now.',
					'For a file change, emit one complete ```frame-edit-plan``` and no progress/status chatter.',
				].join('\n');
				continue;
			}
			if (failedToolCalls.has(toolKey)) {
				// Identical failing call — do not re-execute; it will fail the same way.
				// This corrective prompt consumed a round (toolRounds++ above), so a
				// stubborn model still terminates at maxToolRounds.
				nextPrompt = [
					`You already called ${toolCall.name} with these arguments and it failed:`,
					stableStringify(toolCall.args),
					`Error: ${failedToolCalls.get(toolKey)}`,
					'Repeating the identical call will fail the same way. Try a different tool or different arguments, or answer the user now without tools.',
				].join('\n');
				continue;
			}
			const toolResult = await options.requestTool(toolCall.name, toolCall.args);
			if (options.isCancelled?.()) {
				return {
					text: visibleParts.join(''),
					status: 'cancelled',
					cancelled: true,
					toolRounds,
				};
			}
			if (toolResult.success) {
				completedToolCalls.add(toolKey);
			} else {
				failedToolCalls.set(toolKey, toolResult.error ?? 'unknown error');
			}
			nextPrompt = formatToolResultPrompt(toolCall.name, toolResult, originalRequest);
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

function stableStringify(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return JSON.stringify(value);
	}
	const sorted = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = value[key];
	}
	return JSON.stringify(sorted);
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
