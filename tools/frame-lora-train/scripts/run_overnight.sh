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

python scripts/generate_dataset.py

# Symlinks for mlx_lm.lora expected names
ln -sfn frame_agent_train.jsonl data/processed/train.jsonl
ln -sfn frame_agent_valid.jsonl data/processed/valid.jsonl

echo "Starting LoRA train — leave this Mac plugged in."
python scripts/train_mlx_lora.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path adapters/frame-agent-v1 \
  --iters 1200 \
  --batch-size 1 \
  --num-layers 16 \
  --lora-rank 16 \
  --max-seq-length 4096

echo "Running eval..."
python scripts/eval_adapter.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path adapters/frame-agent-v1 || true

echo "Done. Next: fuse + convert to GGUF (see README.md)."
