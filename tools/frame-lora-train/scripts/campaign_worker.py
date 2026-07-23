#!/usr/bin/env python3
"""
Standalone multi-hour novel data worker (no agent wake loop required).

Every cycle: write novel_tickN.jsonl → quality filter → append unique to
filtered_mined → remelt train/valid → log campaign.md.

Usage:
  python3 scripts/campaign_worker.py --hours 2.5 --cycle-minutes 12
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
LOG = ROOT / "logs" / "campaign.md"

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation."""


def plan(s: str, ops: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": s, "operations": ops}, indent=2) + "\n```"


def fp(line: str) -> str:
	return hashlib.sha1(line.encode()).hexdigest()


def gen_novel(seed: int, n_each: int = 1200) -> list[dict]:
	rng = random.Random(seed)
	rows: list[dict] = []
	for _ in range(n_each):
		n = rng.randint(1_000_000, 9_999_999)
		kind = rng.choice(["ts_bug", "py_bug", "test", "yaml", "css", "json", "rename", "delete"])
		if kind == "ts_bug":
			path = f"src/mod_{n}.ts"
			before = f"export function idx(arr: number[], i: number): number {{\n\treturn arr[i]!;\n}}\n"
			after = f"export function idx(arr: number[], i: number): number {{\n\tif (i < 0 || i >= arr.length) {{\n\t\tthrow new RangeError('index out of bounds');\n\t}}\n\treturn arr[i]!;\n}}\n"
			req = rng.choice(["bounds-check idx", "throw if index out of range", "guard idx against OOB"])
			op = {"kind": "modify", "path": path, "newContent": after, "reason": req}
			user = f"Active file: {path}\nActive file contents:\n```\n{before}```\n\nUser request:\n{req}"
		elif kind == "py_bug":
			path = f"src/mod_{n}.py"
			before = f"def get(d, k):\n    return d[k]\n"
			after = f"def get(d: dict, k: str, default=None):\n    return d.get(k, default)\n"
			req = "use .get with default instead of KeyError"
			op = {"kind": "modify", "path": path, "newContent": after, "reason": req}
			user = f"Active file: {path}\nActive file contents:\n```\n{before}```\n\nUser request:\n{req}"
		elif kind == "test":
			name = rng.choice(["clip", "wrap", "fold", "expand", "shrink"])
			path = f"src/{name}_{n}.ts"
			code = f"export function {name}(n: number, lo: number, hi: number): number {{\n\treturn Math.min(hi, Math.max(lo, n));\n}}\n"
			test = (
				"import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
				f"import {{ {name} }} from '../src/{name}_{n}.ts';\n\n"
				f"test('{name}', () => {{\n\tassert.equal({name}(5, 0, 3), 3);\n}});\n"
			)
			req = f"create {path} and tests/{name}_{n}.test.ts"
			ops = [
				{"kind": "create", "path": path, "content": code, "reason": "impl"},
				{"kind": "create", "path": f"tests/{name}_{n}.test.ts", "content": test, "reason": "test"},
			]
			asst = f"Creating `{name}` and test.\n\n" + plan(f"Add {name}", ops)
			rows.append({
				"messages": [
					{"role": "system", "content": SYSTEM},
					{"role": "user", "content": req},
					{"role": "assistant", "content": asst},
				]
			})
			continue
		elif kind == "yaml":
			path = f"config/cfg_{n}.yaml"
			before = "app:\n  name: frame\n  env: dev\n"
			after = "app:\n  name: frame\n  env: prod\n  replicas: 2\n"
			req = "set env to prod and replicas 2"
			op = {"kind": "modify", "path": path, "newContent": after, "reason": req}
			user = f"Active file: {path}\nActive file contents:\n```\n{before}```\n\nUser request:\n{req}"
		elif kind == "css":
			path = f"styles/s_{n}.css"
			before = "body { margin: 0; }\n"
			after = "body { margin: 0; padding: 0; }\n"
			req = "add padding: 0 to body"
			op = {"kind": "modify", "path": path, "newContent": after, "reason": req}
			user = f"Active file: {path}\nActive file contents:\n```\n{before}```\n\nUser request:\n{req}"
		elif kind == "json":
			path = f"config/j_{n}.json"
			before = '{\n  "logLevel": "info"\n}\n'
			after = '{\n  "logLevel": "debug"\n}\n'
			req = "set logLevel to debug"
			op = {"kind": "modify", "path": path, "newContent": after, "reason": req}
			user = f"Active file: {path}\nActive file contents:\n```\n{before}```\n\nUser request:\n{req}"
		elif kind == "rename":
			src = f"src/old_{n}.ts"
			dst = f"src/new_{n}.ts"
			req = f"rename {src} to {dst}"
			asst = f"Renaming.\n\n" + plan("Rename", [{"kind": "rename", "fromPath": src, "toPath": dst, "reason": "User rename."}])
			rows.append({
				"messages": [
					{"role": "system", "content": SYSTEM},
					{"role": "user", "content": req},
					{"role": "assistant", "content": asst},
				]
			})
			continue
		else:
			path = f"tmp/scratch_{n}.txt"
			req = f"delete {path}"
			asst = f"Deleting `{path}`.\n\n" + plan("Delete", [{"kind": "delete", "path": path, "reason": "User delete."}])
			rows.append({
				"messages": [
					{"role": "system", "content": SYSTEM},
					{"role": "user", "content": req},
					{"role": "assistant", "content": asst},
				]
			})
			continue

		asst = f"Updating `{path}`.\n\n" + plan(req, [op])
		rows.append({
			"messages": [
				{"role": "system", "content": SYSTEM},
				{"role": "user", "content": user},
				{"role": "assistant", "content": asst},
			]
		})
	return rows


def fold_unique(rows: list[dict], batch_path: Path) -> int:
	lines = [json.dumps({"messages": r["messages"]}, ensure_ascii=False) for r in rows]
	batch_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
	base = RAW / "filtered_mined.jsonl"
	seen: set[str] = set()
	if base.exists():
		with base.open() as f:
			for line in f:
				if line.strip():
					seen.add(fp(line.strip()))
	added = 0
	with base.open("a") as out:
		for line in lines:
			h = fp(line)
			if h in seen:
				continue
			seen.add(h)
			out.write(line + "\n")
			added += 1
	return added


def remelt() -> dict:
	subprocess.check_call([sys.executable, str(ROOT / "scripts" / "merge_all_data.py")], cwd=str(ROOT))
	subprocess.check_call([
		sys.executable, str(ROOT / "scripts" / "quality_filter.py"),
		str(PROCESSED / "train.jsonl"), str(PROCESSED / "valid.jsonl"),
		"--out", str(PROCESSED / "filtered_bundle.jsonl"),
	], cwd=str(ROOT))
	rows = []
	with (PROCESSED / "filtered_bundle.jsonl").open() as f:
		for line in f:
			line = line.strip()
			if not line:
				continue
			try:
				obj = json.loads(line)
			except json.JSONDecodeError:
				continue
			if "messages" in obj:
				rows.append(obj)
	rng = random.Random(7)
	rng.shuffle(rows)
	cut = max(1, int(len(rows) * 0.96))
	train, valid = rows[:cut], rows[cut:]
	for name, part in [
		("train.jsonl", train),
		("valid.jsonl", valid),
		("frame_agent_train.jsonl", train),
		("frame_agent_valid.jsonl", valid),
	]:
		with (PROCESSED / name).open("w") as out:
			for r in part:
				out.write(json.dumps({"messages": r["messages"]}, ensure_ascii=False) + "\n")
	meta = {
		"train": len(train),
		"valid": len(valid),
		"total": len(rows),
		"train_mb": round((PROCESSED / "train.jsonl").stat().st_size / 1e6, 1),
	}
	(PROCESSED / "merged_manifest.json").write_text(json.dumps(meta, indent=2) + "\n")
	return meta


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--hours", type=float, default=2.5)
	parser.add_argument("--cycle-minutes", type=float, default=12.0)
	parser.add_argument("--per-cycle", type=int, default=1200)
	args = parser.parse_args()
	deadline = time.time() + args.hours * 3600
	cycle = 0
	LOG.parent.mkdir(parents=True, exist_ok=True)
	LOG.open("a").write(
		f"\n## campaign_worker start {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} "
		f"hours={args.hours} cycle_min={args.cycle_minutes}\n"
	)
	while time.time() < deadline:
		cycle += 1
		seed = int(time.time()) ^ (cycle * 7919)
		rows = gen_novel(seed, args.per_cycle)
		raw_path = RAW / f"novel_worker_{cycle}.jsonl"
		added = fold_unique(rows, raw_path)
		try:
			meta = remelt()
		except Exception as e:
			meta = {"error": str(e)}
		msg = (
			f"## worker cycle {cycle} {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
			f"- generated={len(rows)} added_unique={added} remelt={meta}\n"
		)
		LOG.open("a").write(msg)
		print(msg, flush=True)
		remaining = deadline - time.time()
		if remaining <= 0:
			break
		time.sleep(min(args.cycle_minutes * 60, remaining))
	LOG.open("a").write(
		f"## campaign_worker done {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
	)


if __name__ == "__main__":
	main()
