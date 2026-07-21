# Frame Preference Learning

Preference Observation Engine for Frame Intelligence.

**This milestone records signals and proposes preferences.**  
It does **not** train models, create LoRA files, download Qwen, or auto-apply style changes.

## Purpose

Capture coding behavior that will later become on-device training data:

- what the model generated
- what the user accepted / rejected
- how the user edited or reverted code

## Observation lifecycle

```
Coding event
    │
    ▼
recordObservation({ before, after, changeType, … })
    │
    ▼
Stored in .frame/memory/observations.jsonl
    │
    ▼
PreferenceAnalyzer (heuristics)
    │
    ▼
CandidatePreference lifecycle:

  Observed  →  Candidate  →  Confirmed  →  Active
                                │
                                └── reject → Rejected
```

| State | Meaning |
| --- | --- |
| **Observed** | Signal seen (often once) |
| **Candidate** | Repeated + confidence threshold — **not applied** |
| **Confirmed** | User approved via `approvePreference` |
| **Active** | Written into `.frame/memory/preferences.json` for Context Engine |
| **Rejected** | User rejected — kept as negative signal only |

Preferences are **never** auto-activated. User approval is required.

## Observation schema

```json
{
  "id": "...",
  "timestamp": 0,
  "project": "MyApp",
  "language": "typescript",
  "file": "src/util.ts",
  "before": "for (let i = 0; i < items.length; i++) { ... }",
  "after": "for (const item of items) { ... }",
  "changeType": "manualModification",
  "confidence": 0.7,
  "sessionId": "...",
  "signalIds": ["iteration.foreach"]
}
```

`changeType`: `generated` | `accepted` | `rejected` | `edited` | `reverted` | `manualModification`

## Preference extraction

`PreferenceAnalyzer` inspects before/after pairs with **local heuristics** (no ML):

| Signal | Example transform | Candidate text |
| --- | --- | --- |
| `iteration.foreach` | classic `for` → `for-of` / `forEach` | Prefers collection iteration |
| `quotes.single` | `"` → `'` | Prefers single quotes |
| `quotes.double` | `'` → `"` | Prefers double quotes |
| `bindings.const` | `var` → `const`/`let` | Prefers const/let over var |
| `style.early_return` | nested `if` → early `return` | Prefers early returns |
| `style.trailing_comma` | add trailing commas | Prefers trailing commas |
| `style.semicolons` / `no_semicolons` | semicolon delta | Semicolon preference |

Repeated hits for the same `signalId` + language promote **Observed → Candidate**.

## Confidence scoring

Approximate formula:

```
confidence =
  analyzer_base
  + min(0.25, (observationCount - 1) * 0.08)
  + (distinctSessions >= 2 ? 0.10 : 0)
  + (accepted/manualModification ? 0.05 : 0)
  - (rejected/reverted ? 0.15 : 0)
```

Clamped to `[0, 1]`.

Promotion to **Candidate** requires:

- ≥ 2 observations
- confidence ≥ 0.45

Promotion to **Confirmed / Active** requires **`approvePreference()`** only.

## API

`IFrameObservationService`:

| Method | Role |
| --- | --- |
| `recordObservation(input)` | Save signal + run analyzer |
| `getCandidatePreferences()` | List Observed/Candidate/Confirmed |
| `approvePreference(id)` | Confirm → Active + persist preference |
| `rejectPreference(id)` | Mark Rejected |
| `reanalyze()` | Rebuild candidates from stored observations |
| `listObservations()` | Inspect raw signals |

Facade: `IFrameIntelligenceService.observations`

## Storage

Under `<workspace>/.frame/memory/`:

| File | Contents |
| --- | --- |
| `observations.jsonl` | Raw observations |
| `candidate-preferences.json` | Lifecycle-tracked candidates |
| `preferences.json` | **Active** confirmed preferences (Context Engine / memory) |

`approvePreference` calls `IFramePersistentMemoryService.savePreference`, which writes `preferences.json`.

## Privacy

- Local disk only (gitignored via `.frame/.gitignore`)
- No cloud upload of before/after snippets
- No automatic code mutation from candidates
- Rejected preferences stay local as training-negative signals

## Future LoRA training usage

When a local training pipeline exists:

1. Export `observations.jsonl` + active / rejected preferences
2. Build (before → after) pairs weighted by `changeType` and `confidence`
3. Fine-tune a user/style LoRA **on device**
4. Register via `IFrameAdapterService`

Until then: observation + approval only.

## Source files

| Path | Role |
| --- | --- |
| `preferences/frameObservation.ts` | Service contract |
| `preferences/frameObservationService.ts` | Observation + lifecycle |
| `preferences/preferenceAnalyzer.ts` | Heuristic extractor |
| `common/models.ts` | Observation / candidate types |
| `memory/memoryDiskStore.ts` | Writes `preferences.json` |
