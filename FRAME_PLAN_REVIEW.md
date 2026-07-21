# Frame Interactive Plan Review

Deterministic task plans are shown for **human review before any execution**.

**Hard rules:** no Qwen, no weight load, no inference, no cloud APIs.

---

## Pipeline

```
Task Plan (rule-based)
  ↓
Plan Review UI
  ↓
User changes (reorder / enable / rename / notes)
  ↓
Approve  →  Final Plan  →  Execution
Reject   →  Cancel (no tools / no edits)
```

Execution never starts until **Approve**.

---

## Features

| Action | Behavior |
|--------|----------|
| Reorder | Drag-and-drop steps; dependencies rewritten linearly |
| Disable / Enable | Checkbox — disabled steps dropped on approve |
| Rename | Inline title edit |
| Notes | Per-step textarea persisted on the plan |
| Approve | `finalizePlanForExecution` → `executePlan` |
| Reject | Cancel orchestration; no side effects |
| Save plan | Write reusable JSON under `.frame/plans/` |

---

## Components

| Piece | Path |
|-------|------|
| Review service | `planning/framePlanReviewService.ts` |
| Plan model | `planning/frameTaskPlan.ts` (`enabled`, `notes`, `awaiting_review`) |
| Executor | `executePlan` only after approval |
| Orchestrator | `buildPlan` → `beginReview` → `executePlan` |
| UI | Frame AI → **Execution Plan Review** |

---

## Persistence

### Task runs

`.frame/tasks/task-*.json` — execution snapshots (existing)

### Reusable plans

`.frame/plans/<name>-<id>.json`

```json
{
  "id": "…",
  "name": "Refactor authentication",
  "prompt": "…",
  "steps": [ … ],
  "summary": "…",
  "createdAt": 0,
  "updatedAt": 0
}
```

---

## Future model integration

A local model may propose the initial plan graph; review + approve remains mandatory. The deterministic planner stays the fallback.

---

## Next step

Load saved reusable plans into the review UI as templates for similar prompts.
