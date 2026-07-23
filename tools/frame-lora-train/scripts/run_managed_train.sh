#!/usr/bin/env bash
# Frame LoRA overnight / managed train via training_manager.py
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

python scripts/training_manager.py probe
python scripts/training_manager.py estimate --iters "${ITERS:-1200}"
python scripts/training_manager.py run-now \
  --name "Frame agent LoRA v1" \
  --iters "${ITERS:-1200}" \
  --adapter-path adapters/frame-agent-v1 \
  ${SCHEDULE:+--schedule "$SCHEDULE"} \
  ${FORCE_CPU:+--force-cpu} \
  ${CPU_LIMIT:+--cpu-limit}

echo "Job started. Check: python scripts/training_manager.py status"
echo "Pause:  python scripts/training_manager.py pause --job-id <id>"
echo "Cancel: python scripts/training_manager.py cancel --job-id <id>"
