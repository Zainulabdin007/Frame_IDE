/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Privacy guarantees for Frame Intelligence.
 * Network non-goals are architectural (no cloud clients in this stack).
 * Local persistence under `.frame/` is intentional and gitignored — see notes below.
 */

export const FRAME_PRIVACY_GUARANTEES = Object.freeze({
	/** All intelligence state stays on the local machine. */
	localOnly: true,
	/** No remote model or SaaS API calls from this subsystem. */
	noCloudInference: true,
	/** No network telemetry of prompts/code from Frame AI (disk logs are local-only + truncated). */
	noPromptTelemetry: true,
	/** Workspace indexing never leaves the device. */
	localRagOnly: true,
	/** Training / LoRA artifacts are written only under workspace `.frame/adapters/`. */
	localAdaptersOnly: true,
	/** Account sign-in is not required to use Frame AI. */
	noAccountRequired: true,
} as const);

export type FramePrivacyGuarantees = typeof FRAME_PRIVACY_GUARANTEES;

/**
 * Honest caveats — not marketing claims.
 * Frame AI does not phone home; it does persist truncated chat/tool diagnostics under `.frame/`.
 */
export const FRAME_PRIVACY_LOCAL_PERSISTENCE = Object.freeze({
	/** Chat turns (truncated) under `.frame/memory/chat/`. */
	chatTranscripts: true,
	/** Generation / tool diagnostics under `.frame/logs/` (redacted/truncated). */
	localLogs: true,
	/** Entire `.frame/` tree is covered by `.frame/.gitignore` (`*`). */
	gitignored: true,
} as const);

/**
 * Explicit non-goals for this milestone and the intelligence scaffold.
 */
export const FRAME_INTELLIGENCE_NON_GOALS = Object.freeze([
	'No model weights bundled or auto-downloaded — user-provided paths only',
	'No OpenAI / Anthropic / GitHub Copilot / cloud inference clients in frameAI',
	'No modifications to Monaco / editor core for model hooks',
	'No network calls from orchestrator, context, runtime, memory, RAG, adapters, or training',
	'Adapter weightFile paths are basename-only under .frame/adapters/<id>/ (no workspace escape)',
	'UNVERIFIED imported packages require allowUnverifiedModels in runtime.json (INVALID always blocked)',
] as const);
