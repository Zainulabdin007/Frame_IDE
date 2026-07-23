/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared Frame AI constants and identifiers.
 * No model inference lives here — contracts only.
 */

/** Contribution / feature id for logging and telemetry (local only). */
export const FRAME_AI_FEATURE_ID = 'frameAI';

/** Storage namespace for Frame intelligence state (local disk only). */
export const FRAME_AI_STORAGE_NAMESPACE = 'frame.intelligence';

/**
 * Lifecycle phases for the intelligence stack.
 * Used by the orchestrator to report readiness without implying a model is loaded.
 */
export const enum FrameIntelligencePhase {
	/** Interfaces registered; no backends active. */
	Scaffolded = 'scaffolded',
	/** Memory / RAG indexes may be built (future). */
	Indexing = 'indexing',
	/** Local model runtime attached (future — not this milestone). */
	ModelReady = 'modelReady',
	/** Adapters / training pipelines available (future). */
	AdaptersReady = 'adaptersReady',
}
