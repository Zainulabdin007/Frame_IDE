#!/usr/bin/env python3
"""
Install a trained MLX LoRA into the Frame workspace adapter registry.

Copies weights into:
  <workspace>/.frame/adapters/frame-agent-v1/
and writes metadata.json + registry.json so the sidebar picks it up
without a manual drop.

Note: Frame's llama.cpp worker prefers GGUF LoRA. This publishes the
MLX safetensors so the adapter is always registered; fuse→GGUF later
for full runtime apply (or replace weightFile with a .gguf).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ADAPTER_ID = "frame-agent-v1"
DEFAULT_SRC = ROOT / "adapters" / "frame-agent-v1"
# Frame_IDE repo root (parent of tools/)
DEFAULT_WORKSPACE = ROOT.parent.parent


def find_weight(src: Path) -> Path | None:
	preferred = src / "adapters.safetensors"
	if preferred.is_file() and preferred.stat().st_size > 1024:
		return preferred
	candidates = sorted(
		(p for p in src.glob("*.safetensors") if p.stat().st_size > 1024),
		key=lambda p: p.stat().st_mtime,
		reverse=True,
	)
	return candidates[0] if candidates else None


def publish(
	src: Path,
	workspace: Path,
	adapter_id: str = DEFAULT_ADAPTER_ID,
	activate: bool = True,
) -> Path:
	weight = find_weight(src)
	if not weight:
		raise SystemExit(f"No adapter weights in {src}")

	dest_dir = workspace / ".frame" / "adapters" / adapter_id
	dest_dir.mkdir(parents=True, exist_ok=True)

	weight_name = "adapters.safetensors"
	dest_weight = dest_dir / weight_name
	shutil.copy2(weight, dest_weight)

	# Keep config next to weights for debugging / future fuse.
	for name in ("adapter_config.json", "mlx_lora_config.yaml", "frame_train_meta.json"):
		p = src / name
		if p.is_file():
			shutil.copy2(p, dest_dir / name)

	now = int(time.time() * 1000)
	meta_path = dest_dir / "metadata.json"
	existing: dict = {}
	if meta_path.is_file():
		try:
			existing = json.loads(meta_path.read_text())
		except json.JSONDecodeError:
			existing = {}

	meta = {
		"id": adapter_id,
		"name": existing.get("name") or "Frame agent LoRA v1",
		"language": existing.get("language") or "frame",
		"version": existing.get("version") or "0.1.0",
		"baseModel": existing.get("baseModel") or "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
		"created": existing.get("created") or now,
		"trainingExamples": existing.get("trainingExamples") or 0,
		"lastUpdated": now,
		"scope": existing.get("scope") or "project",
		"kind": "lora",
		"state": "active" if activate else existing.get("state") or "available",
		"builtin": True,
		"description": existing.get("description")
		or "Built-in Frame agent behavior LoRA (edit plans, tools, small edits). Always on.",
		"weightFile": weight_name,
		"rank": existing.get("rank") or 16,
		"tags": existing.get("tags") or ["frame-agent", "frame-builtin", "builtin", "default", "mlx"],
	}
	meta_path.write_text(json.dumps(meta, indent=2) + "\n")

	# Soft-link note for operators.
	(dest_dir / "SOURCE.txt").write_text(
		f"Published from: {weight.resolve()}\n"
		f"Size: {dest_weight.stat().st_size} bytes\n"
		f"At: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
		"Runtime: GGUF LoRA preferred for node-llama-cpp; safetensors registered for UI + future MLX path.\n"
	)

	registry_path = workspace / ".frame" / "adapters" / "registry.json"
	registry: dict = {"version": 1, "updatedAt": now, "adapters": []}
	if registry_path.is_file():
		try:
			registry = json.loads(registry_path.read_text())
		except json.JSONDecodeError:
			pass
	adapters = [a for a in registry.get("adapters", []) if a.get("id") != adapter_id]
	adapters.insert(0, {
		"id": adapter_id,
		"name": meta["name"],
		"scope": meta["scope"],
		"language": meta.get("language"),
		"state": meta["state"],
		"version": meta["version"],
		"baseModelId": meta["baseModel"],
	})
	registry["adapters"] = adapters
	registry["updatedAt"] = now
	registry["version"] = registry.get("version") or 1
	registry_path.parent.mkdir(parents=True, exist_ok=True)
	registry_path.write_text(json.dumps(registry, indent=2) + "\n")

	# Ensure .frame is gitignored for weights.
	gi = workspace / ".frame" / ".gitignore"
	if not gi.exists():
		gi.write_text("*\n")

	print(f"Published {adapter_id} → {dest_dir}")
	print(f"  weight: {dest_weight} ({dest_weight.stat().st_size} bytes)")
	print(f"  state:  {meta['state']}")
	return dest_dir


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
	parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
	parser.add_argument("--id", default=DEFAULT_ADAPTER_ID)
	parser.add_argument("--no-activate", action="store_true")
	args = parser.parse_args()
	publish(args.src, args.workspace, args.id, activate=not args.no_activate)


if __name__ == "__main__":
	main()
