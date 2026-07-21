# Frame Editor Signal Integration

Connects Frame-generated code to the Preference Observation Engine.

**Scope:** only interactions with Frame-produced generations.  
**Not in scope:** arbitrary typing, unrelated edits, cloud telemetry, model training.

## Pipeline

```
Frame runtime output
        │
        ▼
FrameGenerationTracker.trackGeneration()
  (temporary: generationId, content, file, language, project, timestamp)
        │
        ├─ User Accept into editor
        │     → insert at cursor
        │     → watch ONLY that range
        │     → recordObservation(accepted_generation)
        │
        ├─ User edits inside watched range
        │     → recordObservation(edited_generation)  { before, after, diffSummary }
        │     → unrelated edits elsewhere are ignored
        │
        └─ User Discard
              → recordObservation(rejected_generation)
              → stop watching (does not delete already-inserted text)
```

Approved preferences (separate Preference Observation lifecycle) continue to load through Persistent Memory into `FrameContextService` → `IFrameInferenceContext.preferences`.

## Tracked events

| Event | Source | Observation type | Notes |
| --- | --- | --- | --- |
| Generation produced | Orchestrator after runtime `generate` | *(none yet)* | Stored only in tracker memory |
| Accept into editor | UI / `acceptGeneration` | `accepted_generation` | Inserts text; starts range watch |
| In-range edit | Model `onDidChangeContent` if intersects tracked range | `edited_generation` | Includes before/after + diff summary |
| Discard | UI / `rejectGeneration` | `rejected_generation` | Pending or stop-watch |

### Temporary generation record

```json
{
  "generationId": "...",
  "file": "src/util.ts",
  "language": "typescript",
  "content": "...",
  "timestamp": 0,
  "project": "MyApp",
  "status": "pending"
}
```

Statuses: `pending` → `inserted` / `accepted` / `edited` / `rejected` / `expired`

## Privacy boundaries

| Rule | Enforcement |
| --- | --- |
| No global keystroke logging | Model listeners attach **only** after Accept, and only for that generation’s URI |
| No unrelated edits | Change events must intersect the tracked Range |
| No cloud / telemetry | Observations stay under `.frame/memory/observations.jsonl` |
| No silent buffer deletion on Discard | Reject stops watching; does not undo user text |

## Observation lifecycle (editor path)

```
trackGeneration (pending)
        │
   Accept ──────────────► accepted_generation
        │                         │
        │                         ▼
        │                  watch in-range edits
        │                         │
        │                         ▼
        │                  edited_generation (0..n)
        │
   Discard ─────────────► rejected_generation
```

Preference Analyzer may extract candidates from `edited_generation` before/after pairs (e.g. quote style). Candidates still require explicit `approvePreference` before becoming Active in `preferences.json`.

## API

`IFrameGenerationTracker`:

- `trackGeneration(input)`
- `acceptGeneration(generationId)`
- `rejectGeneration(generationId)`
- `getGeneration` / `listGenerations`

Facade: `IFrameIntelligenceService.generations`

UI: Frame AI panel shows **Accept into editor** / **Discard** on assistant replies that include a `generationId`.

## Source files

| Path | Role |
| --- | --- |
| `preferences/frameGenerationTracker.ts` | Contract |
| `preferences/frameGenerationTrackerService.ts` | Tracker + scoped editor watches |
| `orchestrator/frameOrchestratorService.ts` | Calls `trackGeneration` after output |
| `browser/frameAIViewPane.ts` | Accept / Discard actions |

## What this does not do

- Train LoRA / download models
- Capture all typing
- Log non-Frame edits
- Send data off-device
