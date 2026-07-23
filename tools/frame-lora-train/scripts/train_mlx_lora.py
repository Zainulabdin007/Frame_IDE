#!/usr/bin/env python3
"""
Train a Frame-agent LoRA on Qwen2.5-Coder-7B-Instruct via MLX-LM (Apple Silicon).

Prereqs (once):
  python3 -m venv .venv-lora
  source .venv-lora/bin/activate
  pip install -U "mlx-lm[train]"

Example:
  python scripts/train_mlx_lora.py \\
    --data-dir data/processed \\
    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \\
    --adapter-path adapters/frame-agent-v1 \\
    --iters 1200
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def main() -> None:
	root = Path(__file__).resolve().parents[1]
	parser = argparse.ArgumentParser(description="MLX LoRA train for Frame agent")
	parser.add_argument("--data-dir", type=Path, default=root / "data" / "processed")
	parser.add_argument(
		"--model",
		default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
		help="HF / mlx-community model id (4bit is memory-friendly on 64GB)",
	)
	parser.add_argument("--adapter-path", type=Path, default=root / "adapters" / "frame-agent-v1")
	parser.add_argument("--iters", type=int, default=1200)
	parser.add_argument("--batch-size", type=int, default=1)
	parser.add_argument("--learning-rate", type=float, default=1e-5)
	parser.add_argument("--num-layers", type=int, default=16, help="How many layers get LoRA")
	parser.add_argument("--lora-rank", type=int, default=16)
	parser.add_argument("--lora-scale", type=float, default=20.0)
	parser.add_argument("--max-seq-length", type=int, default=4096)
	parser.add_argument("--steps-per-eval", type=int, default=100)
	parser.add_argument("--steps-per-save", type=int, default=200)
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--dry-run", action="store_true")
	args = parser.parse_args()

	train = args.data_dir / "train.jsonl"
	valid = args.data_dir / "valid.jsonl"
	if not train.exists():
		train = args.data_dir / "frame_agent_train.jsonl"
	if not valid.exists():
		valid = args.data_dir / "frame_agent_valid.jsonl"
	if not train.exists() or not valid.exists():
		print("Missing processed data. Run: python scripts/merge_all_data.py", file=sys.stderr)
		sys.exit(1)

	args.adapter_path.mkdir(parents=True, exist_ok=True)
	meta = {
		"base_model": args.model,
		"train_file": str(train),
		"valid_file": str(valid),
		"iters": args.iters,
		"lora_rank": args.lora_rank,
		"goal": "Frame agent: frame-edit-plan / frame-tool / basic functions",
	}
	(args.adapter_path / "frame_train_meta.json").write_text(json.dumps(meta, indent=2) + "\n")

	# Newer mlx-lm accepts LoRA rank/scale via YAML --config (not --lora-parameters).
	config_path = args.adapter_path / "mlx_lora_config.yaml"
	config_path.write_text(
		"\n".join([
			f"model: {args.model}",
			"train: true",
			f"data: {args.data_dir}",
			f"adapter_path: {args.adapter_path}",
			"fine_tune_type: lora",
			f"batch_size: {args.batch_size}",
			f"iters: {args.iters}",
			f"learning_rate: {args.learning_rate}",
			f"num_layers: {args.num_layers}",
			f"max_seq_length: {args.max_seq_length}",
			f"steps_per_eval: {args.steps_per_eval}",
			f"save_every: {args.steps_per_save}",
			f"seed: {args.seed}",
			"mask_prompt: true",
			"grad_checkpoint: true",
			"lora_parameters:",
			f"  rank: {args.lora_rank}",
			"  dropout: 0.0",
			f"  scale: {args.lora_scale}",
			"",
		])
	)

	train_link = args.data_dir / "train.jsonl"
	valid_link = args.data_dir / "valid.jsonl"
	if not train_link.exists() and train.name != "train.jsonl":
		train_link.symlink_to(train.name)
	if not valid_link.exists() and valid.name != "valid.jsonl":
		valid_link.symlink_to(valid.name)

	cmd = [
		sys.executable,
		"-m",
		"mlx_lm",
		"lora",
		"--config",
		str(config_path),
	]

	print("Running:", " ".join(cmd))
	print(f"config={config_path}")
	print(f"train={train} ({train.stat().st_size // (1024 * 1024)} MB) valid={valid}")
	if args.dry_run:
		return
	subprocess.check_call(cmd)


if __name__ == "__main__":
	main()
