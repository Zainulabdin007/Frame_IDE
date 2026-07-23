# Frame Intelligence Roadmap Status

Product surfaces and milestone status after the Chat ↔ control-plane split and local llama.cpp wiring (post-audit hardening).

## Product surfaces (locked)

| Surface | Role |
|---------|------|
| **Built-in Chat** (Auxiliary Bar) | Only place users talk to Frame AI (`FrameChatAgent` + Frame LM vendor → orchestrator → worker) |
| **Frame sidebar** (Activity Bar) | Control plane: hardware, models, runtime, adapters, learning, knowledge, plan review, tools, preview, background — **no composer** |

No Microsoft / Copilot account is required. No cloud inference. No model downloads.

## Data flow

```
Built-in Chat
  → FrameChatAgent / FrameLanguageModelProvider (vendor: frame)
  → IFrameIntelligenceService.submitTask
  → Orchestrator + Context Engine (RAG, KG, memory, prefs, adapters)
  → Runtime → Worker (child_process)
  → node-llama-cpp (GGUF + optional real LoRA paths)
  → streamToken IPC → Chat UI
```

## Milestone status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 Chat → Frame | **Done** | Default agents + Copilot extensions disabled |
| 1b Frame LM vendor | **Done** | Efficient / Professional / Maximum in model picker |
| 2 Sidebar control plane | **Done** | Full control sections restored; no chat composer |
| 3 Honest llama E2E | **Done** | Load-once; file-exists `isAvailable`; honest health notes |
| 4 Tool calling | **Done** | ` ```frame-tool ` → toolRequest/Result; smoke accepts orphan toolResult |
| 5 Model edit plans | **Done** | parse → recovery → stub; Chat Apply + sidebar Preview Accept/Reject |
| 6 Background Intelligence | **Done** | Startup idle + recurring 15‑min idle passes; sidebar status |
| 7 LoRA weight paths | **Done** (plumbing) | No placeholder weights; `importWeightFile` / Link path; GGUF LoRA preferred over MLX safetensors |

### Caveats (honest)

- Real LoRA apply still needs a **usable GGUF LoRA** (or fused GGUF as `modelPath`). MLX train output must be fused/converted — see `tools/frame-lora-train/README.md`.
- Protocol smoke without `FRAME_MODEL_PATH` expects `MODEL_RUNTIME_NOT_CONNECTED` and **allows zero tokens**.

## Configure local inference

```json
// .frame/config/runtime.json
{
  "runtime": "llamacpp",
  "activeModelId": "qwen-coder-7b-q4",
  "modelPath": "/absolute/path/to/model.gguf",
  "enabled": true
}
```

Example verified path on this machine:

`/Users/zain/Frame/models/efficient/qwen2.5-coder-7b-instruct-q4_k_m.gguf`

Worker smoke:

```bash
cd tools/frame-model-worker && npm install
node smoke-test.mjs
FRAME_MODEL_PATH=/path/to/model.gguf node smoke-test.mjs
# Optional LoRA re-init:
FRAME_MODEL_PATH=/path/to/model.gguf FRAME_ADAPTER_PATH=/path/to/lora.gguf node smoke-test.mjs
```

## Key code

| Area | Path |
|------|------|
| Chat participant | `vscode/.../frameAI/browser/frameChatAgent.ts` |
| LM vendor | `vscode/.../frameAI/browser/frameLanguageModelProvider.ts` |
| Control sidebar | `vscode/.../frameAI/browser/frameAIViewPane.ts` |
| Worker | `tools/frame-model-worker/` |
| Background engine | `vscode/.../frameAI/background/` |
| Edit plans | `vscode/.../frameAI/runtime/frameEditPlan.ts` |
| Offline LoRA train | `tools/frame-lora-train/` (not DI-wired) |

Companion docs: `FRAME_AI_ARCHITECTURE.md`, `FRAME_LLAMA_CPP_RUNTIME.md`, `FRAME_COMPONENT_MAP.md`, `FRAME_RUNTIME_UI.md`, `FRAME_MODEL_WORKER_ARCHITECTURE.md`, `FRAME_EDIT_PIPELINE.md`.
