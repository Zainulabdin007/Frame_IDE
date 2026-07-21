# Frame Context Engine

Prepares everything a future local coding model needs **before** generation.

No model. No cloud APIs. No inference. Local gathering only.

## Purpose

`FrameContextService` turns a user action into an `IFrameInferenceContext` that can later be passed directly into a local runtime (e.g. Qwen).

## Pipeline

```
User action
    │
    ▼
Context gathering          ← active file, selection, cursor, open editors
    │
    ▼
RAG retrieval              ← related files, functions/classes, documentation
    │
    ▼
Memory retrieval           ← decisions, preferences, prior conversations
    │
    ▼
Adapter selection          ← available + active language / project / user adapters
    │
    ▼
IFrameInferenceContext     ← ready for a future local model (not attached)
```

## Integration with the orchestrator

```
Frame AI UI
    │
    ▼
IFrameOrchestratorService.submitTask(request)
    │
    ├─ FrameTaskKind.Index → rag.reindex() (no context build)
    │
    └─ otherwise
           │
           ▼
      IFrameContextService.build({ taskId, request, sessionId, … })
           │
           ▼
      cache IFrameInferenceContext
           │
           ▼
      FrameTaskStatus.AwaitingModel
      (message summarizes context — still no generation)
```

`buildInferenceContext(taskId)` returns the cached context (or rebuilds if needed).

## Inputs

`IFrameContextBuildRequest`:

| Field | Source |
| --- | --- |
| `taskId` | Orchestrator |
| `request` | User prompt (“Refactor this function”) |
| `sessionId` | Optional chat session |
| `activeUri` / `selectionText` | Optional overrides from the task |
| `workspaceFolders` | Open workspace roots |

Live editor state fills gaps when overrides are absent.

## What is collected

### 1. User request

`context.request` — the raw prompt string.

### 2. Editor context

From `ICodeEditorService` + `IEditorService`:

- `activeFile` / `activeRelativePath` / `languageId`
- `selectedCode`
- `cursor` (`lineNumber`, `column`)
- `openFiles` (MRU editors, capped)

### 3. RAG context

Via `IFrameRagService.query`:

- `relatedFiles` — ranked paths
- `relatedChunks` — code functions/classes/blocks
- `documentationChunks` — README / docs / markdown (with a secondary doc-oriented query when needed)

### 4. Memory context

Via `IFrameMemoryService.query`:

- `preferences` — user-scope entries tagged `preference` (plus key heuristics)
- `memories` — workspace `decision` tags, session text matches, session id entries

### 5. Adapter context

Via `IFrameAdapterService` (see `FRAME_ADAPTER_ARCHITECTURE.md`):

```ts
adapters: {
  available: [...],        // all discovered / registered
  active: [...],           // state === Active
  languageAdapter?: ...,   // scope language (or tags) + language id
  projectAdapter?: ...,    // scope project
  userAdapter?: ...,       // scope user / style / personal
}
```

## Output shape

`IFrameInferenceContext` (simplified):

```json
{
  "taskId": "...",
  "request": "Refactor this function",
  "workspace": { "folders": ["file:///..."], "name": "MyApp" },
  "activeFile": "file:///.../src/auth.ts",
  "selectedCode": "function login() { ... }",
  "cursor": { "lineNumber": 42, "column": 8 },
  "openFiles": [{ "uri": "...", "relativePath": "src/auth.ts", "isActive": true }],
  "relatedFiles": ["src/auth.ts", "src/session.ts"],
  "relatedChunks": [/* ranked code chunks */],
  "documentationChunks": [/* README / docs */],
  "memories": [/* decisions + conversations */],
  "preferences": [/* user prefs */],
  "adapters": {
    "available": [],
    "active": [],
    "languageAdapter": null,
    "projectAdapter": null,
    "userAdapter": null
  },
  "systemPrompt": "Frame local coding assistant ...",
  "messages": [],
  "builtAt": 0
}
```

Legacy aliases (`memory`, `rag`, `files`, `activeAdapters`) remain for older callers.

## Source files

| Path | Role |
| --- | --- |
| `context/frameContext.ts` | `IFrameContextService` contract |
| `context/frameContextService.ts` | Context Engine implementation |
| `common/models.ts` | `IFrameInferenceContext` + build request types |
| `orchestrator/frameOrchestratorService.ts` | Delegates to Context Engine |

## Privacy

- All I/O is local (filesystem index + in-memory memory/adapters)
- Nothing is uploaded
- Status stays `AwaitingModel` — no generation in this milestone

## Future (not this milestone)

1. Pass `IFrameInferenceContext` into a local Qwen (or other) runtime
2. Persist/hydrate memory so preferences and decisions survive restarts
3. Register real language/user LoRA adapters and load weights beside the base model
4. Optionally stream a rendered prompt preview in the Frame AI panel
