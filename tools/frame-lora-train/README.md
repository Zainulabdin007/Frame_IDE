# Frame-agent LoRA training

**Yes — your goal is doable on this Mac.**  
You are not aiming for Cursor/frontier. You want a 7B that reliably:

- emits `frame-edit-plan` / `frame-tool` in the right shape
- makes small correct edits (append, prepend, create a function)
- writes basic typed helpers and follows normal style
- does **not** dump unrelated docs when asked for a one-line change

That is classic **behavior fine-tuning**, not AGI. QLoRA on an M5 Pro 64GB overnight is realistic once the dataset is locked.

## Hardware fit

| Piece | Your machine |
| --- | --- |
| Chip | M5 Pro (18 CPU / 20 GPU) |
| RAM | 64 GB unified |
| Recipe | MLX **QLoRA** on `Qwen2.5-Coder-7B-Instruct-4bit` |

Keep the laptop plugged in. Close heavy apps if memory pressure spikes.

## Dataset (3-hour mining campaign)

A **3-hour loop** (12×15min ticks) keeps expanding data under `data/` + `logs/campaign.md`.

**Current processed (quality-filtered):** see `data/processed/merged_manifest.json` — on the order of **~300k train** rows / ~1GB `train.jsonl`.

**Sources:**
- Frame gold / recovery / synth (`gold_seeds.py`, `generate_dataset.py`, `recovery_gold.jsonl`)
- Vendored **VS Code + workbench + Frame AI** mines (create/modify/JSDoc/mutations/function extracts)
- Public edit corpora → `frame-edit-plan`: **InstructCoder**, **nuprl/EditPackFT**, **CodeAlpaca**
- Paraphrase augmentation for instruction robustness

```bash
wc -l data/processed/train.jsonl data/processed/valid.jsonl
tail -40 logs/campaign.md

python scripts/generate_dataset.py --scale heavy
python scripts/quality_filter.py data/raw/*.jsonl --out data/raw/filtered_mined.jsonl
python scripts/merge_all_data.py
```

## Train tonight

```bash
cd tools/frame-lora-train
chmod +x scripts/run_managed_train.sh scripts/run_overnight.sh
./scripts/run_managed_train.sh
```

The **training manager** (`scripts/training_manager.py`) will:

1. Detect Apple Silicon + MLX (Metal GPU) — fall back to CPU only if MLX is missing
2. Print an estimate (duration, RAM, backend)
3. Start a detachable job under `jobs/<id>/` with pause / resume / cancel

```bash
python scripts/training_manager.py probe
python scripts/training_manager.py estimate --iters 1200
python scripts/training_manager.py run-now --iters 1200
python scripts/training_manager.py status
python scripts/training_manager.py pause --job-id <id>
python scripts/training_manager.py resume --job-id <id>
python scripts/training_manager.py cancel --job-id <id>
# Start in ~8 hours:
python scripts/training_manager.py run-now --iters 1200 --schedule overnight
```

Frame’s sidebar **LoRA training** section uses the same manager (estimate → start / schedule overnight / pause / cancel).

Or step by step:

```bash
cd tools/frame-lora-train
python3 -m venv .venv-lora
source .venv-lora/bin/activate
pip install -U "mlx-lm[train]"
python scripts/train_mlx_lora.py --iters 1200
python scripts/eval_adapter.py --adapter-path adapters/frame-agent-v1
```

Default train: **1200 iters**, batch 1, LoRA rank 16, 16 layers, prompt masking, grad checkpoint.  
Expect on the order of **several hours** (often ~6–12h depending on thermal/power). Watch loss; if valid loss climbs hard, stop early and use the last good adapter checkpoint.

## Get it into Frame

Frame’s worker loads **GGUF** via llama.cpp (optional GGUF LoRA files). MLX writes **safetensors** adapters — those may not load in node-llama-cpp; prefer GGUF.

### Recommended path (fused base GGUF)

1. Fuse: `python scripts/fuse_adapter.py`
2. Convert fused HF/MLX weights → GGUF and quantize to `Q4_K_M` with llama.cpp
3. Point `.frame/config/runtime.json` `modelPath` at the new GGUF
4. Restart Frame

### Alternate path (LoRA adapter under `.frame/adapters/`)

1. Fuse (optional) and convert the LoRA (or fused model) to **GGUF** as above
2. In Frame, create/import an adapter (sidebar → LoRA adapters), or register one under `.frame/adapters/<id>/`
3. Either:
   - Paste the **absolute path** to the `.gguf` (preferred) or `.safetensors` file into **Link weight path** in the Frame sidebar (expand an adapter with Details, or use the last imported adapter), **or**
   - Copy the file into `.frame/adapters/<id>/` and set `weightFile` in that folder’s `metadata.json`
4. Activate the adapter in the sidebar so it is included in local context / runtime adapter paths
5. Restart Frame if the worker was already initialized

Until a real GGUF exists, keep heuristics as a safety net; the LoRA’s job is to make the model emit plans correctly so heuristics fire less.

## Honest bar

| Expectation | Verdict |
| --- | --- |
| Reliable “add X to end of file” / “create add.ts” | **Yes, with this LoRA** |
| Follow Frame fences + basic coding standards | **Yes** |
| Replace Cursor / Opus / large cloud agents | **No — not the goal** |
| Perfect every multi-file refactor | **No — iterate data + more iters** |

After v1, improve by adding **real failures from Frame chat** (prompt + desired `frame-edit-plan`) into `generate_dataset.py` or a `data/raw/` JSONL and regenerating.

## Regenerating data

```bash
python scripts/generate_dataset.py --seed 7
```

Edit the generators in `scripts/generate_dataset.py` to add project-specific paths, languages, or standards.
