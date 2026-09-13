# First-time setup

> **Paste this whole page into ChatGPT** (or any assistant) if you get stuck — ask it to walk you through the steps for your OS (macOS / Windows / Linux).

Frame’s GitHub Release is the **IDE only** (when IDE assets are published) plus our **agent LoRA**. You bring the base model. That keeps Release assets under GitHub’s 2GB limit.

**Releases:** https://github.com/Zainulabdin007/Frame_IDE/releases/latest

---

## 1. Install Frame (IDE)

When IDE assets appear on the release (or you build from source with `./scripts/launch-frame.sh`):

| OS | Asset | Notes |
|----|--------|--------|
| macOS (Apple Silicon) | `Frame-macOS-arm64.dmg` | Unsigned beta — right-click **Frame** → **Open** the first time. |
| Windows x64 | `Frame-IDE-win64.zip` | Unzip and run `Frame.exe`. |
| Linux x64 | `Frame-IDE-linux64.tar.gz` | Extract and run the `frame` binary. |

Until those assets ship, clone the repo and run `./scripts/launch-frame.sh` on Apple Silicon for development.

---

## 2. Get the Frame agent LoRA (we give you this)

From the **same Releases page**, download:

- **`frame-agent-v2-lora.zip`** (~81MB) — contains `adapters.safetensors` + config

Unzip it:

```bash
unzip frame-agent-v2-lora.zip
# → frame-agent-lora/adapters.safetensors
```

---

## 3. Get a base model (you download this)

You need a **Qwen2.5-Coder-7B-Instruct** GGUF in **Q4_K_M** (Efficient / ~4-bit). Not on GitHub (too large).

1. Hugging Face: search `Qwen2.5-Coder-7B-Instruct` + `GGUF` + `Q4_K_M`.
2. Download one `*Q4_K_M*.gguf` (several GB).
3. Save it, e.g. `~/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`

---

## 4. Wire them into Frame

1. Open Frame → **Frame** sidebar → set **model path** to your base GGUF → enable runtime.
2. Install the LoRA:

**With a Frame_IDE git checkout** (sidebar Import also works if exposed):

```bash
# Copy LoRA into the workspace adapter slot Frame reads
mkdir -p /path/to/your/project/.frame/adapters/frame-agent-v1
cp frame-agent-lora/adapters.safetensors \
  /path/to/your/project/.frame/adapters/frame-agent-v1/adapters.safetensors
cp frame-agent-lora/adapter_config.json \
  /path/to/your/project/.frame/adapters/frame-agent-v1/adapter_config.json 2>/dev/null || true
```

Or use Frame’s adapter import UI if available: import `adapters.safetensors` as the Frame agent adapter and keep it active.

3. Restart Frame / reload the window.

### Advanced — fuse into one GGUF

See [`FRAME_BUILTIN_ADAPTER.md`](../FRAME_BUILTIN_ADAPTER.md). Most people should skip this.

---

## 5. Smoke test

```text
Add a comment at the top of README.md that says hello from Frame.
```

You should see an edit apply in the editor, not only a claim in chat.

---

## Maintainers

```bash
# Package LoRA zip (already in dist/ when built locally)
# Upload: gh release upload v0.1.0-beta dist/frame-agent-v2-lora.zip --clobber

# IDE installers (long CI):
./scripts/trigger-ide-release.sh --tag v0.1.0-beta --platform all
```
