#!/usr/bin/env python3
"""
Install a GGUF LoRA as the Frame built-in foundation adapter.

Copies into:
  1) tools/frame-lora-train/adapters/frame-agent-v1-gguf/adapters.gguf  (dev resolve)
  2) resources/frame-adapters/frame-agent-v1/adapters.gguf             (packaged resolve)
  3) <workspace>/.frame/adapters/frame-agent-v1/adapters.gguf          (sidebar mirror)

Does not convert weights — pass an already-converted .gguf LoRA file.
See FRAME_BUILTIN_ADAPTER.md for the MLX → GGUF path after training.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # tools/frame-lora-train
REPO = ROOT.parent.parent  # Frame_IDE
ADAPTER_ID = "frame-agent-v1"
WEIGHT_NAME = "adapters.gguf"


def install(gguf: Path, workspace: Path = REPO) -> None:
	if not gguf.is_file() or gguf.suffix.lower() != ".gguf":
		raise SystemExit(f"Expected a .gguf file, got: {gguf}")
	if gguf.stat().st_size < 1024:
		raise SystemExit(f"GGUF too small ({gguf.stat().st_size} bytes)")

	targets = [
		ROOT / "adapters" / "frame-agent-v1-gguf" / WEIGHT_NAME,
		REPO / "resources" / "frame-adapters" / ADAPTER_ID / WEIGHT_NAME,
		workspace / ".frame" / "adapters" / ADAPTER_ID / WEIGHT_NAME,
	]
	for dest in targets:
		dest.parent.mkdir(parents=True, exist_ok=True)
		shutil.copy2(gguf, dest)
		print(f"Installed → {dest} ({dest.stat().st_size} bytes)")

	# Keep registry metadata in sync (builtin + active).
	pub = ROOT / "scripts" / "publish_adapter_to_frame.py"
	if pub.is_file():
		import subprocess

		subprocess.check_call(
			[
				sys.executable,
				str(pub),
				"--src",
				str(ROOT / "adapters" / ADAPTER_ID),
				"--workspace",
				str(workspace),
			]
		)
		# Prefer GGUF weightFile over safetensors from publish.
		meta = workspace / ".frame" / "adapters" / ADAPTER_ID / "metadata.json"
		if meta.is_file():
			import json

			data = json.loads(meta.read_text())
			data["weightFile"] = WEIGHT_NAME
			data["builtin"] = True
			data["state"] = "active"
			tags = list(data.get("tags") or [])
			for t in ("frame-builtin", "builtin", "default"):
				if t not in tags:
					tags.append(t)
			data["tags"] = tags
			meta.write_text(json.dumps(data, indent=2) + "\n")
			print(f"Updated metadata weightFile → {WEIGHT_NAME}")


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("gguf", type=Path, help="Path to adapters.gguf (LoRA)")
	parser.add_argument("--workspace", type=Path, default=REPO)
	args = parser.parse_args()
	install(args.gguf, args.workspace)


if __name__ == "__main__":
	main()
