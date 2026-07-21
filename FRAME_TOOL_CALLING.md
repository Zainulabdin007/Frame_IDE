# Frame Tool Calling Architecture

Worker ↔ IDE tool round-trips for Frame Intelligence.

**Hard rules:** no Qwen connection, no weight load, no inference, no cloud APIs. The worker remains a **stub** that simulates tool use.

---

## Lifecycle

```
generate
  ↓
Worker emits toolRequest          (e.g. readFile)
  ↓
Orchestrator / Runtime validates  (path + permission)
  ↓
IDE Tool Execution                (FrameToolExecutionService)
  ↓
toolResult posted to Worker
  ↓
Worker may emit another toolRequest (e.g. searchWorkspace)
  ↓
…
  ↓
streamEnd / final response
```

Nothing is inferred — the stub worker always runs:

`readFile` → `searchWorkspace` → final stub tokens.

---

## Components

| Piece | Path | Role |
|-------|------|------|
| Contracts | `runtime/tools/frameTools.ts` | `IFrameTool`, `IFrameToolCall`, `IFrameToolResult` |
| Registry | `runtime/tools/frameToolRegistry.ts` | `register` / `lookup` / `execute` / permissions |
| Execution | `runtime/tools/frameToolExecutionService.ts` | validate, block escape, run tools, activity feed |
| Implementations | `runtime/tools/frameToolImplementations.ts` | Built-in IDE tools |
| Diagnostics | `runtime/tools/frameToolLogService.ts` | `.frame/logs/tools/` |
| Protocol | `runtime/worker/frameModelWorkerProtocol.ts` | `toolRequest` / `toolResult` |
| Bridge | `runtime/frameRuntimeService.ts` | Mid-generation round-trips |
| Stub worker | `tools/frame-model-worker/frameModelWorkerMain.mjs` | Simulated tool loop |
| UI | Frame AI → **Tool Activity** | Current + recent calls |

---

## Tool names

`readFile` · `writeFile` · `searchWorkspace` · `grepWorkspace` · `listFiles` · `renameSymbol` · `formatDocument` · `gitStatus` · `gitDiff` · `terminalRun` · `taskRun`

### Permissions

| Permission | Tools | Default |
|------------|-------|---------|
| `read` | readFile, listFiles | enabled |
| `write` | writeFile | enabled |
| `search` | searchWorkspace, grepWorkspace | enabled |
| `refactor` | renameSymbol, formatDocument | enabled (stub) |
| `git` | gitStatus, gitDiff | enabled (stub, no shell) |
| `execute` | terminalRun, taskRun | **disabled** |

---

## Security & validation

Before every execute:

1. Tool name must be registered  
2. Permission gate must allow the tool  
3. Paths must be workspace-relative  
4. Reject `..`, absolute paths, and drive-letter escapes  
5. Resolve only via `joinPath(workspaceFolder, relative)`

`terminalRun` / `taskRun` stay disabled so the stub cannot spawn arbitrary shells.

---

## Protocol

### Worker → IDE

```json
{
  "type": "toolRequest",
  "requestId": "…",
  "callId": "stub-call-1",
  "tool": "readFile",
  "args": { "path": "README.md" }
}
```

### IDE → Worker

```json
{
  "type": "toolResult",
  "requestId": "…",
  "callId": "stub-call-1",
  "success": true,
  "data": { "path": "README.md", "content": "…" }
}
```

`toolRequest` is mid-flight (like `streamToken`) — it does **not** complete the generate waiter. Only `streamEnd` / `response` / `error` do.

---

## Diagnostics

Every invocation is logged under:

```
.frame/logs/tools/tool-<timestamp>-<callId>.json
```

Fields: tool, arguments, duration, success/error, conversation, worker, requestId, callId.

---

## Future MCP compatibility

Frame tools map cleanly to MCP-style tool descriptors:

- `name` + `description` + JSON args  
- Host (IDE) executes; model/worker only proposes  

A future MCP bridge can wrap `FrameToolRegistry.list()` as MCP tools without changing the worker protocol.

---

## Future Qwen integration

When a local model is connected:

1. Worker loads weights (still isolated process)  
2. Model emits structured tool calls → same `toolRequest` messages  
3. IDE execution + `toolResult` loop unchanged  
4. Model continues until it produces a final answer → `streamEnd`

The stub loop is the contract rehearsal for that path.

---

## Next step

Add structured tool schemas (JSON Schema per tool) and optional user confirmation for `write` / `execute` permissions before enabling shell tools.
