# Frame Memory Persistence

Durable local memory for Frame Intelligence. Survives IDE restarts. Never leaves the machine.

**Location:** `<workspace>/.frame/memory/`  
**Format:** JSON + JSONL (no database server)  
**No model. No cloud.**

## Storage layout

```
<workspace>/.frame/
  .gitignore                 # "*" — keep Frame local state out of git
  memory/
    meta.json
    project.jsonl
    preferences.jsonl
    decisions.jsonl
    conversation-summaries.jsonl
  rag/                       # (separate milestone)
```

### `meta.json`

```json
{
  "version": 1,
  "createdAt": 0,
  "updatedAt": 0,
  "folder": "file:///...",
  "counts": {
    "project": 0,
    "preferences": 0,
    "decisions": 0,
    "conversationSummaries": 0
  }
}
```

## Memory kinds

### 1. Project memory (`project.jsonl`)

Architecture, technology choices, conventions, project info.

```json
{
  "id": "...",
  "kind": "project",
  "title": "API layer",
  "content": "HTTP handlers live under src/api; no business logic in controllers.",
  "category": "architecture",
  "relatedFiles": ["src/api/"],
  "tags": ["architecture"],
  "createdAt": 0,
  "updatedAt": 0
}
```

`category`: `info` | `architecture` | `technology` | `convention`

### 2. User preferences (`preferences.json`)

Canonical JSON array (also mirrored to `preferences.jsonl` for compatibility).

Coding / formatting / library / style preferences with observation metadata (for future LoRA training).

```json
{
  "id": "...",
  "kind": "preference",
  "preference": "Prefer early returns over nested ifs",
  "language": "typescript",
  "confidence": 0.8,
  "observations": 12,
  "accepted": 10,
  "rejected": 2,
  "tags": ["style"],
  "createdAt": 0,
  "updatedAt": 0
}
```

### 3. Decision memory (`decisions.jsonl`)

Explicit user decisions.

```json
{
  "id": "...",
  "kind": "decision",
  "decision": "Use PostgreSQL instead of MongoDB",
  "rationale": "Stronger relational constraints for billing.",
  "relatedFiles": ["docs/architecture.md"],
  "tags": ["database"],
  "createdAt": 0,
  "updatedAt": 0
}
```

### 4. Conversation summaries (`conversation-summaries.jsonl`)

**Compressed summaries only — never raw chat transcripts.**

```json
{
  "id": "...",
  "kind": "conversationSummary",
  "topic": "Auth refactor",
  "summary": "User asked to extract JWT validation into middleware; focused on auth.ts and session.ts.",
  "relatedFiles": ["src/auth.ts", "src/session.ts"],
  "sessionId": "optional-session-id",
  "createdAt": 0,
  "updatedAt": 0
}
```

## Service API

`IFramePersistentMemoryService` / `FramePersistentMemoryService`:

| Method | Purpose |
| --- | --- |
| `load` / `save` | Read / write `.frame/memory/` |
| `saveProject` / `savePreference` / `saveDecision` / `saveConversationSummary` | Create or replace |
| `update` | Patch by id |
| `search` | Filter by kind, text, language, tags, session |
| `delete` | Remove one record |
| `list` | In-memory listing |
| `exportMemory` / `importMemory` | Portable JSON bundle (local file exchange) |

`IFrameMemoryService` remains the facade used elsewhere: durable upserts write through to disk; session scratch stays ephemeral.

## Lifecycle

```
IDE start
   │
   ▼
PersistentMemoryService.load()
   │  read .frame/memory/*.jsonl
   ▼
In-memory map
   │
   ├─ Context Engine.search(...)  → IFrameInferenceContext.memories / preferences
   │
   ├─ save* / update / delete
   │     │
   │     ▼
   │  write to .frame/memory/
   │
   └─ export / import (manual backup / restore)
```

Ephemeral session notes (`FrameMemoryScope.Session` without durable tags) are **not** written to disk unless tagged as a conversation summary.

## Context Engine integration

`FrameContextService.collectMemoryContext`:

1. `load()` durable store  
2. Search preferences, decisions, project facts, conversation summaries (text-ranked against the user request)  
3. Map records → `IFrameMemoryEntry`  
4. Fill `IFrameInferenceContext.preferences` and `.memories`

## Privacy guarantees

| Rule | Enforcement |
| --- | --- |
| Local only | Files under workspace `.frame/` via `IFileService` |
| No cloud sync | No upload / SaaS clients in this stack |
| No raw chat logs | Only `conversationSummary` records |
| Gitignored | `.frame/.gitignore` contains `*` |
| Export is user-driven | `exportMemory` returns a local JSON object — caller decides where to write |

## Future LoRA training usage

Preference metadata (`confidence`, `observations`, `accepted`, `rejected`) is designed as a local training signal:

1. When the user accepts/rejects an edit, bump `accepted` / `rejected` / `observations` and adjust `confidence`
2. Export preference + decision corpora as on-device fine-tuning examples
3. Train a user / language LoRA offline
4. Register the adapter via `IFrameAdapterService` — weights stay on disk

No training runs in this milestone.

## Source files

| Path | Role |
| --- | --- |
| `memory/persistentMemory.ts` | Service contract |
| `memory/persistentMemoryService.ts` | Implementation |
| `memory/memoryDiskStore.ts` | `.frame/memory/` I/O |
| `memory/frameMemoryService.ts` | Facade + ephemeral session + write-through |
| `context/frameContextService.ts` | Retrieves persistent memory into inference context |
