#!/usr/bin/env python3
"""
Extract individual export functions from VS Code TS files as compact create examples.

Quality focus: smaller, teachable units (one function per file) from professional code,
not whole 10kB modules.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation."""

FN_START = re.compile(
	r"(?m)^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\([^;{]*\)\s*(?::\s*[^{]+)?\{"
)


def extract_functions(text: str) -> list[tuple[str, str]]:
	out: list[tuple[str, str]] = []
	for m in FN_START.finditer(text):
		name = m.group(1)
		i = text.find("{", m.end() - 1)
		if i < 0:
			continue
		depth = 0
		j = i
		while j < len(text):
			if text[j] == "{":
				depth += 1
			elif text[j] == "}":
				depth -= 1
				if depth == 0:
					j += 1
					break
			j += 1
		else:
			continue
		while j < len(text) and text[j] in "\r\n":
			j += 1
		body = text[m.start() : j]
		if 40 < len(body) < 2500:
			out.append((name, body if body.endswith("\n") else body + "\n"))
	return out


def main() -> None:
	repo = Path(__file__).resolve().parents[3]
	parser = argparse.ArgumentParser()
	parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw" / "vscode_functions.jsonl")
	parser.add_argument("--max-rows", type=int, default=10000)
	parser.add_argument("--seed", type=int, default=17)
	parser.add_argument("--root", action="append", type=Path, default=None)
	parser.add_argument("--skip-part", action="append", default=None)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	if args.root:
		roots = [r if r.is_absolute() else repo / r for r in args.root]
	else:
		roots = [
			repo / "vscode/src/vs/base/common",
			repo / "vscode/src/vs/platform",
			repo / "vscode/src/vs/editor/common",
			repo / "vscode/src/vs/workbench/contrib/frameAI",
		]
	skip_extra = set(args.skip_part or [])
	files: list[Path] = []
	for root in roots:
		if root.exists():
			files.extend(
				p for p in root.rglob("*.ts")
				if not p.name.endswith(".d.ts")
				and "test" not in p.parts
				and not (skip_extra and any(x in p.parts for x in skip_extra))
			)
	rng.shuffle(files)

	rows: list[str] = []
	seen: set[str] = set()
	for path in files:
		if len(rows) >= args.max_rows:
			break
		try:
			raw = path.read_bytes()
		except OSError:
			continue
		if len(raw) > 40_000:
			continue
		try:
			text = raw.decode("utf-8")
		except UnicodeDecodeError:
			continue
		for name, body in extract_functions(text):
			rel = f"src/extracted/{name}.ts"
			user = rng.choice([
				f"create {rel} with export function {name} matching typical VS Code style",
				f"write a TypeScript helper `{name}` to {rel}",
				f"add {rel} implementing `{name}`",
			])
			asst = (
				f"Creating `{rel}` with `{name}`.\n\n"
				+ "```frame-edit-plan\n"
				+ json.dumps({
					"summary": f"Create {name}",
					"operations": [{
						"kind": "create",
						"path": rel,
						"content": body,
						"reason": "Extracted professional function unit from VS Code tree.",
					}],
				}, indent=2)
				+ "\n```"
			)
			line = json.dumps({
				"messages": [
					{"role": "system", "content": SYSTEM},
					{"role": "user", "content": user},
					{"role": "assistant", "content": asst},
				],
				"meta": {"source": "vscode-fn-extract"},
			}, ensure_ascii=False)
			h = hashlib.sha1(line.encode()).hexdigest()
			if h in seen:
				continue
			seen.add(h)
			rows.append(line)
			if len(rows) >= args.max_rows:
				break

	args.out.parent.mkdir(parents=True, exist_ok=True)
	args.out.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
	print(json.dumps({"rows": len(rows), "out": str(args.out)}, indent=2))


if __name__ == "__main__":
	main()
