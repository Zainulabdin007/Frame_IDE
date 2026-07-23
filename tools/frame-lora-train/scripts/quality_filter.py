#!/usr/bin/env python3
"""Validate Frame JSONL: edit-plan/tool JSON must parse; drop broken rows."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

EDIT = re.compile(r"```frame-edit-plan\s*\n([\s\S]*?)```", re.I)
TOOL = re.compile(r"```frame-tool\s*\n([\s\S]*?)```", re.I)


def ok_row(row: dict) -> bool:
	msgs = row.get("messages")
	if not isinstance(msgs, list) or len(msgs) < 2:
		return False
	asst = [m.get("content", "") for m in msgs if m.get("role") == "assistant"]
	if not asst:
		return False
	text = asst[-1]
	if len(text) > 80_000:
		return False
	m = EDIT.search(text)
	if m:
		try:
			payload = json.loads(m.group(1))
		except json.JSONDecodeError:
			return False
		ops = payload.get("operations")
		if not isinstance(ops, list) or not ops:
			return False
		for op in ops:
			if not isinstance(op, dict) or "kind" not in op:
				return False
			kind = op["kind"]
			if kind == "modify" and "newContent" not in op:
				return False
			if kind == "create" and "content" not in op:
				return False
			if kind == "delete" and "path" not in op:
				return False
			if kind == "rename" and ("fromPath" not in op or "toPath" not in op):
				return False
		return True
	t = TOOL.search(text)
	if t:
		try:
			payload = json.loads(t.group(1))
		except json.JSONDecodeError:
			return False
		return isinstance(payload, dict) and "name" in payload
	# plain answers allowed if short
	return len(text) < 2000


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("inputs", nargs="+", type=Path)
	parser.add_argument("--out", type=Path, required=True)
	args = parser.parse_args()
	kept = dropped = 0
	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as out:
		for path in args.inputs:
			if not path.exists():
				continue
			if path.name.startswith("filtered_"):
				continue
			try:
				fh = path.open("r", encoding="utf-8", errors="replace")
			except OSError:
				continue
			with fh:
				for line in fh:
					if not line.strip():
						continue
					try:
						row = json.loads(line)
					except json.JSONDecodeError:
						dropped += 1
						continue
					if ok_row(row):
						out.write(json.dumps({"messages": row["messages"]}, ensure_ascii=False) + "\n")
						kept += 1
					else:
						dropped += 1
	print(json.dumps({"kept": kept, "dropped": dropped, "out": str(args.out)}, indent=2))


if __name__ == "__main__":
	main()
