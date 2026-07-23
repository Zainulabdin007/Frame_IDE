#!/usr/bin/env python3
"""
Install the fused Frame-agent GGUF as the default local model.

Training produces MLX LoRA → fuse → convert → Q4_K_M GGUF. That full model
already includes foundation behavior, so it becomes runtime.json modelPath
(always on). Separate LoRA GGUF is not required for v1.

Also updates the builtin adapter metadata to reflect fused-into-base.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent.parent
DEFAULT_SRC = ROOT / "adapters" / "frame-agent-v1-gguf" / "frame-agent-v1-fused-q4_k_m.gguf"
ADAPTER_ID = "frame-agent-v1"


def _write_runtime(path: Path, model_path: Path) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	data: dict = {}
	if path.is_file():
		try:
			data = json.loads(path.read_text())
		except json.JSONDecodeError:
			data = {}
	data.update({
		"runtime": "llamacpp",
		"activeModelId": data.get("activeModelId") or "qwen-coder-7b-q4",
		"modelPath": str(model_path.resolve()),
		"enabled": True,
		"allowUnverifiedModels": data.get("allowUnverifiedModels", False),
		"updatedAt": int(time.time() * 1000),
	})
	path.write_text(json.dumps(data, indent=2) + "\n")
	print(f"Updated {path} → modelPath={model_path}")


def install(src: Path, workspace: Path = REPO) -> Path:
	if not src.is_file() or src.suffix.lower() != ".gguf":
		raise SystemExit(f"Expected fused .gguf, got: {src}")
	if src.stat().st_size < 1_000_000:
		raise SystemExit(f"GGUF too small: {src.stat().st_size} bytes")

	dest_models = workspace / ".frame" / "models"
	dest_models.mkdir(parents=True, exist_ok=True)
	dest = dest_models / "frame-agent-v1-fused-q4_k_m.gguf"

	resources = workspace / "resources" / "frame-models"
	resources.mkdir(parents=True, exist_ok=True)
	res_dest = resources / "frame-agent-v1-fused-q4_k_m.gguf"

	for target in (dest, res_dest):
		if target.resolve() == src.resolve():
			continue
		if target.exists() or target.is_symlink():
			target.unlink()
		try:
			os.link(src, target)
			print(f"Hardlinked → {target}")
		except OSError:
			shutil.copy2(src, target)
			print(f"Copied → {target} ({target.stat().st_size} bytes)")

	# Builtin adapter: always-on marker; weights live in the fused base GGUF.
	adapter_dir = workspace / ".frame" / "adapters" / ADAPTER_ID
	adapter_dir.mkdir(parents=True, exist_ok=True)
	now = int(time.time() * 1000)
	meta_path = adapter_dir / "metadata.json"
	existing: dict = {}
	if meta_path.is_file():
		try:
			existing = json.loads(meta_path.read_text())
		except json.JSONDecodeError:
			existing = {}
	# Remove LoRA weight pointer so worker does not double-apply safetensors.
	for stale in ("adapters.safetensors", "adapters.gguf"):
		p = adapter_dir / stale
		if p.is_file():
			# Keep safetensors backup aside; do not delete training artifact copy permanently —
			# rename so resolveAdapterWeightAbsolutePath won't pick it up.
			bak = adapter_dir / f"{stale}.bak"
			if not bak.exists():
				p.rename(bak)
				print(f"Moved aside {stale} → {bak.name} (fused into base model)")
	meta = {
		**existing,
		"id": ADAPTER_ID,
		"name": existing.get("name") or "Frame agent LoRA v1",
		"language": "frame",
		"version": existing.get("version") or "0.1.0",
		"baseModel": "qwen-coder-7b-q4",
		"created": existing.get("created") or now,
		"lastUpdated": now,
		"scope": "project",
		"kind": "lora",
		"state": "active",
		"builtin": True,
		"description": (
			"Built-in Frame agent behavior — fused into the default Q4_K_M GGUF "
			f"({dest.name}). Always on via runtime modelPath."
		),
		"weightFile": None,
		"rank": existing.get("rank") or 16,
		"tags": sorted(set([*(existing.get("tags") or []), "frame-agent", "frame-builtin", "builtin", "fused-into-base"])),
		"fusedModelPath": str(dest.resolve()),
	}
	# Drop null weightFile for cleaner JSON
	if meta.get("weightFile") is None:
		meta.pop("weightFile", None)
	meta_path.write_text(json.dumps(meta, indent=2) + "\n")

	registry_path = workspace / ".frame" / "adapters" / "registry.json"
	registry = {"version": 1, "updatedAt": now, "adapters": []}
	if registry_path.is_file():
		try:
			registry = json.loads(registry_path.read_text())
		except json.JSONDecodeError:
			pass
	adapters = [a for a in registry.get("adapters", []) if a.get("id") != ADAPTER_ID]
	adapters.insert(0, {
		"id": ADAPTER_ID,
		"name": meta["name"],
		"scope": "project",
		"language": "frame",
		"state": "active",
		"version": meta["version"],
		"baseModelId": meta["baseModel"],
	})
	registry["adapters"] = adapters
	registry["updatedAt"] = now
	registry_path.write_text(json.dumps(registry, indent=2) + "\n")

	_write_runtime(workspace / ".frame" / "config" / "runtime.json", dest)
	home_rt = Path.home() / ".frame" / "config" / "runtime.json"
	_write_runtime(home_rt, dest)

	print(f"\nDone. Frame default model → {dest}")
	print("Reload Frame (./scripts/launch-frame.sh) to load the fused agent GGUF.")
	return dest


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
	parser.add_argument("--workspace", type=Path, default=REPO)
	args = parser.parse_args()
	install(args.src, args.workspace)


if __name__ == "__main__":
	main()
