#!/usr/bin/env python3
"""
Merge synth + gold + mined vscode + public edits → deduped train/valid JSONL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
	if not path.exists():
		return []
	rows = []
	# Stream line-by-line so concurrent writers / huge files don't explode memory
	# or leave us with a half-written last line as a hard failure.
	try:
		with path.open("r", encoding="utf-8", errors="replace") as f:
			for line in f:
				if not line.strip():
					continue
				try:
					obj = json.loads(line)
				except json.JSONDecodeError:
					continue
				if "messages" not in obj:
					continue
				rows.append(obj)
	except OSError:
		return []
	return rows


def asst_fp(row: dict) -> str:
	asst = [m["content"] for m in row["messages"] if m["role"] == "assistant"]
	key = asst[-1] if asst else json.dumps(row["messages"], ensure_ascii=False)
	return hashlib.sha1(key.encode("utf-8")).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for row in rows:
			f.write(json.dumps({"messages": row["messages"]}, ensure_ascii=False) + "\n")


def main() -> None:
	root = Path(__file__).resolve().parents[1]
	parser = argparse.ArgumentParser()
	parser.add_argument("--processed", type=Path, default=root / "data" / "processed")
	parser.add_argument("--raw", type=Path, default=root / "data" / "raw")
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--valid-frac", type=float, default=0.04)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	sources = {
		"synth_train": args.processed / "frame_agent_train.jsonl",
		"synth_valid": args.processed / "frame_agent_valid.jsonl",
		"filtered_mined": args.raw / "filtered_mined.jsonl",
	}
	# Pull all raw JSONL except intermediate filtered bundles (avoid recursion)
	for path in sorted(args.raw.glob("*.jsonl")):
		if path.name.startswith("filtered_"):
			continue
		sources[f"raw:{path.name}"] = path

	all_rows: list[dict] = []
	counts_in: dict[str, int] = {}
	for name, path in sources.items():
		rows = load_jsonl(path)
		counts_in[name] = len(rows)
		all_rows.extend(rows)

	seen: set[str] = set()
	deduped: list[dict] = []
	for row in all_rows:
		fp = asst_fp(row)
		if fp in seen:
			continue
		seen.add(fp)
		deduped.append(row)

	rng.shuffle(deduped)
	cut = max(1, int(len(deduped) * (1.0 - args.valid_frac)))
	train, valid = deduped[:cut], deduped[cut:]

	write_jsonl(args.processed / "train.jsonl", train)
	write_jsonl(args.processed / "valid.jsonl", valid)
	write_jsonl(args.processed / "frame_agent_train.jsonl", train)
	write_jsonl(args.processed / "frame_agent_valid.jsonl", valid)

	manifest = {
		"counts_in": counts_in,
		"deduped_total": len(deduped),
		"train": len(train),
		"valid": len(valid),
		"removed_dupes": len(all_rows) - len(deduped),
	}
	(args.processed / "merged_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
	print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
	main()
