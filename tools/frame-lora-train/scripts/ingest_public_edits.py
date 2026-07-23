#!/usr/bin/env python3
"""
Ingest public code-edit datasets and convert to Frame ```frame-edit-plan``` JSONL.

Sources (downloaded locally when available):
- likaixin/InstructCoder (instruction + input + output code)
- kseniasych/Code-Edits-EditPackFT (old/new file contents + instruction)

We do NOT call cloud inference. We only reshape published examples into Frame format.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation."""


def edit_plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def row(user: str, assistant: str, source: str) -> dict:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": source},
	}


def guess_path(lang: str | None, fallback: str) -> str:
	ext = {
		"python": "py",
		"py": "py",
		"javascript": "js",
		"js": "js",
		"typescript": "ts",
		"ts": "ts",
		"java": "java",
		"go": "go",
		"rust": "rs",
		"c": "c",
		"cpp": "cpp",
		"c++": "cpp",
	}.get((lang or "").lower(), "txt")
	return f"src/edit_sample.{ext}" if fallback == "edit" else f"src/sample.{ext}"


def convert_instructcoder_obj(obj: dict, rng: random.Random) -> dict | None:
	"""
	Flexible field mapping — InstructCoder variants differ.
	Expect something like instruction/input/output or prompt/code/edited.
	"""
	instruction = (
		obj.get("instruction")
		or obj.get("Instruction")
		or obj.get("prompt")
		or obj.get("task")
		or ""
	)
	before = (
		obj.get("input")
		or obj.get("Input")
		or obj.get("code")
		or obj.get("old_contents")
		or obj.get("before")
		or ""
	)
	after = (
		obj.get("output")
		or obj.get("Output")
		or obj.get("edited_code")
		or obj.get("new_contents")
		or obj.get("after")
		or ""
	)
	lang = obj.get("language") or obj.get("lang") or obj.get("programming_language")
	if not instruction or not after:
		return None
	# Cap sizes for LoRA context
	if len(str(after)) > 12_000 or len(str(before)) > 12_000:
		return None
	if len(str(after)) < 20:
		return None

	path = obj.get("path") or obj.get("new_file") or obj.get("old_file") or guess_path(lang, "edit")
	path = str(path).lstrip("./")
	if "/" not in path:
		path = f"src/{path}"

	instruction = str(instruction).strip()
	before = str(before)
	after = str(after)

	if before.strip():
		user = (
			f"Active file: {path}\nActive file contents:\n```\n{before}```\n\n"
			f"User request:\n{instruction}"
		)
		op = {
			"kind": "modify",
			"path": path,
			"newContent": after if after.endswith("\n") else after + "\n",
			"reason": "Apply requested code edit.",
		}
	else:
		user = f"User request:\n{instruction}\n\nCreate or write file `{path}`."
		op = {
			"kind": "create",
			"path": path,
			"content": after if after.endswith("\n") else after + "\n",
			"reason": "Create file from instruction.",
		}

	asst = (
		f"Applying the edit to `{path}`.\n\n"
		+ edit_plan(instruction[:120], [op])
	)
	return row(user, asst, "instructcoder")


def convert_editpack_obj(obj: dict) -> dict | None:
	instruction = obj.get("instruction") or obj.get("content") or ""
	before = obj.get("old_contents") or ""
	after = obj.get("new_contents") or ""
	path = obj.get("new_file") or obj.get("old_file") or "src/sample.py"
	if not instruction or not after:
		return None
	if len(str(after)) > 12_000 or len(str(before)) > 12_000:
		return None
	path = str(path).lstrip("./")
	before = str(before)
	after = str(after)
	instruction = str(instruction).strip()
	# EditPack sometimes embeds instruction markdown; take first line-ish
	instruction = re.sub(r"^#+\s*", "", instruction)
	instruction = instruction.split("\n")[0][:240] or "Apply the code edit."

	user = (
		f"Active file: {path}\nActive file contents:\n```\n{before}```\n\n"
		f"User request:\n{instruction}"
	)
	asst = (
		f"Updating `{path}`.\n\n"
		+ edit_plan(
			instruction[:120],
			[{
				"kind": "modify",
				"path": path,
				"newContent": after if after.endswith("\n") else after + "\n",
				"reason": "Code edit from EditPack-style example.",
			}],
		)
	)
	return row(user, asst, "editpack")


def try_load_hf(name: str, split: str, limit: int) -> list[dict]:
	try:
		from datasets import load_dataset
	except ImportError:
		print("datasets not installed; pip install datasets", file=sys.stderr)
		return []
	print(f"loading {name} split={split} ...")
	ds = load_dataset(name, split=split)
	rows = []
	n = min(limit, len(ds))
	for i in range(n):
		rows.append(dict(ds[i]))
	return rows


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw")
	parser.add_argument("--instructcoder-limit", type=int, default=8000)
	parser.add_argument("--editpack-limit", type=int, default=6000)
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--skip-download", action="store_true")
	args = parser.parse_args()
	rng = random.Random(args.seed)
	args.out_dir.mkdir(parents=True, exist_ok=True)

	converted: list[dict] = []
	report: dict = {"sources": {}}

	if not args.skip_download:
		# InstructCoder
		for split in ("train", "Train", "train[:8000]"):
			try:
				raw = try_load_hf("likaixin/InstructCoder", split if ":" in split or split.islower() else "train", args.instructcoder_limit)
				if raw:
					ok = 0
					for obj in raw:
						row_ = convert_instructcoder_obj(obj, rng)
						if row_:
							converted.append(row_)
							ok += 1
					report["sources"]["instructcoder"] = {"raw": len(raw), "converted": ok}
					break
			except Exception as e:
				report.setdefault("errors", []).append(f"InstructCoder {split}: {e}")

		# EditPack
		try:
			raw = try_load_hf("kseniasych/Code-Edits-EditPackFT", "train", args.editpack_limit)
			ok = 0
			for obj in raw:
				row_ = convert_editpack_obj(obj)
				if row_:
					converted.append(row_)
					ok += 1
			report["sources"]["editpack"] = {"raw": len(raw), "converted": ok}
		except Exception as e:
			report.setdefault("errors", []).append(f"EditPack: {e}")

	# Also convert any local JSONL dumps dropped into raw/incoming/
	incoming = args.out_dir / "incoming"
	if incoming.exists():
		local_ok = 0
		for path in incoming.glob("*.jsonl"):
			for line in path.read_text(encoding="utf-8").splitlines():
				if not line.strip():
					continue
				obj = json.loads(line)
				row_ = convert_instructcoder_obj(obj, rng) or convert_editpack_obj(obj)
				if row_:
					converted.append(row_)
					local_ok += 1
		report["sources"]["local_incoming"] = local_ok

	rng.shuffle(converted)
	out = args.out_dir / "public_code_edits.jsonl"
	with out.open("w", encoding="utf-8") as f:
		for r in converted:
			f.write(json.dumps({"messages": r["messages"], "meta": r.get("meta")}, ensure_ascii=False) + "\n")
	report["out"] = str(out)
	report["total_converted"] = len(converted)
	(args.out_dir / "public_code_edits.manifest.json").write_text(json.dumps(report, indent=2) + "\n")
	print(json.dumps(report, indent=2))


if __name__ == "__main__":
	main()
