# First-time setup (all editions)

> Paste the guide for **your edition** into ChatGPT if you get stuck.

Same Frame IDE + same Frame agent LoRA for every edition. Only the **base GGUF** changes (4-bit / 8-bit / FP16).

| Edition | Release | Base GGUF to download |
|---------|---------|------------------------|
| **Efficient** (default) | [v0.1.0-beta](https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta) | Qwen2.5-Coder-7B-Instruct **Q4_K_M** |
| **Professional** | [v0.1.0-beta-professional](https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta-professional) | Qwen2.5-Coder-7B-Instruct **Q8_0** (or Q8_K) |
| **Maximum** | [v0.1.0-beta-maximum](https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta-maximum) | Qwen2.5-Coder-7B-Instruct **F16** / **fp16** |

Each release page attaches **`frame-agent-v2-lora.zip`** (same file). The LoRA applies on top of whichever base you pick.

---

## Shared steps

### 1. Install Frame (IDE)

From any edition release (or the Efficient one once IDE assets are published):

| OS | Asset |
|----|--------|
| Windows x64 | `Frame-IDE-win64.zip` (optional `Frame-IDE-win64-Setup.exe`) |
| Linux x64 | `Frame-IDE-linux64.tar.gz` |
| macOS | Not published yet — use `./scripts/launch-frame.sh` from a clone |

macOS DMGs are paused until Apple signing / notarization (unsigned builds trip Gatekeeper “damaged” warnings).

### 2. Download our LoRA

From **your edition’s** release Assets:

```bash
unzip frame-agent-v2-lora.zip
# → frame-agent-lora/adapters.safetensors
```

### 3. Download the base GGUF (edition-specific)

Hugging Face: search `Qwen2.5-Coder-7B-Instruct` + `GGUF`, then pick the quant for your edition (table above). Not hosted on GitHub (too large).

### 4. Wire into Frame

1. Frame sidebar → model path = your base GGUF → enable runtime.
2. Install LoRA:

```bash
mkdir -p /path/to/your/project/.frame/adapters/frame-agent-v1
cp frame-agent-lora/adapters.safetensors \
  /path/to/your/project/.frame/adapters/frame-agent-v1/adapters.safetensors
cp frame-agent-lora/adapter_config.json \
  /path/to/your/project/.frame/adapters/frame-agent-v1/adapter_config.json 2>/dev/null || true
```

3. Reload Frame.

### 5. Smoke test

```text
Add a comment at the top of README.md that says hello from Frame.
```

---

## Edition notes

### Efficient (Q4)

- Lowest RAM/VRAM. Best laptop default.
- Release: https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta

### Professional (Q8)

- Heavier, usually sharper coding than Q4.
- Same LoRA zip as Efficient — do **not** retrain; just use an 8-bit base GGUF.
- Release: https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta-professional

### Maximum (FP16)

- Highest fidelity, largest download and memory.
- Same LoRA zip; use an F16/fp16 Instruct GGUF.
- Release: https://github.com/Zainulabdin007/Frame_IDE/releases/tag/v0.1.0-beta-maximum

---

## Maintainers

```bash
# Same LoRA on every edition release
gh release upload v0.1.0-beta-professional dist/frame-agent-v2-lora.zip --clobber
gh release upload v0.1.0-beta-maximum dist/frame-agent-v2-lora.zip --clobber

# IDE installers (once): attach to Efficient tag or all three
./scripts/trigger-ide-release.sh --tag v0.1.0-beta --platform win-linux
```
