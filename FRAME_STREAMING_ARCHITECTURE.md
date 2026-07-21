# Frame Streaming Architecture

End-to-end **message-passing** pipeline for Frame Intelligence.

**Hard rules:** no model downloads, no weight load, no llama.cpp / MLX / Qwen inference, no cloud APIs.

This document describes how subsystems talk exactly as they will once a real runtime exists — today every `generate` returns stub stream tokens and `MODEL_RUNTIME_NOT_CONNECTED`.

---

## Pipeline

```
Frame AI UI
    ↓  submitChat / stream tokens / cancel
Orchestrator
    ↓  build context
Context Engine (+ RAG, memory, adapters)
    ↓
Runtime Bridge  (session + streamGenerate)
    ↓
Local Executor
    ↓
Worker Manager  (request ids, timeouts, pending map)
    ↓  IPC
Worker Process  (child_process stub)
    ↓  streamStart → streamToken* → streamEnd
Worker Manager
    ↓
Runtime Bridge / Runtime Service (onDidStreamToken)
    ↓
UI (live ▌ cursor) + chat memory + generation logs
```

---

## Streaming protocol

### IDE → Worker

| type | purpose |
|------|---------|
| `initialize` | Bind model metadata (path not loaded) |
| `generate` | Start stub stream for `requestId` |
| `cancel` | Abort in-flight `requestId` |
| `health` | Liveness probe |
| `shutdown` | Stop process |

### Worker → IDE

| type | purpose |
|------|---------|
| `ready` | Process / init online |
| `streamStart` | Stream begins |
| `streamToken` | One stub chunk (`"This "`, `"is "`, …) |
| `streamEnd` | Final text + status |
| `response` | Compatibility envelope |
| `error` | Protocol / process error |
| `health` | Health ack |

Stub status: **`MODEL_RUNTIME_NOT_CONNECTED`**.

---

## Worker lifecycle

`STOPPED → STARTING → READY → STOPPING → STOPPED` (or `ERROR` on crash).

Manager supports multi-request maps, timeouts, pending cleanup, and optional restart after unexpected exit.

---

## Request lifecycle

1. UI sends prompt → Orchestrator allocates `taskId`
2. Context Engine assembles `IFrameInferenceContext`
3. Executor / manager allocates `requestId`, sends `generate`
4. Worker emits `streamStart` + tokens + `streamEnd`
5. UI paints tokens with `▌`
6. On complete: generation tracker, `.frame/memory/chat/`, `.frame/logs/`

Cancel: UI → `cancelTask` → `AbortSignal` → manager `cancel(requestId)` → worker `cancel`.

---

## Conversation persistence

Path: `.frame/memory/chat/<conversationId>.json`

Per turn: timestamp, prompt, response, model metadata, adapters, workspace id, worker/runtime ids.

No embeddings. No summarization.

---

## Generation diagnostics logs

Path: `.frame/logs/generation-<timestamp>-<id>.json`

Fields: context size, RAG docs, memory entries, adapters, selected model, worker id, runtime backend, duration.

---

## Runtime panel diagnostics

- Worker status / Process Running|Stopped / PID  
- Pending Requests / Active Conversation  
- Messages Sent / Received / Last Heartbeat  
- Inference: **Disabled** · Model: **Not Loaded**  

No fake GPU values.

---

## Future integrations (worker-only)

| Backend | Where it runs | IDE role |
|---------|---------------|----------|
| **llama.cpp** | Inside worker process | Trust checks + IPC `generate` / stream |
| **MLX** | Inside worker (Apple Silicon) | Same |
| **Qwen weights** | User-owned path passed in `initialize` | Never downloaded by Frame |

The IDE renderer never maps weights.

---

## Related code

- `runtime/worker/frameModelWorkerProtocol.ts`
- `tools/frame-model-worker/frameModelWorkerMain.mjs`
- `runtime/worker/frameModelWorkerManager.ts`
- `runtime/frameLocalModelExecutor.ts`
- `runtime/frameActiveInferenceRuntimeBridge.ts`
- `memory/frameChatMemoryService.ts`
- `runtime/frameGenerationLogService.ts`
- `FRAME_MODEL_WORKER_ARCHITECTURE.md`
