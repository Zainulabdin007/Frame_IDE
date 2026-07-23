#!/usr/bin/env python3
"""
Fuse MLX LoRA into base weights, then print next steps for GGUF export.

Frame's llama.cpp worker loads .gguf (optionally with GGUF LoRA files).
The reliable path after MLX train: fuse → convert/quantize to a new Q4 GGUF,
then point runtime.json modelPath at that file.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> None:
	root = Path(__file__).resolve().parents[1]
	parser = argparse.ArgumentParser()
	parser.add_argument("--model", default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")
	parser.add_argument("--adapter-path", type=Path, default=root / "adapters" / "frame-agent-v1")
	parser.add_argument("--out", type=Path, default=root / "adapters" / "frame-agent-v1-fused")
	parser.add_argument("--dry-run", action="store_true")
	args = parser.parse_args()

	if not (args.adapter_path / "adapters.safetensors").exists() and not list(args.adapter_path.glob("*.safetensors")):
		print(f"No adapter weights in {args.adapter_path}", file=sys.stderr)
		sys.exit(1)

	cmd = [
		sys.executable,
		"-m",
		"mlx_lm.fuse",
		"--model",
		args.model,
		"--adapter-path",
		str(args.adapter_path),
		"--save-path",
		str(args.out),
	]
	print("Running:", " ".join(cmd))
	if args.dry_run:
		return
	subprocess.check_call(cmd)
	print(
		f"""
Fused model saved to: {args.out}

To use in Frame (recommended):
  1. Convert + quantize to GGUF Q4_K_M with llama.cpp (convert_hf_to_gguf.py + llama-quantize).
  2. Set .frame/config/runtime.json modelPath to that GGUF.
  3. Restart Frame / reload model.

Eval still works in MLX without GGUF:
  python scripts/eval_adapter.py --adapter-path {args.adapter_path}
"""
	)


if __name__ == "__main__":
	main()
