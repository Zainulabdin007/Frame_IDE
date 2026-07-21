# Frame Model Worker Architecture

Isolated local model execution boundary for Frame Intelligence.

**Hard rules:** no model downloads, no weight load in the IDE process, no inference yet, no cloud APIs.

---

## Why model execution is isolated

The VS Code / Electron **IDE process** (especially the renderer) owns UI, context, RAG, and orchestration. It must **never** directly execute model inference or map multi‑GB weights.

Models run in an **isolated Node/Electron child process**. If the worker crashes, the IDE stays up.

```
Frame IDE Process
        │
Worker Manager  (start / stop / IPC / pid)
        │
Node child_process.fork
        │
Frame Model Worker  (tools/frame-model-worker/frameModelWorkerMain.mjs)
        │
Future: llama.cpp / MLX runtime (inside worker only)
```

---

## IDE and worker separation

| Process | Owns | Must not own |
|---------|------|----------------|
| **IDE / renderer** | UI, orchestrator, context, trust checks, registry | Weight maps, llama.cpp, MLX, GPU kernels |
| **Model worker child** | Future native backends, future weight maps | Frame UI / editor state |

**Why weights never live in the renderer:** Electron renderer crashes and memory pressure take down the whole window. Native inference libs are unsafe and oversized for that process. Checksums and Ed25519 verification stay in the IDE; loading (when implemented) happens only after the worker receives `initialize` with a user-owned `modelPath`.

---

## Real worker lifecycle

| Status | Meaning |
|--------|---------|
| **STOPPED** | No child process · Process: Stopped |
| **STARTING** | `fork()` in progress |
| **READY** | IPC online · Process: Running · PID shown · Model: Not Loaded · Inference: Disabled |
| **STOPPING** | Shutdown sent / waiting for exit |
| **ERROR** | Spawn failure or unexpected exit |

Transitions:

```
start() → STARTING → (worker online) → READY
stop()  → STOPPING → (process exited) → STOPPED
crash   → ERROR (cleanup + restart() supported)
```

Manager APIs: `start()`, `stop()`, `restart()`, `sendMessage()`, `health()` (includes `pid`).

---

## Protocol

### IDE → Worker

```json
{ "type": "initialize", "modelId": "…", "modelPath": null, "adapters": { } }
{ "type": "generate", "requestId": "…", "context": { } }
{ "type": "shutdown" }
```

### Worker → IDE

```json
{ "type": "ready" }
{ "type": "response", "requestId": "…", "text": "…", "status": "MODEL_RUNTIME_NOT_CONNECTED" }
{ "type": "error", "message": "…" }
```

`generate` returns **`MODEL_RUNTIME_NOT_CONNECTED`**. No weights are loaded.

---

## Future ownership

### llama.cpp

- Child process owns the llama.cpp binding and GGUF mapping.
- IDE only sends `initialize` / `generate` over IPC after local trust checks.

### MLX

- Same boundary on Apple Silicon: MLX stays in the worker process.
- IDE selects `runtime: mlx` and passes user `modelPath` + adapters — never loads tensors itself.

---

## Smoke test

```bash
node tools/frame-model-worker/smoke-test.mjs
```

Flow: start worker → initialize → ready → shutdown → clean exit.

---

## Related code

| File | Role |
|------|------|
| `tools/frame-model-worker/frameModelWorkerMain.mjs` | Child process entry |
| `runtime/worker/frameModelWorkerProcessHost.ts` | `child_process.fork` + IPC |
| `runtime/worker/frameModelWorkerManager.ts` | Lifecycle / crash handling |
| `runtime/worker/frameModelWorker.ts` | Protocol handler (fallback mirror) |
| `runtime/worker/frameModelWorkerProtocol.ts` | Message contracts |

---

## What this milestone does **not** do

- Download models
- Load weights
- Run llama.cpp / MLX / Qwen
- Call cloud AI APIs
- Enable inference (`Inference: Disabled`)
