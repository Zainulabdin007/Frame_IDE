# Frame llama.cpp Runtime

Local GGUF inference inside the isolated Frame model worker via **node-llama-cpp**.

**Hard rules:** no cloud APIs, no model downloads. The user supplies a `.gguf` path.

The IDE process, runtime bridge, worker protocol, orchestrator, and context engine are **unchanged**. Only the worker’s `generate` handler runs real inference when a model is loaded.

---

## Architecture

```
Frame IDE
  → Runtime Bridge
  → Worker Manager (child_process.fork)
  → frameModelWorkerMain.mjs
  → frameModelLoader.mjs  (node-llama-cpp + Metal)
  → frameInferenceEngine.mjs (streaming prompt)
  → IPC streamToken / streamEnd
  → Frame AI Chat UI
```

---

## Packages

Under `tools/frame-model-worker/`:

| File | Role |
|------|------|
| `frameModelLoader.mjs` | `loadModel` / `unloadModel` |
| `frameContextMapper.mjs` | `IFrameInferenceContext` → system + user prompts |
| `frameInferenceEngine.mjs` | Streaming `session.prompt` |
| `frameModelWorkerMain.mjs` | Protocol entry (`initialize` / `generate` / `shutdown`) |
| `smoke-test.mjs` | Optional GGUF smoke test |

Install:

```bash
cd tools/frame-model-worker
npm install
```

---

## Metal acceleration

`node-llama-cpp` enables **Metal** automatically on Apple Silicon (`gpu: "auto"`).

On load the worker logs:

```
[Frame Worker] Metal GPU: true|false
[Frame Worker] GPU backend: metal|… gpuLayers: N
```

If Metal init fails, the loader falls back to CPU.

---

## GGUF requirements

- Local file ending in `.gguf`
- Instruction-tuned chat models recommended (e.g. Qwen2.5-Coder Instruct Q4_K_M)
- Path must be readable by the worker process

Frame never downloads weights.

---

## Runtime configuration

Workspace file:

```json
{
  "runtime": "llamacpp",
  "activeModelId": "qwen-coder-7b-q4",
  "modelPath": "/absolute/path/to/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
  "enabled": true
}
```

Location: `.frame/config/runtime.json`

If `modelPath` is null or missing:

- Worker still starts
- `generate` returns existing `MODEL_RUNTIME_NOT_CONNECTED` stub stream
- IDE does not crash

---

## Context mapping

`frameContextMapper.mjs` builds:

**System prompt**

- Frame identity
- Active preferences
- Project memory
- Active adapters
- Knowledge-graph symbols
- RAG code chunks (truncated)

**User prompt**

- Recent chat turns
- Active file / selection
- User request

Budgets keep prompts inside a practical context window.

---

## Streaming protocol

Unchanged IPC messages:

1. `streamStart`
2. `streamToken` (per llama.cpp text chunk)
3. `streamEnd` / `response`
4. `error` on failure

Cancel sets an abort signal mid-generation.

---

## Memory management

On `shutdown`:

1. Abort active generations
2. `session.dispose` / `context.dispose` / `model.dispose`
3. Log `Model memory released`
4. Exit process

Worker crashes are isolated — Worker Manager restarts; IDE stays up.

---

## Smoke test

Protocol / stub (no weights):

```bash
cd tools/frame-model-worker
node smoke-test.mjs
```

Prints `SKIP: Set FRAME_MODEL_PATH to run inference smoke test`, then runs the stub protocol check.

Real inference:

```bash
FRAME_MODEL_PATH=/absolute/path/to/model.gguf node smoke-test.mjs
```

Flow: start → initialize (load GGUF) → generate (“Write a hello world function in Python”) → collect tokens → shutdown → clean exit.

---

## Next step

Point `.frame/config/runtime.json` at your GGUF, open **built-in Chat**, and send a message — tokens stream through the existing IPC path. Configure models / adapters in the **Frame** sidebar (control plane). See `FRAME_ROADMAP.md`.
