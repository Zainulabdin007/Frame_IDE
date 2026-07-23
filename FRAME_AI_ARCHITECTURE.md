# Frame AI Architecture

Internal architecture for **Frame Intelligence** — the local-first stack that drives Frame’s on-device coding model.

**Milestone status:** Orchestrator, context, RAG, memory, adapters, planning, and **local llama.cpp inference** (via isolated worker) are wired. Conversation lives in **built-in Chat**; the Frame sidebar is **control plane only**.  
**Still out of scope:** cloud APIs, bundling/downloading model weights, editor-core rewrites.

**Code root:** `vscode/src/vs/workbench/contrib/frameAI/`  
**Roadmap:** `FRAME_ROADMAP.md`  
**Companion docs:** `FRAME_ARCHITECTURE.md`, `FRAME_COMPONENT_MAP.md`, `FRAME_REBRAND.md`, `FRAME_ADAPTER_ARCHITECTURE.md`, `FRAME_ADAPTER_UI.md`, `FRAME_LOCAL_RUNTIME_ARCHITECTURE.md`, `FRAME_RUNTIME_UI.md`, `FRAME_MODEL_MANAGEMENT.md`, `FRAME_HARDWARE_COMPATIBILITY.md`, `FRAME_LLAMA_CPP_RUNTIME.md`

---

## 1. Architecture overview

Frame AI sits **beside** the existing IDE shell. Built-in Chat talks to Frame via `FrameChatAgent`; the Activity Bar **Frame** view configures models, runtime, and adapters.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frame Workbench (VS Code)                    │
│  Editor · Explorer · Terminal · SCM · Settings · …              │
└───────────────┬───────────────────────────────┬─────────────────┘
                │                               │
                ▼                               ▼
   Built-in Chat (FrameChatAgent)     Frame sidebar (control plane)
                │                      Models · Runtime · Adapters
                ▼
         IFrameIntelligenceService
                │
   Orchestrator · Memory · RAG · KG · Adapters · Background
                │
                ▼
         Local Model Worker (llama.cpp / GGUF)
```

### Package layout

```
frameAI/
├── browser/          # Control sidebar + FrameChatAgent
├── background/       # Idle Background Intelligence Engine
├── common/           # Constants, models, privacy guarantees
├── orchestrator/     # Task planning & context assembly
├── memory/           # Session / workspace / user memory
├── rag/              # Local retrieval index API
├── adapters/         # LoRA / adapter registry
├── training/         # Local training job manager
└── services/         # Facade + DI registration
```

All services register via VS Code DI (`registerSingleton`, `InstantiationType.Delayed`).

---

## 2. Data flow

```
User
  │
  ▼
Built-in Chat  (FrameChatAgent)
  │  submitTask
  ▼
Orchestrator
  │  plan → memory hints, RAG queries, adapter ids
  ├──────────► Memory   (load / store local facts)
  ├──────────► RAG      (retrieve local code chunks)
  ├──────────► Adapters (select active LoRA ids)
  │
  ▼
IFrameInferenceContext  (assembled locally)
  │
  ▼
Model Worker  (llama.cpp GGUF when modelPath set)
  │
  ▼
Streamed tokens → Chat UI
```

**Today:** Chat → FrameChatAgent → orchestrator → worker. With a GGUF `modelPath`, tokens stream from llama.cpp; without one, the worker returns `MODEL_RUNTIME_NOT_CONNECTED` stub text.

**Always:** the same `IFrameInferenceContext` is passed to the local runtime; the Chat UI does not need to know which backend produced the text.

**Control plane:** Frame sidebar configures models, runtime, and adapters — it does not own chat.

---

## 3. Subsystem responsibilities

| Subsystem | Interface | Responsibility |
|-----------|-----------|----------------|
| **Facade** | `IFrameIntelligenceService` | Single entry for UI/commands; exposes privacy + phase + children |
| **Orchestrator** | `IFrameOrchestratorService` | Accepts tasks, builds plans, gathers context, never calls cloud |
| **Context Engine** | `IFrameContextService` | Assembles `IFrameInferenceContext` (editor + RAG + memory + adapters) |
| **Inference Runtime** | `IFrameInferenceRuntime` | Pluggable local backend (`generate` → `IFrameInferenceResult`) |
| **Runtime Registry** | `IFrameRuntimeService` | Register / select backends; `.frame/config/runtime.json` |
| **Runtime UI** | Frame AI sidebar **Runtime** | Status + enable/backend/path config (no weight load) |
| **Models** | `IFrameModelService` | Frame Efficient / Professional / Maximum profiles + registry |
| **Hardware** | `IFrameHardwareService` | Local OS / RAM / GPU probe for compatibility |
| **Compatibility** | `IFrameModelCompatibilityService` | compatible / warning / unsupported vs hardware |
| **Memory** | `IFrameMemoryService` | Facade: ephemeral session + durable write-through |
| **Persistent Memory** | `IFramePersistentMemoryService` | Project / prefs / decisions / summaries under `.frame/memory/` |
| **Observations** | `IFrameObservationService` | Preference Observation Engine (candidates; no training) |
| **Generation Tracker** | `IFrameGenerationTracker` | Frame-only accept/edit/reject signals → observations |
| **Preference Review** | `IFramePreferenceReviewService` | Learning UI approve/reject before prefs go active |
| **RAG** | `IFrameRagService` | Local workspace scan/chunk/index under `.frame/rag/` + lexical query |
| **Adapters** | `IFrameAdapterService` | Register / activate LoRA (and related) adapter metadata |
| **Adapter UI** | `IFrameAdapterManagementService` | Sidebar activate / import / export / details (no training) |
| **Training** | `IFrameTrainingManager` | Create / queue / cancel local training jobs (no workers yet) |

### Orchestrator

- Input: `IFrameTaskRequest` (`chat`, `explain`, `edit`, `search`, `index`, `trainAdapter`)
- Output: `IFrameTaskResult` + optional `IFrameTaskPlan`
- Delegates context assembly to the Context Engine → `IFrameInferenceContext`
- Phase: `FrameIntelligencePhase.Scaffolded` until a model is attached

### Context Engine

- `IFrameContextService.build(request)` → full `IFrameInferenceContext`
- Collects: user request, editor (active/selection/cursor/open files), RAG, memory, adapters
- See `FRAME_CONTEXT_ENGINE.md`

### Inference Runtime

- `IFrameRuntimeService` registers stub + MLX/llama.cpp placeholders
- `generate(context)` → `IFrameInferenceResult` (stub placeholder today)
- Config: `.frame/config/runtime.json` (`enabled: false`, `modelPath: null` by default)
- Sidebar **Runtime** panel: status, privacy, enable/backend/path — see `FRAME_RUNTIME_UI.md`
- User-provided weights only — see `FRAME_LOCAL_RUNTIME_ARCHITECTURE.md`

### Memory

- Scopes: `session` (ephemeral) | durable kinds under `.frame/memory/`
- Durable: project facts, user preferences (with confidence metadata), decisions, conversation summaries
- CRUD + search + export/import via `IFramePersistentMemoryService`
- See `FRAME_MEMORY_PERSISTENCE.md`

### Preference Observation

- `recordObservation` → analyzer → CandidatePreference lifecycle
- Active preferences require explicit `approvePreference` (Learning UI)
- Editor path: `FrameGenerationTracker` (accept / in-range edit / reject only)
- See `FRAME_PREFERENCE_LEARNING.md`, `FRAME_EDITOR_SIGNAL_INTEGRATION.md`, `FRAME_PREFERENCE_REVIEW_UI.md`

### RAG

- `reindex(folders?)` / `query(context)` / `getStatus()` / `getIndexedFiles()`
- Indexes into `<workspace>/.frame/rag/` (`meta.json`, `workspace.json`, `chunks.jsonl`)
- Chunk model: path, language, kind, symbol, line range, text, score
- Lexical ranking today; local embeddings later — see `FRAME_RAG_IMPLEMENTATION.md`

### Adapters

- Persistent registry under `.frame/adapters/<id>/` (`metadata.json` + placeholder `LoRA.*`)
- Scopes: `language` | `project` | `user`; discover / register / remove / export / import / compatibility
- Context Engine exposes `available` + `active` (+ language/project/user picks) on `IFrameInferenceContext.adapters`
- Sidebar **Adapters** panel: activate / deactivate / import / export / remove / details — see `FRAME_ADAPTER_UI.md`
- No training, weight download, or model load — see `FRAME_ADAPTER_ARCHITECTURE.md`

### Training

- Jobs: draft → queued → running → succeeded/failed/cancelled
- Examples: input / expectedOutput / optional source URI
- `enqueue()` only flips status to `queued` — no GPU / download / upload

---

## 4. Privacy guarantees

Defined in `common/privacy.ts` as `FRAME_PRIVACY_GUARANTEES`:

| Guarantee | Meaning |
|-----------|---------|
| `localOnly` | Intelligence state stays on the machine |
| `noCloudInference` | No remote model / SaaS clients in this stack |
| `noPromptTelemetry` | Prompts and code are not telemetred by Frame AI |
| `localRagOnly` | Indexing never leaves the device |
| `localAdaptersOnly` | LoRA artifacts stay under user/workspace storage |
| `noAccountRequired` | Sign-in is not required to use Frame AI |

Non-goals for this milestone (also in code):

- No Qwen or other weights bundled/downloaded
- No OpenAI / Anthropic / Copilot / cloud inference clients
- No Monaco / editor-core model hooks
- No network calls from orchestrator / memory / RAG / adapters / training

---

## 5. Future Qwen integration point

The **only** approved place to attach a local model is behind the orchestrator’s inference seam:

1. Implement a runtime that satisfies a future `IFrameLocalModelRuntime` (not created yet; intentionally deferred).
2. Have `IFrameIntelligenceService.getLocalModel()` return `{ modelId, runtime: 'future-qwen', ready: true }`.
3. After `buildInferenceContext(taskId)`, call the runtime with that context.
4. Stream tokens back into the Frame AI UI / apply edits via existing workbench editor services (**not** by patching Monaco core).

**Do not:**

- Call Qwen from the view pane
- Put HTTP clients in `rag/` or `memory/`
- Soft-depend on GitHub Copilot for Frame Intelligence

Suggested future files (not created now):

```
frameAI/runtime/
  frameLocalModel.ts          # interface
  qwen/
    qwenRuntime.ts            # local process / MLX / llama.cpp bridge
```

---

## 6. How LoRA adapters work

See `FRAME_ADAPTER_ARCHITECTURE.md` and `tools/frame-lora-train/README.md`.

```
Offline train (tools/frame-lora-train, MLX QLoRA)
        │
        ▼
Fuse + convert to GGUF (or GGUF LoRA)
        │
        ├─► runtime.json modelPath (fused base)  — simplest
        └─► Frame sidebar “Link weight path” / importWeightFile
                 → .frame/adapters/<id>/<weights>
                 → worker createContext({ lora }) when format supported
```

Adapters no longer write fake `# Frame LoRA placeholder` weight files. Until a real weight file is linked, the worker runs the base GGUF only.

---

## Dependency graph (DI)

```
IFrameMemoryService ──────────────┐
IFramePersistentMemoryService ────┤
IFrameRagService ─────────────────┼──► IFrameOrchestratorService ──► IFrameIntelligenceService
IFrameAdapterService ─────────────┘              ▲
IFrameContextService ────────────────────────────┤
IFrameRuntimeService ────────────────────────────┤
IFrameModelService ──────────────────────────────┤
IFrameInferenceRuntime ──────────────────────────┤
IFrameTrainingManager ───────────────────────────┘ (exposed on facade; not required to plan chat)
```

Registration: `services/frameAIServices.contribution.ts`  
Imported from: `browser/frameAI.contribution.ts` (already loaded by `workbench.common.main.ts`)

---

## What this milestone deliberately does not do

- Download or run Qwen / any LLM
- Open sockets to AI providers
- Change `src/vs/editor/**` or Monaco widgets for inference
- Cloud or remote embeddings (RAG is local lexical only)
- Auto-summarize chats into conversation memory (API exists; writers come later)

---

## Next recommended step

**Seed or demo a candidate preference** in Learning for empty workspaces, or wire richer diff examples into cards. When ready for a real model: implement a local runtime behind `IFrameInferenceRuntime` with **user-provided** weights.
