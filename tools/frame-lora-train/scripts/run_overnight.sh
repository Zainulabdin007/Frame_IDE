#!/usr/bin/env bash
# Overnight Frame-agent LoRA pipeline (Apple Silicon).
# Usage: ./scripts/run_overnight.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv-lora ]]; then
  python3 -m venv .venv-lora
fi
# shellcheck disable=SC1091
source .venv-lora/bin/activate
pip install -U pip
pip install -U "mlx-lm[train]"

# Synth → filter mined → merge into train/valid (merge owns train.jsonl)
python scripts/generate_dataset.py --scale heavy
python scripts/quality_filter.py data/raw/*.jsonl --out data/raw/filtered_mined.jsonl
# Raise max-source so diversified synth + protocol tools/inserts survive caps
python scripts/merge_all_data.py --max-source-rows 55000 --max-total-rows 160000

echo "Starting LoRA train — leave this Mac plugged in."
python scripts/train_mlx_lora.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path adapters/frame-agent-v1 \
  --iters 100000 \
  --batch-size 1 \
  --num-layers 16 \
  --lora-rank 16 \
  --max-seq-length 4096

echo "Running eval..."
python scripts/eval_adapter.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path adapters/frame-agent-v1 || true

echo "Done. Next: fuse + convert to GGUF (see README.md)."
