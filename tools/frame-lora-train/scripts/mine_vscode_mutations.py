#!/usr/bin/env python3
"""
Deeper VS Code mining pass: surgical mutations on real professional files.

For each eligible .ts file, produce several BEFORE→AFTER full-file pairs:
- insert JSDoc above first export function
- append a trivial exported constant (then teach remove)
- rename a local unused-looking const if safe patterns exist
- fix double-spaces / trailing whitespace cleanup
- add 'readonly' on a simple interface field when present

These are intentional, verifiable edits grounded in Microsoft/VS Code style code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import time
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation. Never invent tool results."""

FN_RE = re.compile(
	r"(?m)^(export\s+(?:async\s+)?function\s+[A-Za-z0-9_]+)"
)
IFACE_FIELD_RE = re.compile(r"(?m)^(\t|  )([A-Za-z0-9_]+)(\??:\s*)")


def plan(summary: str, ops: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": ops}, indent=2) + "\n```"


def chat(user: str, asst: str, source: str) -> dict:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": asst},
		],
		"meta": {"source": source},
	}


def active(path: str, body: str, req: str) -> str:
	return f"Active file: {path}\nActive file contents:\n```\n{body}```\n\nUser request:\n{req}"


def modify_row(path: str, before: str, after: str, req: str, reason: str, source: str) -> dict:
	asst = (
		f"Updating `{path}`.\n\n"
		+ plan(reason, [{
			"kind": "modify",
			"path": path,
			"newContent": after if after.endswith("\n") else after + "\n",
			"reason": reason,
		}])
	)
	return chat(active(path, before, req), asst, source)


def read_ok(path: Path, max_bytes: int) -> str | None:
	try:
		b = path.read_bytes()
	except OSError:
		return None
	if not (120 < len(b) <= max_bytes):
		return None
	try:
		t = b.decode("utf-8")
	except UnicodeDecodeError:
		return None
	if "\x00" in t:
		return None
	return t


def mutate_jsdoc(text: str) -> tuple[str, str, str] | None:
	m = FN_RE.search(text)
	if not m:
		return None
	# skip if already has jsdoc immediately above
	prefix = text[max(0, m.start() - 80) : m.start()]
	if "/**" in prefix:
		return None
	name_m = re.search(r"function\s+([A-Za-z0-9_]+)", m.group(1))
	name = name_m.group(1) if name_m else "helper"
	insert = f"/** {name} — keep public behavior stable. */\n"
	after = text[: m.start()] + insert + text[m.start() :]
	req = f"add a one-line JSDoc above `{name}` saying to keep public behavior stable"
	return text, after, req


def mutate_append_const(text: str, token: str) -> tuple[str, str, str] | None:
	if f"FRAME_TRAIN_{token}" in text:
		return None
	after = text if text.endswith("\n") else text + "\n"
	after += f"\nexport const FRAME_TRAIN_{token} = true;\n"
	req = f"append `export const FRAME_TRAIN_{token} = true;` at the end of the file"
	return text, after, req


def mutate_trim_trailing(text: str) -> tuple[str, str, str] | None:
	lines = text.splitlines(True)
	changed = False
	new_lines = []
	for line in lines:
		if line.endswith(" \n") or line.endswith("\t\n"):
			changed = True
			new_lines.append(line.rstrip() + "\n")
		elif "  " in line and not line.lstrip().startswith("*"):
			# only collapse accidental triple spaces in code lines lightly
			if "   " in line:
				nl = re.sub(r" {3,}", "  ", line)
				if nl != line:
					changed = True
					line = nl
			new_lines.append(line)
		else:
			new_lines.append(line)
	if not changed:
		# force a benign trailing newline normalize
		after = text.replace("\r\n", "\n")
		if after == text:
			return None
		return text, after, "normalize line endings to \\n only"
	after = "".join(new_lines)
	return text, after, "trim trailing whitespace on lines that have it"


def mutate_readonly_iface(text: str) -> tuple[str, str, str] | None:
	# Find first interface block field without readonly
	m = re.search(r"(?ms)^export interface ([A-Za-z0-9_]+) \{([^}]*)\}", text)
	if not m:
		return None
	body = m.group(2)
	fm = re.search(r"(?m)^(\t|  )(?!readonly\b)([A-Za-z0-9_]+)(\??:)", body)
	if not fm:
		return None
	field = fm.group(2)
	new_body = body[: fm.start()] + fm.group(1) + "readonly " + fm.group(2) + fm.group(3) + body[fm.end() :]
	after = text[: m.start(2)] + new_body + text[m.end(2) :]
	req = f"make interface field `{field}` readonly"
	return text, after, req


def mutate_todo_comment(text: str) -> tuple[str, str, str] | None:
	if "TODO(frame-train)" in text:
		return None
	m = FN_RE.search(text)
	if not m:
		return None
	insert = "\t// TODO(frame-train): consider consolidating helpers\n"
	# insert after opening brace of function
	brace = text.find("{", m.end() - 1)
	if brace < 0:
		return None
	after = text[: brace + 1] + "\n" + insert + text[brace + 1 :]
	req = "add a TODO comment inside the first exported function about consolidating helpers"
	return text, after, req


def fp(row: dict) -> str:
	asst = [m["content"] for m in row["messages"] if m["role"] == "assistant"][-1]
	return hashlib.sha1(asst.encode()).hexdigest()


def main() -> None:
	t0 = time.time()
	repo = Path(__file__).resolve().parents[3]
	parser = argparse.ArgumentParser()
	parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw" / "vscode_mutations.jsonl")
	parser.add_argument("--max-rows", type=int, default=12000)
	parser.add_argument("--max-file-bytes", type=int, default=14000)
	parser.add_argument("--seed", type=int, default=11)
	parser.add_argument("--root", action="append", type=Path, default=None)
	parser.add_argument("--skip-part", action="append", default=None)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	if args.root:
		roots = [r if r.is_absolute() else repo / r for r in args.root]
	else:
		roots = [
			repo / "vscode/src/vs/base/common",
			repo / "vscode/src/vs/base/browser",
			repo / "vscode/src/vs/platform",
			repo / "vscode/src/vs/editor/common",
			repo / "vscode/src/vs/workbench/contrib/frameAI",
			repo / "vscode/src/vs/workbench/services",
			repo / "vscode/src/vs/workbench/api",
		]
	skip_extra = set(args.skip_part or [])
	files: list[Path] = []
	for root in roots:
		if not root.exists():
			continue
		for p in root.rglob("*.ts"):
			if p.name.endswith(".d.ts"):
				continue
			if any(x in p.parts for x in ("test", "tests", "node_modules", "fixtures")):
				continue
			if skip_extra and any(x in p.parts for x in skip_extra):
				continue
			files.append(p)
	rng.shuffle(files)
	print("files", len(files))

	rows: list[dict] = []
	seen: set[str] = set()
	tokens = ["A", "B", "C", "D", "E", "F", "G", "H"]

	for path in files:
		if len(rows) >= args.max_rows:
			break
		text = read_ok(path, args.max_file_bytes)
		if not text:
			continue
		try:
			rel = str(path.relative_to(repo)).replace("\\", "/")
		except ValueError:
			rel = path.name

		mutators = [
			mutate_jsdoc,
			lambda t: mutate_append_const(t, rng.choice(tokens)),
			mutate_trim_trailing,
			mutate_readonly_iface,
			mutate_todo_comment,
		]
		rng.shuffle(mutators)
		for mut in mutators[: rng.randint(1, 3)]:
			result = mut(text)
			if not result:
				continue
			before, after, req = result
			if before == after:
				continue
			row = modify_row(rel, before, after, req, req, "vscode-mutate")
			h = fp(row)
			if h in seen:
				continue
			seen.add(h)
			rows.append(row)
			if len(rows) >= args.max_rows:
				break

	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as f:
		for r in rows:
			f.write(json.dumps({"messages": r["messages"], "meta": r.get("meta")}, ensure_ascii=False) + "\n")
	print(json.dumps({"rows": len(rows), "elapsed": round(time.time() - t0, 2), "out": str(args.out)}, indent=2))


if __name__ == "__main__":
	main()
