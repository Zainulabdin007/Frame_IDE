#!/usr/bin/env python3
"""
Quick eval: does the adapted model emit frame-edit-plan / frame-tool for core prompts?

Usage:
  python scripts/eval_adapter.py \\
    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \\
    --adapter-path adapters/frame-agent-v1
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROMPTS = [
	{
		"id": "append",
		"expect": "frame-edit-plan",
		"messages": [
			{
				"role": "system",
				"content": "You are Frame. Prefer ```frame-edit-plan for file changes.",
			},
			{
				"role": "user",
				"content": (
					"Active file: NOTES.md\nActive file contents:\n```\nhello\n```\n\n"
					'User request:\nadd "works" at the end of the file'
				),
			},
		],
	},
	{
		"id": "tool-read",
		"expect": "frame-tool",
		"messages": [
			{
				"role": "system",
				"content": "You are Frame. Prefer ```frame-tool when you need file contents.",
			},
			{
				"role": "user",
				"content": "show me the contents of src/app.ts",
			},
		],
	},
	{
		"id": "create-fn",
		"expect": "frame-edit-plan",
		"messages": [
			{
				"role": "system",
				"content": "You are Frame. Prefer ```frame-edit-plan for file changes.",
			},
			{
				"role": "user",
				"content": "create src/add.ts with a typed TypeScript add(a, b) function",
			},
		],
	},
]


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--model", default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")
	parser.add_argument("--adapter-path", type=Path, default=None)
	parser.add_argument("--max-tokens", type=int, default=512)
	args = parser.parse_args()

	try:
		from mlx_lm import generate, load
	except ImportError:
		print("Install mlx-lm first: pip install mlx-lm", file=sys.stderr)
		sys.exit(1)

	model, tokenizer = load(
		args.model,
		adapter_path=str(args.adapter_path) if args.adapter_path else None,
	)

	results = []
	for case in PROMPTS:
		prompt = tokenizer.apply_chat_template(
			case["messages"],
			tokenize=False,
			add_generation_prompt=True,
		)
		text = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens, verbose=False)
		ok = case["expect"] in text
		results.append({"id": case["id"], "ok": ok, "expect": case["expect"], "preview": text[:400]})
		print(f"[{'PASS' if ok else 'FAIL'}] {case['id']} (expect {case['expect']})")
		print(text[:500])
		print("---")

	passed = sum(1 for r in results if r["ok"])
	summary = {"passed": passed, "total": len(results), "results": results}
	out = Path(__file__).resolve().parents[1] / "evals" / "last_eval.json"
	out.parent.mkdir(parents=True, exist_ok=True)
	out.write_text(json.dumps(summary, indent=2) + "\n")
	print(json.dumps({"passed": passed, "total": len(results)}, indent=2))
	sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
	main()
