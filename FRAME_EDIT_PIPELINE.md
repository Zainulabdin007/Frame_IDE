# Frame Intelligent Editing Pipeline

Transforms Frame AI from chat-only into a coding assistant that **proposes workspace edits**.

**Hard rules:** no cloud APIs, no in-IDE model downloads. Edit plans prefer **model-emitted** ` ```frame-edit-plan ` JSON (`parseModelEditPlan`); if missing, heuristic recovery then deterministic **stub** plans. Users review via **Chat Apply** (non-stub) and/or the Frame sidebar **Preview Changes** (`acceptAll` / `rejectAll` / Undo).

---

## Pipeline

```
Prompt (built-in Chat)
  ↓
Context Engine
  ↓
Worker / llama.cpp (or stub if no GGUF)
  ↓
parseModelEditPlan → synthesizeRecoveredEditPlan → buildStubEditPlan
  ↓
Diff / textEdit preview
  ↓
Chat Apply  and/or  Frame sidebar Preview Changes
  ↓
Workspace Apply (frameWorkspaceEditService)
  ↓
Rollback snapshots (Undo)
```

Nothing is written to disk until the user **Accept**s.

---

## Components

| Piece | Path | Role |
|-------|------|------|
| Edit plan | `vscode/.../frameAI/runtime/frameEditPlan.ts` | create / modify / delete / rename ops; `buildStubEditPlan`; preview stats |
| Workspace edit service | `vscode/.../frameAI/editing/frameWorkspaceEditService.ts` | validate, build `ResourceEdit[]`, preview, apply, rollback, memory |
| Orchestrator | `frameOrchestratorService.ts` | After stub generation, if edit intent → `proposeStubPlan` |
| UI | `frameAIViewPane.ts` → **Preview Changes** | files, +/−, Accept / Reject / per-file / Undo |

---

## Edit plan operations

- **create** — workspace-relative path + content  
- **modify** — full proposed file contents (+ optional original snapshot)  
- **delete** — path  
- **rename** — fromPath → toPath  

Multiple operations per plan. Status: `pending` → `accepted` / `rejected` / `applied` / `failed` / `rolled_back`.

### Stub planner

Triggered when the prompt matches edit intent (`edit`, `create`, `fix`, `delete`, `rename`, …) or `FrameTaskKind.Edit`.

Typical stub ops:

1. Create `.frame/edits/stub-<ts>.md` documenting the session  
2. Optionally append a stub marker to the active file  
3. Extra create / delete / rename when keywords match  

Status string in stub content: **`MODEL_RUNTIME_NOT_CONNECTED`**.

---

## Accept / Reject

| Action | Behavior |
|--------|----------|
| **Accept** | Apply all pending ops; snapshot first |
| **Reject** | Mark all pending as rejected; no disk write |
| **Accept file** | Apply one operation |
| **Reject file** | Mark one operation rejected |
| **Undo** | Restore last apply batch from snapshots |

---

## Rollback

Before each apply batch, Frame stores path → prior content (or `missing` for new files). **Undo** restores that batch (reverse order). One rollback buffer (last apply).

---

## Memory

Each accept/reject/apply writes under:

```
.frame/memory/edits/<timestamp>-<id>.json
```

Fields: `prompt`, `planId`, `acceptedFiles`, `rejectedFiles`, `executionResult`, `taskId`.

---

## Workspace edit build

`buildWorkspaceEdit()` produces VS Code `ResourceFileEdit` entries for create / modify / delete / rename.  
**Apply** uses the file service so Frame can keep its own snapshot undo (no auto-apply via bulk edit UI).

---

## Out of scope (this milestone)

- Real model-generated diffs  
- Loading Qwen / MLX / llama.cpp weights  
- Cloud edit APIs  
- Automatic apply without Accept  

---

## Next step

Wire a future local model to emit structured edit plans (same `IFrameEditPlan` schema) instead of `buildStubEditPlan`, keeping Preview → Accept → Apply → Undo unchanged.
