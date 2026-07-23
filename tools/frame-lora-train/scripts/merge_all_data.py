#!/usr/bin/env python3
"""
Merge synth + gold + mined vscode + public edits → deduped train/valid JSONL.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality_filter import validate_row  # noqa: E402
from gold_seeds import SYSTEM  # noqa: E402


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


def row_fp(row: dict) -> str:
	"""Deduplicate exact conversations, preserving useful prompt paraphrases."""
	key = json.dumps(row["messages"], ensure_ascii=False, sort_keys=True)
	return hashlib.sha1(key.encode("utf-8")).hexdigest()


def role_fp(row: dict, role: str) -> str:
	"""Fingerprint one side of a conversation for leakage-safe splitting."""
	content = [message.get("content", "") for message in row["messages"] if message.get("role") == role]
	key = json.dumps(content, ensure_ascii=False)
	return hashlib.sha1(key.encode("utf-8")).hexdigest()


def leakage_groups(rows: list[dict]) -> list[list[dict]]:
	"""Keep rows sharing either prompts or answers in the same split."""
	parent = list(range(len(rows)))

	def find(index: int) -> int:
		while parent[index] != index:
			parent[index] = parent[parent[index]]
			index = parent[index]
		return index

	def union(left: int, right: int) -> None:
		left_root, right_root = find(left), find(right)
		if left_root != right_root:
			parent[right_root] = left_root

	owners: dict[str, int] = {}
	for index, row in enumerate(rows):
		for role in ("user", "assistant"):
			key = f"{role}:{role_fp(row, role)}"
			if key in owners:
				union(index, owners[key])
			else:
				owners[key] = index
	groups: dict[int, list[dict]] = {}
	for index, row in enumerate(rows):
		groups.setdefault(find(index), []).append(row)
	return list(groups.values())


def canonicalize_protocol(row: dict) -> dict:
	"""Make every retained example teach the exact runtime control protocol."""
	messages = [dict(message) for message in row["messages"]]
	if messages and messages[0].get("role") == "system":
		messages[0]["content"] = SYSTEM
	return {**row, "messages": messages}


def write_jsonl(path: Path, rows: list[dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for row in rows:
			out = {"messages": row["messages"]}
			if isinstance(row.get("meta"), dict):
				out["meta"] = row["meta"]
			f.write(json.dumps(out, ensure_ascii=False) + "\n")


def main() -> None:
	root = Path(__file__).resolve().parents[1]
	parser = argparse.ArgumentParser()
	parser.add_argument("--processed", type=Path, default=root / "data" / "processed")
	parser.add_argument("--raw", type=Path, default=root / "data" / "raw")
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--valid-frac", type=float, default=0.04)
	parser.add_argument("--max-source-rows", type=int, default=20_000)
	parser.add_argument("--max-total-rows", type=int, default=160_000)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	sources = {
		"synth_train": args.processed / "generated_train.jsonl",
		"synth_valid": args.processed / "generated_valid.jsonl",
		"filtered_mined": args.raw / "filtered_mined.jsonl",
	}
	if not sources["synth_train"].exists():
		sources["synth_train"] = args.processed / "frame_agent_train.jsonl"
	if not sources["synth_valid"].exists():
		sources["synth_valid"] = args.processed / "frame_agent_valid.jsonl"
	# Pull all raw JSONL except intermediate filtered bundles (avoid recursion)
	for path in sorted(args.raw.glob("*.jsonl")):
		if path.name.startswith("filtered_"):
			continue
		sources[f"raw:{path.name}"] = path

	all_rows: list[dict] = []
	priority_rows: list[dict] = []
	counts_in: dict[str, object] = {}
	rejections: collections.Counter[str] = collections.Counter()
	for name, path in sources.items():
		loaded = load_jsonl(path)
		rows = []
		for row in loaded:
			row = canonicalize_protocol(row)
			issues = validate_row(row)
			if issues:
				rejections.update(issues)
			else:
				rows.append(row)
		rng.shuffle(rows)
		rows = rows[:args.max_source_rows]
		counts_in[name] = {"loaded": len(loaded), "valid_sampled": len(rows)}
		if name.startswith("synth_") or any(
			token in name.lower()
			for token in (
				"product_gold", "multiturn_gold", "recovery_gold", "frameai_modules",
				"protocol_tools", "protocol_inserts", "behavior_boost",
			)
		):
			priority_rows.extend(rows)
		else:
			all_rows.extend(rows)

	seen: set[str] = set()
	deduped: list[dict] = []
	rng.shuffle(priority_rows)
	rng.shuffle(all_rows)
	for row in [*priority_rows, *all_rows]:
		fp = row_fp(row)
		if fp in seen:
			continue
		seen.add(fp)
		deduped.append(row)

	if len(deduped) > args.max_total_rows:
		deduped = deduped[:args.max_total_rows]
	grouped_rows = leakage_groups(deduped)
	rng.shuffle(grouped_rows)
	valid_target = max(1, int(len(deduped) * args.valid_frac))
	valid: list[dict] = []
	train: list[dict] = []
	for group in grouped_rows:
		if len(valid) < valid_target:
			valid.extend(group)
		else:
			train.extend(group)
	rng.shuffle(train)
	rng.shuffle(valid)

	write_jsonl(args.processed / "train.jsonl", train)
	write_jsonl(args.processed / "valid.jsonl", valid)
	write_jsonl(args.processed / "frame_agent_train.jsonl", train)
	write_jsonl(args.processed / "frame_agent_valid.jsonl", valid)

	manifest = {
		"counts_in": counts_in,
		"deduped_total": len(deduped),
		"train": len(train),
		"valid": len(valid),
		"leakage_groups": len(grouped_rows),
		"removed_or_capped": len(priority_rows) + len(all_rows) - len(deduped),
		"strict_filter_rejections": dict(rejections.most_common()),
	}
	(args.processed / "merged_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
	print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
	main()
