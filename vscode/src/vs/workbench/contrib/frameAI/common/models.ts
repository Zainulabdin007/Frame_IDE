/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frame Intelligence data models.
 * Pure types — no I/O, no networking, no inference.
 */

import { URI } from '../../../../base/common/uri.js';
import type {
	IFrameKnowledgeEdge,
	IFrameKnowledgeMetadata,
	IFrameKnowledgeNode,
} from '../knowledge/frameKnowledgeGraph.js';

// ---- Turns & sessions -------------------------------------------------------

export const enum FrameMessageRole {
	System = 'system',
	User = 'user',
	Assistant = 'assistant',
	Tool = 'tool',
}

export interface IFrameChatMessage {
	readonly id: string;
	readonly role: FrameMessageRole;
	readonly content: string;
	readonly createdAt: number;
	/** Optional workspace-relative paths referenced by this turn. */
	readonly relatedUris?: readonly URI[];
}

export interface IFrameChatSession {
	readonly id: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messages: readonly IFrameChatMessage[];
}

// ---- Orchestrator -----------------------------------------------------------

export const enum FrameTaskKind {
	Chat = 'chat',
	Explain = 'explain',
	Edit = 'edit',
	Search = 'search',
	Index = 'index',
	TrainAdapter = 'trainAdapter',
}

/**
 * A user- or system-initiated intelligence task.
 * The orchestrator plans work; it does not run a model in this milestone.
 */
export interface IFrameTaskRequest {
	readonly id: string;
	readonly kind: FrameTaskKind;
	readonly prompt: string;
	readonly sessionId?: string;
	readonly activeUri?: URI;
	readonly attachedUris?: readonly URI[];
	readonly selectionText?: string;
	readonly createdAt: number;
	/** Prior chat turns for multi-turn local inference. */
	readonly messages?: readonly IFrameChatMessage[];
}

export const enum FrameTaskStatus {
	Queued = 'queued',
	Planning = 'planning',
	GatheringContext = 'gatheringContext',
	AwaitingModel = 'awaitingModel',
	Generating = 'generating',
	Completed = 'completed',
	Cancelled = 'cancelled',
	Failed = 'failed',
}

export interface IFrameTaskPlan {
	readonly taskId: string;
	readonly status: FrameTaskStatus;
	/** Memory keys / session ids to load. */
	readonly memoryHints: readonly string[];
	/** RAG queries the orchestrator intends to run. */
	readonly ragQueries: readonly string[];
	/** Adapter ids to activate for this task (future). */
	readonly adapterIds: readonly string[];
	readonly notes?: string;
}

export interface IFrameTaskResult {
	readonly taskId: string;
	readonly status: FrameTaskStatus;
	readonly plan?: IFrameTaskPlan;
	readonly message?: string;
	/** Full text produced by the inference runtime (stub or future model). */
	readonly output?: string;
	/** Temporary generation id for accept/reject/edit tracking. */
	readonly generationId?: string;
	/** Stub edit plan id when the prompt had edit intent (preview only until Accept). */
	readonly editPlanId?: string;
	/** Short summary of a pending stub edit plan. */
	readonly editPlanSummary?: string;
	/** Deterministic execution plan id from the task planner. */
	readonly executionPlanId?: string;
	readonly error?: string;
}

// ---- Memory -----------------------------------------------------------------

export const enum FrameMemoryScope {
	Session = 'session',
	Workspace = 'workspace',
	User = 'user',
}

export interface IFrameMemoryEntry {
	readonly id: string;
	readonly scope: FrameMemoryScope;
	readonly key: string;
	readonly value: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly workspaceId?: string;
	readonly sessionId?: string;
	readonly tags?: readonly string[];
}

export interface IFrameMemoryQuery {
	readonly scope?: FrameMemoryScope;
	readonly workspaceId?: string;
	readonly sessionId?: string;
	readonly tags?: readonly string[];
	readonly text?: string;
	readonly limit?: number;
}

/** Durable memory kinds written under `.frame/memory/`. */
export const enum FramePersistentMemoryKind {
	Project = 'project',
	Preference = 'preference',
	Decision = 'decision',
	ConversationSummary = 'conversationSummary',
}

export type FrameProjectMemoryCategory = 'info' | 'architecture' | 'technology' | 'convention';

export interface IFrameProjectMemory {
	readonly id: string;
	readonly kind: FramePersistentMemoryKind.Project;
	readonly title: string;
	readonly content: string;
	readonly category: FrameProjectMemoryCategory;
	readonly relatedFiles?: readonly string[];
	readonly tags?: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * User coding preference with observation metadata for future LoRA training.
 */
export interface IFrameUserPreference {
	readonly id: string;
	readonly kind: FramePersistentMemoryKind.Preference;
	readonly preference: string;
	readonly language?: string;
	readonly confidence: number;
	readonly observations: number;
	readonly accepted: number;
	readonly rejected: number;
	readonly tags?: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface IFrameDecisionMemory {
	readonly id: string;
	readonly kind: FramePersistentMemoryKind.Decision;
	readonly decision: string;
	readonly rationale?: string;
	readonly relatedFiles?: readonly string[];
	readonly tags?: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Compressed conversation memory — never raw chat transcripts. */
export interface IFrameConversationSummary {
	readonly id: string;
	readonly kind: FramePersistentMemoryKind.ConversationSummary;
	readonly topic: string;
	readonly summary: string;
	readonly relatedFiles: readonly string[];
	readonly sessionId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type IFramePersistentMemoryRecord =
	| IFrameProjectMemory
	| IFrameUserPreference
	| IFrameDecisionMemory
	| IFrameConversationSummary;

export interface IFramePersistentMemorySearchQuery {
	readonly kind?: FramePersistentMemoryKind;
	readonly text?: string;
	readonly language?: string;
	readonly tags?: readonly string[];
	readonly sessionId?: string;
	readonly limit?: number;
}

export interface IFrameMemoryExportBundle {
	readonly version: number;
	readonly exportedAt: number;
	readonly folder?: string;
	readonly project: readonly IFrameProjectMemory[];
	readonly preferences: readonly IFrameUserPreference[];
	readonly decisions: readonly IFrameDecisionMemory[];
	readonly conversationSummaries: readonly IFrameConversationSummary[];
}

// ---- Preference observation -------------------------------------------------

export const enum FrameObservationChangeType {
	Generated = 'generated',
	Accepted = 'accepted',
	Rejected = 'rejected',
	Edited = 'edited',
	Reverted = 'reverted',
	ManualModification = 'manualModification',
	/** User accepted Frame-generated code into the editor. */
	AcceptedGeneration = 'accepted_generation',
	/** User edited within a Frame-generated range only. */
	EditedGeneration = 'edited_generation',
	/** User discarded a Frame generation without accepting. */
	RejectedGeneration = 'rejected_generation',
}

/**
 * A single coding-behavior signal for future preference / LoRA training.
 * No model training happens when these are recorded.
 */
export interface IFrameObservation {
	readonly id: string;
	readonly timestamp: number;
	readonly project?: string;
	readonly language?: string;
	readonly file?: string;
	readonly before: string;
	readonly after: string;
	readonly changeType: FrameObservationChangeType;
	readonly confidence: number;
	readonly sessionId?: string;
	readonly taskId?: string;
	readonly generationId?: string;
	readonly diffSummary?: string;
	/** Analyzer signal ids extracted from this observation, if any. */
	readonly signalIds?: readonly string[];
}

export const enum FramePreferenceLifecycle {
	/** Raw signal seen once. */
	Observed = 'observed',
	/** Repeated pattern — awaiting more evidence / approval. */
	Candidate = 'candidate',
	/** User approved. */
	Confirmed = 'confirmed',
	/** Active in persistent memory / context. */
	Active = 'active',
	/** User rejected — keep for negative signal only. */
	Rejected = 'rejected',
}

/**
 * Extracted preference hypothesis. Never auto-applied until Active.
 */
export interface IFrameCandidatePreference {
	readonly id: string;
	readonly preference: string;
	readonly signalId: string;
	readonly language?: string;
	readonly lifecycle: FramePreferenceLifecycle;
	readonly observationIds: readonly string[];
	readonly sessionIds: readonly string[];
	readonly observationCount: number;
	readonly confidence: number;
	readonly examples?: readonly { readonly before: string; readonly after: string }[];
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Set when promoted into `.frame/memory/preferences.json`. */
	readonly memoryPreferenceId?: string;
}

export interface IFrameRecordObservationInput {
	readonly before: string;
	readonly after: string;
	readonly changeType: FrameObservationChangeType;
	readonly language?: string;
	readonly file?: string;
	readonly project?: string;
	readonly confidence?: number;
	readonly sessionId?: string;
	readonly taskId?: string;
	readonly generationId?: string;
	readonly diffSummary?: string;
	readonly timestamp?: number;
}

export const enum FrameGenerationStatus {
	Pending = 'pending',
	Inserted = 'inserted',
	Accepted = 'accepted',
	Edited = 'edited',
	Rejected = 'rejected',
	Expired = 'expired',
}

/**
 * Temporary record of Frame-produced text. Not an observation until
 * accept / edit-in-range / reject occurs.
 */
export interface IFrameTrackedGeneration {
	readonly generationId: string;
	readonly taskId?: string;
	readonly file?: string;
	readonly language?: string;
	readonly content: string;
	readonly timestamp: number;
	readonly project?: string;
	readonly status: FrameGenerationStatus;
	readonly uri?: string;
	readonly startLineNumber?: number;
	readonly startColumn?: number;
	readonly endLineNumber?: number;
	readonly endColumn?: number;
	/** Content snapshot for the tracked range (updated after in-range edits). */
	readonly trackedText?: string;
}

export interface IFrameTrackGenerationInput {
	readonly content: string;
	readonly taskId?: string;
	readonly file?: string;
	readonly language?: string;
	readonly project?: string;
	readonly generationId?: string;
}

// ---- RAG --------------------------------------------------------------------

export const enum FrameRagChunkKind {
	Function = 'function',
	Class = 'class',
	Module = 'module',
	Block = 'block',
}

export interface IFrameRagChunk {
	readonly id: string;
	readonly uri: URI;
	/** Workspace-relative path when available. */
	readonly relativePath?: string;
	readonly language?: string;
	readonly kind?: FrameRagChunkKind;
	readonly symbolName?: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly score?: number;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface IFrameRagQuery {
	readonly text: string;
	readonly workspaceFolders?: readonly URI[];
	readonly activeUri?: URI;
	readonly selectionText?: string;
	readonly limit?: number;
	readonly maxChars?: number;
}

export interface IFrameRagResult {
	readonly query: string;
	readonly chunks: readonly IFrameRagChunk[];
	readonly indexedAt?: number;
	/** Distinct files represented in the result, ranked by best chunk score. */
	readonly files?: readonly string[];
}

export interface IFrameRagIndexStatus {
	readonly ready: boolean;
	readonly documentCount: number;
	readonly chunkCount: number;
	readonly lastIndexedAt?: number;
	readonly message?: string;
	readonly indexRoot?: string;
}

export interface IFrameWorkspaceFileInfo {
	readonly uri: URI;
	readonly relativePath: string;
	readonly language: string;
	readonly size: number;
	readonly symbols: readonly string[];
}

// ---- Adapters (LoRA lifecycle — no training in this milestone) --------------

export const enum FrameAdapterKind {
	/** Low-rank adaptation weights for a base local model. */
	LoRA = 'lora',
	/** Future: prompt/style packs without weight files. */
	PromptPack = 'promptPack',
}

export const enum FrameAdapterState {
	Registered = 'registered',
	Available = 'available',
	Active = 'active',
	Training = 'training',
	Failed = 'failed',
	Disabled = 'disabled',
}

/** What the adapter specializes. */
export const enum FrameAdapterScope {
	Language = 'language',
	Project = 'project',
	User = 'user',
}

/**
 * On-disk metadata (`metadata.json` under `.frame/adapters/<id>/`).
 */
export interface IFrameAdapterMetadata {
	readonly id: string;
	readonly name: string;
	readonly language?: string;
	readonly version: string;
	readonly baseModel: string;
	readonly created: number;
	readonly trainingExamples: number;
	readonly lastUpdated: number;
	readonly scope: FrameAdapterScope;
	readonly kind: FrameAdapterKind;
	readonly state: FrameAdapterState;
	readonly description?: string;
	/** Placeholder weight filename e.g. `LoRA.python` — no real weights yet. */
	readonly weightFile?: string;
	readonly rank?: number;
	readonly tags?: readonly string[];
	/** Target base precision when known (e.g. 4-bit). */
	readonly precision?: string;
	/** Product-owned foundation adapter — always on, not user-removable. */
	readonly builtin?: boolean;
}

export interface IFrameAdapterDescriptor {
	readonly id: string;
	readonly name: string;
	readonly kind: FrameAdapterKind;
	readonly state: FrameAdapterState;
	readonly scope: FrameAdapterScope;
	/** Base model id this adapter targets (e.g. future `qwen2.5-coder`). */
	readonly baseModelId: string;
	readonly language?: string;
	readonly version: string;
	readonly trainingExamples: number;
	readonly description?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Workspace-relative path under `.frame/adapters/<id>/`. */
	readonly localPath?: string;
	readonly weightFileName?: string;
	/** True when a real weight file exists on disk (not metadata-only). */
	readonly weightsLinked?: boolean;
	/** Size of the linked weight file when {@link weightsLinked} is true. */
	readonly weightBytes?: number;
	readonly rank?: number;
	readonly tags?: readonly string[];
	/** Product-owned foundation adapter — always on, not user-removable. */
	readonly builtin?: boolean;
}

export interface IFrameAdapterCompatibilityRequest {
	readonly language?: string;
	readonly baseModelId?: string;
	/** Minimum semver-ish version string the host accepts. */
	readonly minAdapterVersion?: string;
}

export interface IFrameAdapterCompatibilityResult {
	readonly adapterId: string;
	readonly compatible: boolean;
	readonly reasons: readonly string[];
}

/**
 * Portable metadata package for import/export.
 * Real LoRA bytes travel separately via weight-file export/import (`.gguf` / `.safetensors`).
 */
export interface IFrameAdapterExportPackage {
	readonly formatVersion: number;
	readonly exportedAt: number;
	readonly metadata: IFrameAdapterMetadata;
	/** Weight basename hint when known; empty when metadata-only. */
	readonly weightPlaceholder: string;
	/** Whether the source workspace had a real weight file at export time. */
	readonly hasWeights?: boolean;
}

export interface IFrameRegisterAdapterInput {
	readonly id?: string;
	readonly name: string;
	readonly scope: FrameAdapterScope;
	readonly language?: string;
	readonly version?: string;
	readonly baseModelId?: string;
	readonly kind?: FrameAdapterKind;
	readonly state?: FrameAdapterState;
	readonly description?: string;
	readonly trainingExamples?: number;
	readonly rank?: number;
	readonly tags?: readonly string[];
	readonly weightFileName?: string;
}

// ---- Training ---------------------------------------------------------------

export const enum FrameTrainingJobStatus {
	Draft = 'draft',
	Queued = 'queued',
	Scheduled = 'scheduled',
	Running = 'running',
	Paused = 'paused',
	Succeeded = 'succeeded',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export type FrameTrainingBackend = 'mlx_gpu' | 'cpu';

export interface IFrameTrainingExample {
	readonly id: string;
	readonly input: string;
	readonly expectedOutput: string;
	readonly sourceUri?: URI;
	readonly createdAt: number;
}

export interface IFrameTrainingProbe {
	readonly appleSilicon: boolean;
	readonly mlxAvailable: boolean;
	readonly backend: FrameTrainingBackend;
	readonly reason: string;
	readonly mlxPython?: string | null;
}

export interface IFrameTrainingEstimate {
	readonly backend: FrameTrainingBackend;
	readonly iters: number;
	readonly trainRows: number;
	readonly validRows: number;
	readonly estimatedDurationHours: number;
	readonly estimatedRamGb: number;
	readonly notes: readonly string[];
}

export interface IFrameTrainingJobOptions {
	readonly iters?: number;
	readonly dataDir?: string;
	readonly adapterPath?: string;
	readonly model?: string;
	/** Prefer background CPU scheduling (nice/taskpolicy). */
	readonly cpuLimit?: boolean;
	/** Force CPU even when MLX is available. */
	readonly forceCpu?: boolean;
	/** overnight | +8h | ISO timestamp */
	readonly scheduleAt?: string;
}

export interface IFrameTrainingJob {
	readonly id: string;
	readonly name: string;
	readonly baseModelId: string;
	readonly adapterId?: string;
	readonly status: FrameTrainingJobStatus;
	readonly examples: readonly IFrameTrainingExample[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly progress?: number;
	readonly error?: string;
	readonly backend?: FrameTrainingBackend;
	readonly iters?: number;
	readonly estimate?: IFrameTrainingEstimate;
	readonly probe?: IFrameTrainingProbe;
	readonly pid?: number | null;
	readonly scheduleAt?: string;
	readonly logFile?: string;
	readonly adapterPath?: string;
	readonly dataDir?: string;
	readonly cpuLimit?: boolean;
}

// ---- Local model / inference runtime seam -----------------------------------

/**
 * Opaque handle for a local runtime backend.
 * Weights are always user-provided — Frame never downloads them.
 */
export interface IFrameLocalModelHandle {
	readonly modelId: string;
	readonly displayName: string;
	readonly runtime: FrameRuntimeKind;
	readonly ready: boolean;
	/** Absolute or workspace-relative path to user-provided weights (null until set). */
	readonly modelPath?: string | null;
}

/**
 * Backend identifier for the inference runtime seam.
 * Only local backends — no cloud providers.
 */
export type FrameRuntimeKind =
	| 'none'
	| 'stub'
	| 'mlx'
	| 'llamacpp'
	| 'future-other';

/** @deprecated Prefer {@link FrameRuntimeKind}. */
export type FrameInferenceBackendKind = FrameRuntimeKind;

export interface IFrameGenerateOptions {
	readonly signal?: AbortSignal;
}

/**
 * Result of a local {@link IFrameInferenceRuntime.generate} call.
 */
export interface IFrameInferenceResult {
	readonly taskId: string;
	readonly text: string;
	readonly runtimeId: string;
	readonly modelInfo?: IFrameLocalModelHandle;
	readonly durationMs: number;
	/** True when the stub (or other non-model) backend produced the text. */
	readonly placeholder: boolean;
	/** True after local privacy checks passed. */
	readonly privacyValidated: boolean;
	readonly aborted?: boolean;
	readonly error?: string;
}

/**
 * Persisted under `<workspace>/.frame/config/runtime.json`.
 * `enabled: false` and `modelPath: null` are the safe defaults.
 */
export interface IFrameRuntimeConfig {
	/** Selected backend id (`stub` | `mlx` | `llamacpp`). */
	readonly runtime: FrameRuntimeKind;
	/**
	 * Primary model selection — Frame catalog / registry id
	 * (e.g. `qwen-coder-7b-q4`). Preferred over raw paths.
	 */
	readonly activeModelId: string | null;
	/**
	 * Optional override path. Prefer model registry `localPath` via {@link activeModelId}.
	 * @deprecated Prefer selecting a model id; kept for migration.
	 */
	readonly modelPath: string | null;
	/** When false, Frame stays on the stub / does not load native backends. */
	readonly enabled: boolean;
	/**
	 * When false (default), refuse to load **imported packages** whose trustStatus is
	 * UNVERIFIED (and always refuse INVALID). Catalog models with a user `modelPath`
	 * and no package checksum/signature metadata are still allowed.
	 */
	readonly allowUnverifiedModels?: boolean;
	readonly updatedAt?: number;
}

export interface IFrameRuntimeDescriptor {
	readonly id: string;
	readonly kind: FrameRuntimeKind;
	readonly displayName: string;
	readonly available: boolean;
	readonly ready: boolean;
	readonly description: string;
}

export interface IFrameRuntimeStatus {
	readonly activeRuntimeId: string | undefined;
	readonly activeKind: FrameRuntimeKind;
	readonly enabled: boolean;
	readonly activeModelId: string | null;
	readonly modelPath: string | null;
	readonly available: readonly IFrameRuntimeDescriptor[];
	readonly configPath: string;
	/** Selected Frame model profile metadata (not loaded). */
	readonly selectedModel?: IFrameModelDescriptor;
	/** Isolated model worker lifecycle (no weights loaded in IDE). */
	readonly worker?: IFrameModelWorkerSnapshot;
	/**
	 * Active process / executor summary for the Runtime panel.
	 * Example: `{ worker: "READY", model: "not loaded", inference: false }`
	 */
	readonly execution?: IFrameRuntimeExecutionState;
}

export interface IFrameRuntimeExecutionState {
	readonly worker: 'STOPPED' | 'STARTING' | 'READY' | 'ERROR' | string;
	readonly model: 'not loaded' | 'loaded' | string;
	readonly inference: boolean;
}

// ---- Model worker execution boundary (isolated process contract) ------------

/**
 * Lifecycle of the local model worker process.
 * The IDE renderer never loads weights — only the worker may, in a future release.
 */
export const enum FrameModelWorkerStatus {
	Stopped = 'STOPPED',
	Starting = 'STARTING',
	Ready = 'READY',
	Stopping = 'STOPPING',
	Error = 'ERROR',
}

/** Placeholder memory counters — real values when a native worker exists. */
export interface IFrameModelWorkerMemoryStatus {
	readonly ramMb: number | null;
	readonly gpuMb: number | null;
	/** Alias for UI: memoryUsage placeholder. */
	readonly memoryUsage?: number | null;
	/** Alias for UI: gpuUsage placeholder. */
	readonly gpuUsage?: number | null;
	readonly note?: string;
}

export interface IFrameModelWorkerHealth {
	readonly status: FrameModelWorkerStatus;
	readonly healthy: boolean;
	readonly lastHeartbeatAt: number | null;
	readonly message?: string;
	readonly memory: IFrameModelWorkerMemoryStatus;
	readonly workerId: string | null;
	readonly uptimeMs: number;
	/** OS process id when a real child process is running. */
	readonly pid: number | null;
	readonly diagnostics?: IFrameModelWorkerDiagnostics;
}

/** Compact snapshot embedded in runtime status for the Models / Runtime UI. */
export interface IFrameModelWorkerSnapshot {
	readonly status: FrameModelWorkerStatus;
	readonly healthy: boolean;
	readonly message?: string;
	readonly memory: IFrameModelWorkerMemoryStatus;
	readonly processRunning?: boolean;
	readonly modelLoaded?: boolean;
	readonly inferenceEnabled?: boolean;
	readonly pid?: number | null;
	readonly diagnostics?: IFrameModelWorkerDiagnostics;
}

/** Runtime-panel worker diagnostics (no fake GPU). */
export interface IFrameModelWorkerDiagnostics {
	readonly status: FrameModelWorkerStatus | string;
	readonly pid: number | null;
	readonly pendingRequests: number;
	readonly activeConversationId: string | null;
	readonly messagesSent: number;
	readonly messagesReceived: number;
	readonly lastHeartbeatAt: number | null;
	readonly workerId: string | null;
	readonly usingChildProcess: boolean;
}


// ---- Model management (profiles / registry — no weight download) ------------

/** Frame product editions mapped to Qwen 7B precision profiles (metadata only). */
export const enum FrameEdition {
	Efficient = 'efficient',
	Professional = 'professional',
	Maximum = 'maximum',
}

export type FrameModelPrecision = '4-bit' | '8-bit' | 'fp16';

/**
 * Catalog profile for a Frame edition.
 * Describes intended weights — Frame never ships or downloads them.
 */
export interface IFrameModelProfile {
	readonly id: string;
	readonly edition: FrameEdition;
	readonly name: string;
	readonly displayName: string;
	/** Architecture label only (e.g. qwen2.5-coder-7b) — not a download URL. */
	readonly architecture: string;
	readonly precision: FrameModelPrecision;
	readonly quantization: string;
	/** Approximate RAM needed when loaded later (GB). */
	readonly memoryRequirementGb: number;
	/** Approximate on-disk size when user provides weights (GB). */
	readonly storageSizeGb: number;
	readonly compatibleRuntimes: readonly FrameRuntimeKind[];
	readonly description: string;
}

/** Compatibility verdict for a model against current hardware. */
export type FrameModelCompatibilityStatus = 'compatible' | 'warning' | 'unsupported' | 'unknown';

/** Local integrity trust recorded in the model registry. */
export const enum FrameModelTrustStatus {
	Unverified = 'UNVERIFIED',
	ChecksumValid = 'CHECKSUM_VALID',
	SignatureValid = 'SIGNATURE_VALID',
	Invalid = 'INVALID',
}

/** Installed / registered model entry (metadata + optional user path). */
export interface IFrameModelDescriptor extends IFrameModelProfile {
	readonly installed: boolean;
	readonly active: boolean;
	/** User-owned local path — never auto-downloaded. */
	readonly localPath: string | null;
	readonly compatibilityStatus: FrameModelCompatibilityStatus;
	readonly compatibilityMessage?: string;
	readonly packageVersion?: string;
	/** Real or placeholder checksum from an imported package. */
	readonly checksum?: string;
	readonly trustStatus?: FrameModelTrustStatus;
	/** Signature metadata recorded at import/verify time. */
	readonly signature?: IFrameModelRegistrySignature;
	readonly registeredAt?: number;
	readonly updatedAt?: number;
}

export interface IFrameModelCompatibilityRequest {
	readonly runtimeKind?: FrameRuntimeKind;
	readonly maxMemoryGb?: number;
	readonly hardware?: IFrameHardwareProfile;
}

export interface IFrameModelCompatibilityResult {
	readonly modelId: string;
	readonly status: FrameModelCompatibilityStatus;
	/** @deprecated Prefer {@link status} === 'compatible'. */
	readonly compatible: boolean;
	readonly reasons: readonly string[];
	readonly message: string;
}

export interface IFrameModelRegistryFile {
	readonly version: number;
	readonly activeModelId: string | null;
	readonly updatedAt: number;
	readonly models: readonly {
		readonly id: string;
		readonly installed: boolean;
		readonly localPath: string | null;
		readonly compatibilityStatus?: FrameModelCompatibilityStatus;
		readonly compatibilityMessage?: string;
		readonly installStatus?: FrameModelInstallStatus;
		readonly checksumPlaceholder?: string;
		readonly packageVersion?: string;
		readonly checksum?: string;
		readonly trustStatus?: FrameModelTrustStatus;
		readonly signature?: IFrameModelRegistrySignature;
		readonly registeredAt?: number;
		readonly updatedAt?: number;
	}[];
}

/** Simulated package install lifecycle (no real downloads). */
export const enum FrameModelInstallStatus {
	Available = 'available',
	Downloading = 'downloading',
	Installed = 'installed',
	Verified = 'verified',
	Active = 'active',
	Failed = 'failed',
}

/**
 * Installable Frame model package metadata.
 * Checksums / paths are placeholders until a real offline installer exists.
 */
export interface IFrameModelPackage {
	readonly id: string;
	readonly edition: FrameEdition;
	readonly modelName: string;
	readonly quantization: string;
	readonly storageSizeGb: number;
	readonly memoryRequirementGb: number;
	readonly status: FrameModelInstallStatus;
	readonly localPath: string | null;
	/** Placeholder only — not a real hash of weights. */
	readonly checksumPlaceholder: string;
	readonly progress?: number;
	readonly displayName: string;
	readonly architecture: string;
}

export interface IFrameEditionRecommendation {
	readonly edition: FrameEdition;
	readonly modelId: string;
	readonly displayName: string;
	readonly reason: string;
	readonly hardwareSummary: string;
}

// ---- Offline model package import (.frame-model) ----------------------------

/** On-disk / archive manifest (`frame-model/manifest.json`). */
export interface IFrameModelPackageManifest {
	readonly format: 'frame-model';
	/** Package format schema version — see {@link FRAME_MODEL_FORMAT_VERSION}. */
	readonly formatVersion: number;
	readonly id: string;
	readonly edition: FrameEdition;
	readonly modelName: string;
	/** Architecture / family label (e.g. qwen2.5-coder-7b). */
	readonly architecture: string;
	/** Model family name for migrations and tooling. */
	readonly modelFamily?: string;
	/** Parameter count label (e.g. "7B"). */
	readonly parameterCount?: string;
	readonly precision: FrameModelPrecision;
	readonly quantization: string;
	readonly packageVersion: string;
	readonly storageSizeGb: number;
	readonly memoryRequirementGb: number;
	/** Relative paths under the package (typically under `model/`). */
	readonly weightFiles: readonly string[];
	readonly description?: string;
	/** Runtime backend compatibility (stub / mlx / llamacpp). */
	readonly compatibleRuntimes?: readonly FrameRuntimeKind[];
	/**
	 * Optional signature metadata. Prefer `signature.json` for Ed25519 packages
	 * so signing does not rewrite checksummed files.
	 */
	readonly signature?: IFrameModelPackageSignature | null;
}

/** Package signature metadata (Ed25519 via signature.json + local public keys). */
export interface IFrameModelPackageSignature {
	readonly algorithm: FrameModelSignatureAlgorithm | string;
	readonly keyId?: string | null;
	readonly signer?: string | null;
	/** Canonical signature payload field. */
	readonly signatureValue?: string | null;
	/** @deprecated Prefer {@link signatureValue}. */
	readonly value?: string | null;
	readonly createdAt?: number | null;
	/** @deprecated Prefer {@link createdAt}. */
	readonly signedAt?: number | null;
	readonly note?: string;
}

/** Algorithms recognized by the trust layer (Ed25519 is cryptographically verified offline). */
export type FrameModelSignatureAlgorithm = 'none' | 'pending' | 'ed25519' | 'rsa-pss-sha256';

/** Offline signature verification outcome (metadata + crypto). */
export type FrameModelSignatureVerifyStatus = 'unsigned' | 'verified' | 'invalid' | 'unsupported' | 'unknown_key';

export interface IFrameModelSignatureVerifyResult {
	readonly status: FrameModelSignatureVerifyStatus;
	readonly message: string;
	readonly algorithm?: string;
	readonly keyId?: string | null;
	readonly signer?: string | null;
}

/** Result of cryptographic package signature verification (Ed25519). */
export const enum FrameModelPackageCryptoStatus {
	Verified = 'VERIFIED',
	Invalid = 'INVALID',
	UnknownKey = 'UNKNOWN_KEY',
	Unsigned = 'UNSIGNED',
	Unsupported = 'UNSUPPORTED',
}

export interface IFrameModelPackageCryptoVerifyResult {
	readonly status: FrameModelPackageCryptoStatus;
	readonly keyId: string | null;
	readonly message: string;
	readonly algorithm?: string;
}

/** Locally imported public key for offline package verification. */
export interface IFrameModelPublicKeyRecord {
	readonly keyId: string;
	readonly algorithm: 'ed25519';
	readonly owner: string;
	/** Base64 SPKI (DER) public key — never a private key. */
	readonly publicKey: string;
	readonly createdAt: number;
	readonly note?: string;
}

/** Signature summary persisted on registry entries. */
export interface IFrameModelRegistrySignature {
	readonly algorithm: string;
	readonly keyId: string | null;
	readonly verifyStatus?: FrameModelSignatureVerifyStatus | FrameModelPackageCryptoStatus | string;
}

export interface IFrameModelChecksumFileResult {
	readonly file: string;
	readonly expected: string;
	readonly actual?: string;
}

/** Current Frame model package format version (developer tooling + IDE). */
export const FRAME_MODEL_FORMAT_VERSION = 2;

/** Minimum formatVersion the IDE accepts after migration. */
export const FRAME_MODEL_FORMAT_VERSION_MIN = 1;

/** Checksums map — values may be placeholders (`sha256:pending-user-weights`). */
export interface IFrameModelPackageChecksums {
	readonly version: number;
	readonly files: Readonly<Record<string, string>>;
}

export interface IFrameModelPackageContents {
	readonly sourceUri: string;
	readonly packageRootUri: string;
	readonly manifest: IFrameModelPackageManifest;
	readonly checksums: IFrameModelPackageChecksums;
	readonly weightFilesPresent: readonly string[];
	readonly weightFilesMissing: readonly string[];
}

export type FrameModelVerifySeverity = 'error' | 'warning' | 'info';

export interface IFrameModelVerifyIssue {
	readonly severity: FrameModelVerifySeverity;
	readonly code: string;
	readonly message: string;
}

export interface IFrameModelChecksumVerifyResult {
	readonly ok: boolean;
	readonly matched: readonly string[];
	readonly mismatched: readonly IFrameModelChecksumFileResult[];
	readonly missing: readonly string[];
	readonly placeholders: readonly string[];
	readonly issues: readonly IFrameModelVerifyIssue[];
}

export interface IFrameModelImportStages {
	readonly readManifest: boolean;
	readonly verifyChecksums: boolean;
	readonly verifySignature: boolean;
	readonly install: boolean;
	readonly register: boolean;
	readonly activate: boolean;
}

/** Mutable builder for import pipeline stages. */
export interface IFrameModelImportStagesBuilder {
	readManifest: boolean;
	verifyChecksums: boolean;
	verifySignature: boolean;
	install: boolean;
	register: boolean;
	activate: boolean;
}

export interface IFrameModelVerifyResult {
	readonly ok: boolean;
	readonly issues: readonly IFrameModelVerifyIssue[];
	readonly package?: IFrameModelPackageContents;
	readonly checksumResult?: IFrameModelChecksumVerifyResult;
	readonly signatureResult?: IFrameModelSignatureVerifyResult;
	readonly trustStatus?: FrameModelTrustStatus;
}

export interface IFrameModelImportResult {
	readonly ok: boolean;
	readonly modelId: string;
	readonly localPath: string;
	readonly packageVersion: string;
	readonly checksum: string;
	readonly trustStatus?: FrameModelTrustStatus;
	readonly stages?: IFrameModelImportStages;
	readonly descriptor?: IFrameModelDescriptor;
	readonly issues: readonly IFrameModelVerifyIssue[];
}

export interface IFrameAdapterPrecisionWarning {
	readonly adapterId: string;
	readonly adapterName: string;
	readonly adapterPrecision: string;
	readonly modelPrecision: FrameModelPrecision;
	readonly message: string;
}

// ---- Hardware detection -----------------------------------------------------

export interface IFrameHardwareProfile {
	readonly os: string;
	readonly osLabel: string;
	readonly architecture: string;
	readonly ramGB: number;
	readonly freeRamGB?: number;
	readonly gpuAvailable: boolean;
	readonly gpuMemoryGB?: number;
	readonly gpuName?: string;
	readonly appleSilicon: boolean;
	readonly cpuModel?: string;
	readonly detectedAt: number;
}

// ---- Context engine ---------------------------------------------------------

export interface IFrameCursorPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export interface IFrameOpenFileRef {
	readonly uri: URI;
	readonly relativePath?: string;
	readonly languageId?: string;
	readonly isActive: boolean;
}

export interface IFrameWorkspaceContext {
	readonly folders: readonly URI[];
	readonly name?: string;
}

/**
 * Adapter slice selected for a future local model call.
 */
export interface IFrameAdapterContext {
	/** All discovered / registered adapters (any state except removed). */
	readonly available: readonly IFrameAdapterDescriptor[];
	readonly active: readonly IFrameAdapterDescriptor[];
	/** Active language/specialty adapter when tagged or scoped. */
	readonly languageAdapter?: IFrameAdapterDescriptor;
	/** Active project adapter when scoped. */
	readonly projectAdapter?: IFrameAdapterDescriptor;
	/** Active user/style adapter when tagged or scoped. */
	readonly userAdapter?: IFrameAdapterDescriptor;
}

/**
 * Input to {@link IFrameContextService.build}.
 * Typically derived from an orchestrator task + live editor state.
 */
export interface IFrameContextBuildRequest {
	readonly taskId: string;
	readonly request: string;
	readonly sessionId?: string;
	readonly activeUri?: URI;
	readonly attachedUris?: readonly URI[];
	readonly selectionText?: string;
	readonly workspaceFolders?: readonly URI[];
	readonly systemPrompt?: string;
	readonly messages?: readonly IFrameChatMessage[];
}

/**
 * Context bundle assembled by the Frame Context Engine before a future model call.
 * Intended to be passed directly into a local runtime (e.g. Qwen) — not yet wired.
 */
export interface IFrameInferenceContext {
	readonly taskId: string;
	/** Original user request / prompt. */
	readonly request: string;
	readonly workspace: IFrameWorkspaceContext;
	readonly activeFile?: URI;
	readonly activeRelativePath?: string;
	readonly languageId?: string;
	readonly selectedCode?: string;
	/** Authoritative editor/file contents, bounded only for IPC safety. */
	readonly activeFileContent?: string;
	readonly cursor?: IFrameCursorPosition;
	readonly openFiles: readonly IFrameOpenFileRef[];
	/** Ranked related source paths from RAG. */
	readonly relatedFiles: readonly string[];
	/** Ranked code chunks (functions/classes/blocks). */
	readonly relatedChunks: readonly IFrameRagChunk[];
	/** Documentation / README-style chunks from RAG. */
	readonly documentationChunks: readonly IFrameRagChunk[];
	/** Structural knowledge-graph summary (alongside RAG). */
	readonly knowledgeGraph?: IFrameKnowledgeMetadata;
	/** Related symbols from the knowledge graph. */
	readonly relatedSymbols?: readonly IFrameKnowledgeNode[];
	/** Call hierarchy edges for focus symbols. */
	readonly callHierarchy?: readonly IFrameKnowledgeEdge[];
	/** Import/dependency edges for the active file / focus. */
	readonly dependencyGraph?: readonly IFrameKnowledgeEdge[];
	/** Files likely affected by the request (graph + RAG). */
	readonly affectedFiles?: readonly string[];
	/** Project decisions + prior conversation memories. */
	readonly memories: readonly IFrameMemoryEntry[];
	/** User preference memories. */
	readonly preferences: readonly IFrameMemoryEntry[];
	readonly adapters: IFrameAdapterContext;
	readonly systemPrompt: string;
	readonly messages: readonly IFrameChatMessage[];
	readonly builtAt: number;

	/** @deprecated Prefer `memories` — kept for existing callers. */
	readonly memory: readonly IFrameMemoryEntry[];
	/** @deprecated Prefer `relatedChunks`. */
	readonly rag: readonly IFrameRagChunk[];
	/** @deprecated Prefer `relatedFiles`. */
	readonly files?: readonly string[];
	/** @deprecated Prefer `adapters.active`. */
	readonly activeAdapters: readonly IFrameAdapterDescriptor[];
}
