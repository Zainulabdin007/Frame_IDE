#!/usr/bin/env python3
"""
Convert CodeAlpaca-style instruction/output into Frame create/edit examples.
Only keeps samples that look like real code files (not prose answers).
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation."""


def looks_like_code(s: str) -> bool:
	if len(s) < 40 or len(s) > 12_000:
		return False
	cues = [
		"def ", "function ", "class ", "export ", "import ", "package ", "fn ",
		"const ", "return ", "void ", "public ", "private ", "System.out", "console.log",
		"let ", "var ", "=>", "#include",
	]
	hits = sum(1 for c in cues if c in s)
	return hits >= 1 and ("\n" in s)


def detect_ext(code: str, instruction: str) -> str:
	blob = (instruction + "\n" + code).lower()
	if "typescript" in blob or ".ts" in blob:
		return "ts"
	if "javascript" in blob or ".js" in blob:
		return "js"
	if "rust" in blob or "fn main" in code:
		return "rs"
	if "golang" in blob or "package main" in code:
		return "go"
	if "java" in blob:
		return "java"
	return "py"


def fence_strip(s: str) -> str:
	m = re.search(r"```(?:\w+)?\n([\s\S]*?)```", s)
	if m:
		return m.group(1).strip() + "\n"
	return s if s.endswith("\n") else s + "\n"


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--limit", type=int, default=12000)
	parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw" / "codealpaca_frame.jsonl")
	parser.add_argument("--seed", type=int, default=7)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	from datasets import load_dataset

	# Try a few known mirrors
	ds = None
	errors = []
	for name in ("HuggingFaceH4/CodeAlpaca_20K", "sahil2801/CodeAlpaca-20k", "flwrlabs/code-alpaca-20k"):
		try:
			print("loading", name)
			ds = load_dataset(name, split="train")
			print("loaded", name, len(ds))
			break
		except Exception as e:
			errors.append(f"{name}: {e}")
	if ds is None:
		raise SystemExit("Failed to load CodeAlpaca: " + "; ".join(errors))

	rows = []
	idxs = list(range(len(ds)))
	rng.shuffle(idxs)
	for i in idxs:
		if len(rows) >= args.limit:
			break
		obj = ds[i]
		# HuggingFaceH4/CodeAlpaca_20K uses prompt/completion;
		# classic CodeAlpaca uses instruction/input/output.
		prompt = (obj.get("prompt") or "").strip()
		instruction = (obj.get("instruction") or obj.get("question") or "").strip()
		inp = (obj.get("input") or "").strip()
		output = (obj.get("output") or obj.get("answer") or obj.get("completion") or "").strip()
		if prompt and not instruction:
			# Often "instruction\n<input context>"
			parts = prompt.split("\n", 1)
			instruction = parts[0].strip()
			if len(parts) > 1 and not inp:
				inp = parts[1].strip()
		if not instruction or not output:
			continue
		code = fence_strip(output)
		if not looks_like_code(code):
			continue
		ext = detect_ext(code, instruction + "\n" + prompt)
		path = f"src/alpaca_{len(rows):05d}.{ext}"
		if inp and looks_like_code(inp) and rng.random() < 0.45:
			# treat as modify
			before = fence_strip(inp)
			user = (
				f"Active file: {path}\nActive file contents:\n```\n{before}```\n\n"
				f"User request:\n{instruction}"
			)
			op = {
				"kind": "modify",
				"path": path,
				"newContent": code,
				"reason": "Apply CodeAlpaca-style edit.",
			}
		else:
			user = f"{instruction}\n\nWrite the result to `{path}`."
			if inp and not looks_like_code(inp):
				user = f"{instruction}\n\nContext:\n{inp}\n\nWrite the result to `{path}`."
			op = {
				"kind": "create",
				"path": path,
				"content": code,
				"reason": "Create from instruction.",
			}
		asst = (
			f"Working on `{path}`.\n\n"
			+ "```frame-edit-plan\n"
			+ json.dumps({"summary": instruction[:120], "operations": [op]}, indent=2)
			+ "\n```"
		)
		rows.append({
			"messages": [
				{"role": "system", "content": SYSTEM},
				{"role": "user", "content": user},
				{"role": "assistant", "content": asst},
			],
			"meta": {"source": "codealpaca"},
		})

	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as f:
		for r in rows:
			f.write(json.dumps(r, ensure_ascii=False) + "\n")
	print(json.dumps({"out": str(args.out), "rows": len(rows), "errors": errors}, indent=2))


if __name__ == "__main__":
	main()
