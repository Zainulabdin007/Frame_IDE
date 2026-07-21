# Frame Runtime Status UI

User-facing visibility and configuration for the local AI runtime.

**This milestone does not:** download models, load Qwen, run inference, or call cloud APIs.

## Purpose

Show what Frame would use for local inference and let users edit `.frame/config/runtime.json` from the sidebar — without loading weights.

## UI structure

Frame AI sidebar:

```
Welcome
Learning
Runtime          ← this milestone
  Summary (active backend / status / model)
  Privacy
  Details card
  Available runtimes
  Configuration (enable · backend · model path)
Adapters
Chat
Composer
```

### Summary

| Field | Example |
| --- | --- |
| Active backend | `llama.cpp` / `MLX` / `Frame Local Stub` |
| Status | Enabled / Disabled / Unavailable |
| Model | `~/Models/qwen.gguf` or `None` |

### Privacy block

Always shown:

- Local only
- No network
- No telemetry

### Details card

| Field | Source |
| --- | --- |
| Runtime ID | `IFrameInferenceRuntime.id` |
| Backend type | `kind` (`stub` \| `mlx` \| `llamacpp`) |
| Model path | `IFrameRuntimeStatus.modelPath` |
| Availability | `isAvailable()` |
| Status | Ready / Not ready |
| Capabilities | Backend-specific (stub placeholder vs future native) |
| Config file | `.frame/config/runtime.json` |

### Configuration

| Control | Action |
| --- | --- |
| **Enable / Disable** | `updateConfig({ enabled })` |
| **Backend** select | `selectRuntime(id)` → persists `runtime` |
| **Model path** + Save | `updateConfig({ modelPath })` — string only |
| **Clear** | `updateConfig({ modelPath: null })` |

Saving a path does **not** load the file. Native backends remain unavailable until a future bridge exists.

## Service wiring

```
FrameAIViewPane
    │
    ▼
IFrameIntelligenceService.runtimes
    │
    ▼
IFrameRuntimeService
    ├── getStatus() / getConfig() / listRuntimes()
    ├── updateConfig() / selectRuntime()
    └── onDidChangeStatus → refresh panel
```

No duplicate runtime logic in the UI.

## Privacy & ownership

| Guarantee | UI message |
| --- | --- |
| Local only | Privacy block + system notes |
| No network / telemetry | Privacy block |
| User-owned weights | Path is user-typed; Frame never downloads |
| No silent load | Enable/select/save path are config-only |

## Source files

| Path | Role |
| --- | --- |
| `browser/frameAIViewPane.ts` | Runtime section |
| `browser/media/frameAI.css` | Runtime styles |
| `runtime/frameRuntime.ts` | `IFrameRuntimeService` |
| `FRAME_LOCAL_RUNTIME_ARCHITECTURE.md` | Backend architecture |

## Out of scope

- Model download
- Weight load / GGUF mmap
- MLX / llama.cpp native inference
- Cloud model APIs
