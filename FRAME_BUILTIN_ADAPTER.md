# Built-in Frame agent LoRA

Frame ships foundation agent behavior as always-on. For **v1**, that means a **fused base GGUF** (LoRA baked into the default model), not a separate LoRA file on the side.

## What you have after train + convert

| Artifact | Path |
| --- | --- |
| MLX LoRA | `tools/frame-lora-train/adapters/frame-agent-v1/adapters.safetensors` |
| Fused MLX (optional) | `adapters/frame-agent-v1-fused[-f16]/` |
| **Default chat model** | `.frame/models/frame-agent-v1-fused-q4_k_m.gguf` (~4.4 GB) |
| Release copy | `resources/frame-models/frame-agent-v1-fused-q4_k_m.gguf` |

`runtime.json` `modelPath` points at the fused Q4 — every Frame open loads agent behavior without drag-drop.

## One-shot install

```bash
cd tools/frame-lora-train
python scripts/install_fused_base_model.py
```

That hardlinks the Q4 into `.frame/models/` + `resources/frame-models/`, sets workspace + `~/.frame` `runtime.json`, and marks `frame-agent-v1` builtin/active (fused-into-base).

## Convert recipe

```bash
brew install llama.cpp
# tools/llama.cpp provides convert_hf_to_gguf.py

cd tools/frame-lora-train
.venv-lora/bin/python -m mlx_lm fuse \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path adapters/frame-agent-v1 \
  --save-path adapters/frame-agent-v1-fused-f16 \
  --dequantize

.venv-lora/bin/python ../llama.cpp/convert_hf_to_gguf.py \
  adapters/frame-agent-v1-fused-f16 \
  --outfile adapters/frame-agent-v1-gguf/frame-agent-v1-fused-f16.gguf \
  --outtype f16

llama-quantize \
  adapters/frame-agent-v1-gguf/frame-agent-v1-fused-f16.gguf \
  adapters/frame-agent-v1-gguf/frame-agent-v1-fused-q4_k_m.gguf \
  Q4_K_M

python scripts/install_fused_base_model.py
```

Delete the 14 GB F16 GGUF after quantize to free disk.

## Code wiring

Builtin adapter id + ensure-on-discover + sidebar “Built-in · always on” remain; v1 behavior is applied via the fused `modelPath`. Weights are not committed to git. Reload Frame after install.
