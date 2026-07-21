# Frame AI Architecture

Internal architecture for **Frame Intelligence** — the local-first control plane that will eventually drive Frame’s on-device coding model.

**Milestone status:** Interfaces, data models, DI services, and scaffolding only.  
**Explicitly out of scope:** Qwen, any model weights, cloud APIs, editor-core changes, inference.

**Code root:** `vscode/src/vs/workbench/contrib/frameAI/`  
**Companion docs:** `FRAME_ARCHITECTURE.md`, `FRAME_COMPONENT_MAP.md`, `FRAME_REBRAND.md`, `FRAME_ADAPTER_ARCHITECTURE.md`, `FRAME_ADAPTER_UI.md`, `FRAME_LOCAL_RUNTIME_ARCHITECTURE.md`, `FRAME_RUNTIME_UI.md`, `FRAME_MODEL_MANAGEMENT.md`, `FRAME_HARDWARE_COMPATIBILITY.md`

---

## 1. Architecture overview

Frame AI is a workbench contribution that sits **beside** the existing IDE shell. It does not fork Monaco or rewrite the editor. The Frame AI sidebar UI talks to a facade service; that facade owns orchestrator, memory, RAG, adapters, and training.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frame Workbench (VS Code)                    │
│  Editor · Explorer · Terminal · SCM · Settings · …              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│              Frame AI UI (browser/frameAIViewPane)               │
│                    IFrameIntelligenceService                     │
└───────┬───────────┬───────────┬───────────┬───────────┬─────────┘
        │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼
   Orchestrator   Memory       RAG      Adapters    Training
        │           │           │           │           │
        └───────────┴─────┬─────┴───────────┴───────────┘
                          │
                          ▼
              Local Model Runtime (FUTURE)
                   e.g. Qwen via MLX / llama.cpp
                   NOT PRESENT IN THIS MILESTONE
```

### Package layout

```
frameAI/
├── browser/          # Sidebar UI (existing)
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
Frame UI  (Frame AI sidebar)
  │  submitChat / submitTask
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
Local Model  ←── FUTURE SEAM (runtime: 'none' today)
  │
  ▼
Orchestrator result → UI (status / eventual assistant text)
```

**Today:** the orchestrator returns `AwaitingModel` with a human-readable note. No tokens are generated.

**Tomorrow:** the same `IFrameInferenceContext` is passed to a local runtime; the UI does not need to know which backend produced the text.

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

## 6. How LoRA adapters will eventually work

See `FRAME_ADAPTER_ARCHITECTURE.md` for storage, compatibility, and import/export.

```
Approved preferences / curated examples
        │
        ▼
Training Manager  (scaffold — no workers yet)
        │
        ▼
Local trainer (FUTURE) → writes real weights under .frame/adapters/<id>/
        │
        ▼
IFrameAdapterService.setAdapterState(id, Active)
        │
        ▼
Context Engine selects language / project / user adapters
        │
        ▼
Local runtime applies LoRA on base model (FUTURE)
```

Until training and runtime exist, `IFrameAdapterService` is a **lifecycle + metadata registry** only (placeholder `LoRA.*` files, no weights).

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
