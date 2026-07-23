# Frame-agent LoRA training

**Yes — your goal is doable on this Mac.**  
You are not aiming for Cursor/frontier. You want a 7B that reliably:

- emits `frame-edit-plan` / `frame-tool` in the right shape
- makes small correct edits (append, prepend, insert, create a function)
- uses the **13 Frame tools** and multi-turn tool→result→edit flows
- does **not** dump unrelated docs when asked for a one-line change

That is classic **behavior fine-tuning**, not AGI. QLoRA on an M5 Pro 64GB overnight is realistic once the dataset is locked.

## Hardware fit

| Piece | Your machine |
| --- | --- |
| Chip | M5 Pro (18 CPU / 20 GPU) |
| RAM | 64 GB unified |
| Recipe | MLX **QLoRA** on `Qwen2.5-Coder-7B-Instruct-4bit` |

Keep the laptop plugged in. Close heavy apps if memory pressure spikes.

## Dataset pipeline

```text
generate_dataset.py  →  data/processed/generated_{train,valid}.jsonl
quality_filter.py    →  data/raw/filtered_mined.jsonl
merge_all_data.py    →  data/processed/train.jsonl + valid.jsonl
```

**Current merged set (ready to train):** ~**163k train** / **6.8k valid** (170k total).

`generate_dataset.py` writes **only** `generated_*.jsonl` + `generated_manifest.json` — it does **not** overwrite merge-owned `train.jsonl`.

```bash
cd tools/frame-lora-train
python3 scripts/generate_dataset.py --scale heavy
python3 scripts/quality_filter.py data/raw/*.jsonl --out data/raw/filtered_mined.jsonl
python3 scripts/merge_all_data.py --max-source-rows 90000 --max-total-rows 170000
wc -l data/processed/train.jsonl data/processed/valid.jsonl
```

### 13 tools (ALLOWED_TOOLS)

`readFile`, `listFiles`, `globFiles`, `grepWorkspace`, `codebaseSearch`, `findSymbol`, `findReferences`, `findDependencies`, `findCallers`, `findImplementations`, `readLints`, `gitStatus`, `gitDiff`

Never train `searchWorkspace` / `writeFile` / `terminalRun` / `renameSymbol`.

### Edit ops

`create`, `modify`, `append`, `prepend`, `insert` (1-based line), `delete`, `rename`

## Train tonight

```bash
cd tools/frame-lora-train
chmod +x scripts/run_managed_train.sh scripts/run_overnight.sh
./scripts/run_overnight.sh   # generate → filter → merge → train
# or:
./scripts/run_managed_train.sh
```

The **training manager** (`scripts/training_manager.py`) will:

1. Detect Apple Silicon + MLX (Metal GPU) — fall back to CPU only if MLX is missing
2. Print an estimate (duration, RAM, backend)
3. Start a detachable job under `jobs/<id>/` with pause / resume / cancel

```bash
python scripts/training_manager.py probe
python scripts/training_manager.py estimate --iters 100000
python scripts/training_manager.py run-now --iters 100000
python scripts/training_manager.py status
```

Default long run: **100k iters**, batch 1, LoRA rank 16, 16 layers, prompt masking, grad checkpoint.

## Get it into Frame

```bash
python scripts/install_fused_base_model.py
```

See [FRAME_BUILTIN_ADAPTER.md](../../FRAME_BUILTIN_ADAPTER.md).

## Honest bar

| Expectation | Verdict |
| --- | --- |
| Reliable “add X to end of file” / “create add.ts” / “on line N” insert | **Yes, with this LoRA** |
| Follow Frame fences + 13-tool protocol | **Yes** |
| Replace Cursor / Opus / large cloud agents | **No — not the goal** |
| Perfect every multi-file refactor | **No — iterate data + more iters** |

After v1, improve by adding **real failures from Frame chat** into `generate_dataset.py` or a `data/raw/` JSONL and re-running generate → filter → merge.
