# Frame Task Planning Engine

Deterministic, rule-based conversion of a user request into an executable plan.

**Hard rules:** no Qwen, no weight load, no inference, no cloud APIs.

---

## Pipeline

```
User request
  ↓
Analyze (keyword rules)
  ↓
Determine tools + files + context
  ↓
Build execution graph          (FrameTaskPlanner)
  ↓
Execute steps                  (FrameTaskExecutionService)
  ├── search / read  (tools, parallel when safe)
  ├── analyze        (deterministic notes)
  ├── edit           (stub edit plan → Preview Changes)
  └── verify
  ↓
Persist under .frame/tasks/
  ↓
Preview edits (Accept / Reject — existing pipeline)
```

---

## Components

| Piece | Path | Role |
|-------|------|------|
| Plan model | `planning/frameTaskPlan.ts` | Task → Steps → Dependencies → Expected outputs |
| Planner | `planning/frameTaskPlanner.ts` | Execution graph, tool selection, ordering, dedupe |
| Executor | `planning/frameTaskExecutor.ts` | Run steps, progress events, persistence |
| Orchestrator | `frameOrchestratorService.ts` | Runs planner for edit/planning intents |
| UI | Frame AI → **Task Timeline** | Current / completed / pending / elapsed |

### Step kinds

`read` · `search` · `analyze` · `edit` · `verify`

### Progress phases

Reading Files → Searching Workspace → Building Context → Preparing Edit Plan → Verifying → Finished

---

## Execution graph

- Steps declare `dependsOn` ids  
- Ready steps with `parallelizable: true` run together (e.g. search + listFiles)  
- Duplicate tool+args pairs are collapsed by the planner  
- Deadlocks surface as failures  

Example for “Refactor authentication”:

1. `searchWorkspace` + `grepWorkspace` + `listFiles` (parallel)  
2. `readFile` (active / related)  
3. `analyze`  
4. `edit` → stub `IFrameEditPlan`  
5. `verify` → `gitStatus` stub  

---

## Tool integration

Executor calls `IFrameToolExecutionService.executeCall` for tool-backed steps.  
Edit steps call `IFrameWorkspaceEditService.proposeStubPlan` (preview only — no auto-apply).

---

## Persistence

```
.frame/tasks/task-<timestamp>-<id>.json
```

Full plan snapshot after build and after each terminal state.

---

## Future model integration

When a local model is available:

1. Model may propose a structured plan matching `IFrameExecutionPlan`  
2. Same executor / timeline / edit preview remain  
3. Rule-based planner stays as a fallback and safety net  

---

## Next step

Add user-editable plan review (reorder / skip steps) before execution starts.
