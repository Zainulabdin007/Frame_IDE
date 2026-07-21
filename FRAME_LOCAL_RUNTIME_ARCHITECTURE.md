# Frame Local Runtime Architecture

Local-only inference seam for Frame Intelligence.

**Hard rules:** no model downloads, no cloud APIs, no OpenAI/Anthropic, no external inference services, no LoRA training in this layer.

Weights are **user-owned**: Frame only loads paths the user configures under `.frame/config/runtime.json`.

## Runtime boundary

```
User
  │
Frame AI UI
  │
Orchestrator
  │
Context Engine  →  IFrameInferenceContext
  │                 (prompt, files, RAG, memory, preferences, adapters)
  │
IFrameRuntimeService.generate(context)
  │
  ├─ select active backend metadata (stub | mlx | llamacpp)
  ├─ privacy / config
  └─ IFrameModelWorkerManager.generate(...)
           │
           ▼
     Frame Model Worker  (isolated boundary — no IDE weight load)
           │
           ▼
     IFrameInferenceResult  (placeholder until native executor)
           │
           ▼
     IFrameTaskResult.output (+ generation tracker)
```

See **[FRAME_MODEL_WORKER_ARCHITECTURE.md](./FRAME_MODEL_WORKER_ARCHITECTURE.md)** for the worker protocol (`initialize` / `generate` / `shutdown`), executor path, lifecycle UI, and future llama.cpp / MLX injection points.

Frame UI and orchestrator never call model vendors. They only talk to `IFrameRuntimeService` / `IFrameInferenceRuntime` → `IFrameModelExecutor` → worker manager.

## Interfaces

### `IFrameInferenceRuntime`

| Method | Role |
| --- | --- |
| `initialize()` | Prepare backend (no network) |
| `isAvailable()` | Machine + config can use this backend |
| `getModelInfo()` | Bound local model handle (if any) |
| `generate(context)` | → `IFrameInferenceResult` |
| `dispose()` | Unload / free resources |

Also: `id`, `kind`, `displayName`, `isReady()`, `onDidStreamToken`.

### `IFrameInferenceResult`

```ts
{
  taskId, text, runtimeId, modelInfo?,
  durationMs, placeholder, privacyValidated,
  aborted?, error?
}
```

### `IFrameRuntimeService`

| Method | Role |
| --- | --- |
| `registerRuntime` | Add a backend |
| `listRuntimes` / `getStatus` | Discovery (stub, MLX, llama.cpp, …) |
| `selectRuntime` / `updateConfig` | Choose backend + persist |
| `getActiveRuntime` | Current backend instance |
| `generate` | Delegate to active (stub fallback when disabled/unavailable) |
| `initialize` | Load `.frame/config/runtime.json` |

## Registered runtimes

| Id | Kind | Available today | Notes |
| --- | --- | --- | --- |
| `stub` | stub | **Yes** | `FrameLocalInferenceRuntime` — placeholder text, no weights |
| `mlx` | mlx | No | Placeholder until native bridge + `modelPath` |
| `llamacpp` | llamacpp | No | Placeholder until native binding + GGUF `modelPath` |

## Configuration

Path: `<workspace>/.frame/config/runtime.json`

```json
{
  "runtime": "mlx",
  "modelPath": null,
  "enabled": false
}
```

| Field | Meaning |
| --- | --- |
| `runtime` | Preferred backend (`stub` \| `mlx` \| `llamacpp`) |
| `modelPath` | User-provided local weights path — **never** auto-filled by download |
| `enabled` | When `false`, Frame stays on the stub for generation |

Defaults: `runtime: "stub"`, `modelPath: null`, `enabled: false`.

## Context integration

`generate` receives a full `IFrameInferenceContext`:

- user prompt (`request`)
- active / open / related files
- RAG chunks + documentation
- memories + preferences
- active adapters (language / project / user)

No editor-core (`src/vs/editor`) changes.

## Privacy guarantees

| Rule | Enforcement |
| --- | --- |
| Local only | Runtime implementations must not open WAN sockets |
| No cloud inference | No OpenAI / Anthropic / Copilot clients in this stack |
| No prompt telemetry | Stub (and future local backends) do not phone home |
| User-owned models | `modelPath` is explicit; Frame does not fetch weights |
| Privacy check | Stub validates `FRAME_PRIVACY_GUARANTEES` before producing text |

## Model ownership

```
User obtains weights elsewhere (HF, own training, USB, …)
        │
        ▼
User sets modelPath in .frame/config/runtime.json
        │
        ▼
User sets enabled: true and runtime: mlx | llamacpp
        │
        ▼
Future native bridge loads THAT path only
```

Frame never:

- Bundles Qwen / other weights
- Silent-downloads checkpoints
- Uploads prompts or code for inference

## Future MLX integration

Replace `FrameMlxRuntimePlaceholder` with a real `FrameMlxRuntime`:

1. `isAvailable()` → true when Apple Silicon + MLX bridge present + `modelPath` exists on disk  
2. `initialize()` → load user weights from `modelPath`  
3. `generate(context)` → map context → prompt → stream tokens → `IFrameInferenceResult`  
4. Apply active LoRA adapters from `context.adapters` when training artifacts exist  
5. Still no network

## Future llama.cpp integration

Replace `FrameLlamaCppRuntimePlaceholder` with `FrameLlamaCppRuntime`:

1. Load user-provided GGUF from `modelPath`  
2. Prefer in-process binding; localhost-only server is optional and must not egress  
3. Same `generate` / `IFrameInferenceResult` contract  
4. No auto-download of GGUF files

## Source files

| Path | Role |
| --- | --- |
| `runtime/frameInferenceRuntime.ts` | Backend contract |
| `runtime/frameRuntime.ts` | Registry service contract |
| `runtime/frameRuntimeService.ts` | Registry + config + generate |
| `runtime/frameLocalInferenceRuntime.ts` | Stub implementation |
| `runtime/frameMlxRuntimePlaceholder.ts` | MLX discovery stub |
| `runtime/frameLlamaCppRuntimePlaceholder.ts` | llama.cpp discovery stub |
| `runtime/frameActiveInferenceRuntimeBridge.ts` | DI bridge for `IFrameInferenceRuntime` |
| `orchestrator/frameOrchestratorService.ts` | Context → runtime service |
| `.frame/config/runtime.json` | Workspace runtime config |

## Swapping / enabling backends later

```ts
// Register a real implementation
runtimeService.registerRuntime(new FrameMlxRuntime(...));

// Persist user choice
await runtimeService.updateConfig({
  runtime: 'mlx',
  modelPath: '/Users/me/models/my-coder',
  enabled: true,
});
```

Orchestrator and UI stay unchanged.
