# Frame IDE

**Local-first AI coding IDE** — a VS Code (Code – OSS) fork with an on-device agent stack.  
No Copilot account. No cloud inference. No silent model downloads.

```
./scripts/launch-frame.sh
```

---

## Stack (bottom → top)

```
┌─────────────────────────────────────────────────────────────────┐
│  7  DISTRIBUTION                                                │
│      GitHub Releases IDE packs · Models sidebar GGUF · optional CDN zip │
├─────────────────────────────────────────────────────────────────┤
│  6  TRAINING & PERSONALIZATION                                  │
│      MLX QLoRA · fuse → Q4 GGUF · Approve → prefs LoRA schedule │
├─────────────────────────────────────────────────────────────────┤
│  5  INFERENCE WORKER                                            │
│      child_process · node-llama-cpp · GGUF · Metal (Apple)      │
├─────────────────────────────────────────────────────────────────┤
│  4  AGENT PROTOCOL                                              │
│      Tools · edit plans · streaming · workspace apply / Undo    │
├─────────────────────────────────────────────────────────────────┤
│  3  CONTEXT ASSEMBLY                                            │
│      Memory · lexical RAG · knowledge graph · prefs · adapters  │
├─────────────────────────────────────────────────────────────────┤
│  2  INTELLIGENCE CONTROL PLANE                                  │
│      Orchestrator · Chat agent · LM vendor · Frame sidebar      │
├─────────────────────────────────────────────────────────────────┤
│  1  IDE SHELL                                                   │
│      VS Code fork · Frame brand · privacy defaults · no Copilot │
└─────────────────────────────────────────────────────────────────┘
```

---

### Layer 1 — IDE shell

| Piece | Role |
|-------|------|
| `vscode/` | Vendored Code – OSS 1.131, productized as **Frame** |
| `vscode/product.json` | Name, `.frame` data dir, telemetry/updates off |
| `scripts/launch-frame.sh` | Dev launch; disables Copilot builtins |

Docs: `FRAME_ARCHITECTURE.md`, `FRAME_REBRAND.md`

---

### Layer 2 — Intelligence control plane

| Piece | Role |
|-------|------|
| Built-in **Chat** | Only place users talk to Frame (`FrameChatAgent` + LM vendor `frame`) |
| **Frame sidebar** | Control plane: models, edits, tools, hardware, learning, adapters — no composer |
| `IFrameIntelligenceService` | Facade over the stack |
| Orchestrator | Deterministic task routing into context → runtime |

Code: `vscode/src/vs/workbench/contrib/frameAI/`  
Docs: `FRAME_AI_ARCHITECTURE.md`, `FRAME_ROADMAP.md`

---

### Layer 3 — Context assembly

| Piece | Store / behavior |
|-------|------------------|
| Multi-tier **memory** | `.frame/memory/` — project, preferences, decisions, summaries |
| Per-project **RAG** | `.frame/rag/` — scan → chunk → **lexical** retrieval |
| Workspace **knowledge graph** | `.frame/knowledge/` — structural nodes/edges |
| Preferences | Approved prefs injected into every generation context |
| Adapters | Registry under `.frame/adapters/` |

Docs: `FRAME_MEMORY_PERSISTENCE.md`, `FRAME_RAG_IMPLEMENTATION.md`, `FRAME_KNOWLEDGE_GRAPH.md`, `FRAME_CONTEXT_ENGINE.md`

---

### Layer 4 — Agent protocol

| Piece | Role |
|-------|------|
| Tools | Fenced ` ```frame-tool ` → sandboxed workspace tools |
| Edit plans | Fenced ` ```frame-edit-plan ` → validate → apply / Undo |
| Streaming | Token IPC from worker → Chat UI |

Docs: `FRAME_TOOL_CALLING.md`, `FRAME_EDIT_PIPELINE.md`

---

### Layer 5 — Inference worker

| Piece | Role |
|-------|------|
| `tools/frame-model-worker/` | Isolated process; IDE never loads GGUF tensors |
| `node-llama-cpp` | Local GGUF; Metal on Apple Silicon (`gpu: auto`) |
| Default model | Qwen2.5-Coder-7B family; Efficient **Q4_K_M** fused agent GGUF |
| Trust | Offline `.frame-model` packages — SHA-256 + **Ed25519** |

Docs: `FRAME_MODEL_WORKER_ARCHITECTURE.md`, `FRAME_LLAMA_CPP_RUNTIME.md`, `FRAME_MODEL_SECURITY.md`

**Editions (profiles):** Efficient (Q4) · Professional (Q8) · Maximum (FP16) — hardware-aware recommendation; shipped path is Q4 fused.

---

### Layer 6 — Training & personalization

| Piece | Role |
|-------|------|
| `tools/frame-lora-train/` | Offline dataset → MLX QLoRA → fuse → quantize → install |
| Builtin agent | LoRA **fused into** default Q4 GGUF (`frame-agent-v1-fused-q4_k_m.gguf`) |
| Learning → Approve | Preference → memory **and** debounced on-device prefs LoRA job (`frame-prefs-user`) |
| Observation engine | Accepts / edits / rejects → heuristic candidates → HITL |

Docs: `tools/frame-lora-train/README.md`, `FRAME_PREFERENCE_LEARNING.md`, `FRAME_BUILTIN_ADAPTER.md`, `FRAME_ADAPTER_ARCHITECTURE.md`

---

### Layer 7 — Distribution

**Public download path:** [GitHub Releases](https://github.com/Zainulabdin007/Frame_IDE/releases/latest) (website Download CTAs point here).

**First-time setup (IDE + base GGUF you download + LoRA we ship):** see [`docs/DOWNLOAD.md`](docs/DOWNLOAD.md) — written so people can paste it into ChatGPT.

| Piece | Role |
|-------|------|
| `scripts/package-ide-release.sh` | IDE-only Win zip / Linux tarball / macOS DMG (no GGUF) |
| `.github/workflows/publish-ide-release.yml` | Build + publish IDE assets to a GitHub Release |
| `scripts/trigger-ide-release.sh` | `gh workflow run` helper for IDE releases |
| `scripts/package-efficient-release.sh` | Optional CDN bundle: IDE + fused Q4 (~5GB+) |
| `.github/workflows/package-efficient-release.yml` | Build full Efficient zips for CDN hosting |
| Models sidebar | Post-install Efficient GGUF install (GitHub cannot host the ~4GB model) |

GitHub Release assets max out at **2GB/file**, so Releases ship **IDE only**. After install: open Frame → Models → install Efficient (4-bit). Host full IDE+model zips on a CDN if you need one-click offline packs.

```bash
# Publish IDE installers to GitHub Releases (recommended website funnel)
./scripts/trigger-ide-release.sh --tag v0.1.0 --platform all
gh run watch
# → https://github.com/Zainulabdin007/Frame_IDE/releases/latest

# Optional: full Efficient zip for CDN (not for GitHub Release assets)
./scripts/trigger-efficient-release.sh \
  --platform both \
  --model-url 'https://YOUR_CDN/frame-agent-v1-fused-q4_k_m.gguf'
```

---

## Data flow (one chat turn)

```
Chat message
  → FrameChatAgent / FrameLanguageModelProvider
  → Orchestrator + Context Engine (memory, RAG, KG, prefs, adapters)
  → Runtime → Worker (fork)
  → node-llama-cpp (GGUF ± LoRA paths)
  → streamToken / toolRequest IPC
  → tools / edit plans → workspace
```

---

## Hard rules

1. **Local-only** AI path — no cloud inference clients in `frameAI`
2. **No silent weight downloads** — user path, Models sidebar install, or explicit release/CDN bundle only
3. **Process isolation** — weights outside the Electron renderer
4. **HITL preferences** — never auto-activate style prefs
5. **Workspace sandbox** — tool paths stay inside the folder
6. **Telemetry / updates off** by product default

---

## Quick start (dev)

```bash
# Apple Silicon recommended for Metal + MLX train
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
./scripts/launch-frame.sh
```

Install fused Efficient model (if not already present):

```bash
python tools/frame-lora-train/scripts/install_fused_base_model.py \
  --src tools/frame-lora-train/adapters/frame-agent-v2-gguf/frame-agent-v2-fused-q4_k_m.gguf
```

---

## Repo map

| Path | Stack layer |
|------|-------------|
| `vscode/` | 1 — IDE shell |
| `vscode/src/vs/workbench/contrib/frameAI/` | 2–4 — intelligence |
| `tools/frame-model-worker/` | 5 — inference |
| `tools/frame-model-packager/` | 5 — trust packages |
| `tools/frame-lora-train/` | 6 — training |
| `resources/frame-models/` | 5/7 — release GGUF staging |
| `scripts/` | 1/7 — launch + package |
| `.github/workflows/` | 7 — CI release |
| `docs/DOWNLOAD.md` | 7 — public install + model step 2 |
| `FRAME_*.md` | Architecture docs (33) |

---

## Honest scope

Frame is strong at **local agent protocol** (tools, edit plans, context) and **on-device Efficient inference**.  
It is **not** a drop-in replacement for frontier cloud agents on large multi-file refactors. Preference Approve schedules a real local LoRA job; MLX adapter weights may still need fuse/convert before the chat worker loads them as GGUF.

---

## License

VS Code portions: MIT (Microsoft Code – OSS).  
Frame-owned contributions under this repository: see project license / copyright headers.
