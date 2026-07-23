#!/usr/bin/env python3
"""
Mine professional TypeScript from the vendored VS Code / Frame tree into
Frame-agent training rows (create + modify + comment + export helpers).

This is slow-by-design quality work: parse real files, extract real functions,
synthesize surgical edit instructions with exact before/after full-file contents.
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
When you need workspace info, emit one ```frame-tool fence, then wait.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation. Never invent tool results.
Operation kinds: create {path,content}, modify {path,newContent}, delete {path}, rename {fromPath,toPath}."""

# Export function / method-ish patterns in VS Code TS style
FN_RE = re.compile(
	r"(?m)^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{",
)
CLASS_RE = re.compile(r"(?m)^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)")
CONST_FN_RE = re.compile(
	r"(?m)^export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>",
)


def edit_plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def chat(user: str, assistant: str, source: str) -> dict:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": source},
	}


def rel_path(root: Path, path: Path) -> str:
	try:
		return str(path.relative_to(root)).replace("\\", "/")
	except ValueError:
		return path.name


def read_capped(path: Path, max_bytes: int = 24_000) -> str | None:
	try:
		raw = path.read_bytes()
	except OSError:
		return None
	if len(raw) == 0 or len(raw) > max_bytes:
		return None
	try:
		text = raw.decode("utf-8")
	except UnicodeDecodeError:
		return None
	if "\x00" in text:
		return None
	return text


def find_ts_files(roots: list[Path], limit: int) -> list[Path]:
	out: list[Path] = []
	skip_parts = {
		"node_modules", "out", "dist", ".git", "test", "tests",
		"fixtures", "browser-smoke", "__snapshots__",
	}
	for root in roots:
		if not root.exists():
			continue
		for path in root.rglob("*.ts"):
			if any(p in skip_parts for p in path.parts):
				continue
			if path.name.endswith(".d.ts"):
				continue
			out.append(path)
			if len(out) >= limit:
				return out
	return out


def extract_symbols(text: str) -> list[tuple[str, str]]:
	syms: list[tuple[str, str]] = []
	for m in FN_RE.finditer(text):
		syms.append(("function", m.group(1)))
	for m in CONST_FN_RE.finditer(text):
		syms.append(("const", m.group(1)))
	for m in CLASS_RE.finditer(text):
		syms.append(("class", m.group(1)))
	return syms


def add_file_header_comment(text: str, note: str) -> str:
	if text.startswith("/*---"):
		# VS Code license header — insert after first block comment
		end = text.find("*/")
		if end != -1:
			return text[: end + 2] + f"\n\n// Frame-train note: {note}\n" + text[end + 2 :]
	return f"// Frame-train note: {note}\n" + text


def strip_last_export_function(text: str) -> tuple[str, str] | None:
	"""Remove the last export function body (brace-balanced) for recreate examples."""
	matches = list(FN_RE.finditer(text))
	if not matches:
		return None
	m = matches[-1]
	start = m.start()
	# Find matching closing brace for function
	i = text.find("{", m.end() - 1)
	if i < 0:
		return None
	depth = 0
	j = i
	while j < len(text):
		c = text[j]
		if c == "{":
			depth += 1
		elif c == "}":
			depth -= 1
			if depth == 0:
				j += 1
				break
		j += 1
	else:
		return None
	# Include trailing newline
	while j < len(text) and text[j] in "\r\n":
		j += 1
	removed = text[start:j]
	remaining = text[:start] + text[j:]
	if len(removed) < 40 or len(remaining) < 40:
		return None
	return remaining, removed


def make_create_from_file(rel: str, text: str) -> dict:
	name = Path(rel).name
	user = (
		f"Create `{rel}` with the following professional TypeScript module "
		f"(match structure and style; include exports as given).\n\n"
		f"Target file name: {name}"
	)
	# Don't put full file in the user prompt (teaches copying dump). Put a short brief.
	syms = extract_symbols(text)
	brief = ", ".join(f"{k} {n}" for k, n in syms[:8]) or "module helpers"
	user = (
		f"create {rel} implementing: {brief}. "
		f"Use clean VS Code / TypeScript style with explicit types where natural."
	)
	# For create examples we need the full content in the plan — that's correct.
	asst = (
		f"Creating `{rel}`.\n\n"
		+ edit_plan(
			f"Create {rel}.",
			[{"kind": "create", "path": rel, "content": text, "reason": "Professional module from VS Code tree."}],
		)
	)
	return chat(user, asst, "vscode-create")


def make_comment_edit(rel: str, text: str, note: str) -> dict:
	new_text = add_file_header_comment(text, note)
	user = (
		f"Active file: {rel}\nActive file contents:\n```\n{text}```\n\n"
		f"User request:\nadd a short top-of-file comment: {note}"
	)
	asst = (
		f"Adding a short note comment to `{rel}`.\n\n"
		+ edit_plan(
			f"Add comment to {rel}.",
			[{
				"kind": "modify",
				"path": rel,
				"newContent": new_text,
				"reason": "Comment-only change; preserve all code.",
			}],
		)
	)
	return chat(user, asst, "vscode-comment")


def make_restore_function(rel: str, text: str) -> dict | None:
	stripped = strip_last_export_function(text)
	if not stripped:
		return None
	remaining, removed = stripped
	# Extract function name for instruction
	m = FN_RE.search(removed)
	fname = m.group(1) if m else "helper"
	user = (
		f"Active file: {rel}\nActive file contents:\n```\n{remaining}```\n\n"
		f"User request:\nrestore the missing export function `{fname}` that belongs in this module "
		f"(keep existing code unchanged)."
	)
	asst = (
		f"Restoring `{fname}` in `{rel}`.\n\n"
		+ edit_plan(
			f"Restore {fname} in {rel}.",
			[{
				"kind": "modify",
				"path": rel,
				"newContent": text,
				"reason": "Re-add the removed export; leave the rest intact.",
			}],
		)
	)
	return chat(user, asst, "vscode-restore-fn")


def make_rename_symbol_doc(rel: str, text: str, sym: str) -> dict | None:
	"""Add a one-line doc comment above a symbol without other changes."""
	pattern = re.compile(rf"(?m)^(export\s+(?:async\s+)?function\s+{re.escape(sym)}\b)")
	m = pattern.search(text)
	if not m:
		return None
	insert = f"/** {sym}: keep behavior stable; Frame train sample. */\n"
	if text[m.start() - 20 : m.start()].find("/**") != -1:
		return None
	new_text = text[: m.start()] + insert + text[m.start() :]
	user = (
		f"Active file: {rel}\nActive file contents:\n```\n{text}```\n\n"
		f"User request:\nadd a one-line JSDoc above `{sym}` saying it should keep behavior stable"
	)
	asst = (
		f"Documenting `{sym}`.\n\n"
		+ edit_plan(
			f"Document {sym} in {rel}.",
			[{
				"kind": "modify",
				"path": rel,
				"newContent": new_text,
				"reason": "JSDoc only.",
			}],
		)
	)
	return chat(user, asst, "vscode-jsdoc")


def make_find_symbol_tool(sym: str) -> dict:
	user = random.choice([
		f"find the symbol {sym}",
		f"where is {sym} defined?",
		f"locate {sym} in the workspace",
	])
	asst = (
		f"Looking up `{sym}`.\n\n"
		+ "```frame-tool\n"
		+ json.dumps({"name": "findSymbol", "arguments": {"name": sym, "limit": 20}}, indent=2)
		+ "\n```"
	)
	return chat(user, asst, "vscode-find-symbol")


def make_read_tool(rel: str) -> dict:
	user = random.choice([f"show me {rel}", f"read {rel}", f"open {rel}"])
	asst = (
		f"Reading `{rel}`.\n\n"
		+ "```frame-tool\n"
		+ json.dumps({"name": "readFile", "arguments": {"path": rel, "maxBytes": 20000}}, indent=2)
		+ "\n```"
	)
	return chat(user, asst, "vscode-read")


def fingerprint(row: dict) -> str:
	asst = [m["content"] for m in row["messages"] if m["role"] == "assistant"][-1]
	return hashlib.sha1(asst.encode("utf-8")).hexdigest()


def main() -> None:
	t0 = time.time()
	parser = argparse.ArgumentParser()
	repo = Path(__file__).resolve().parents[3]
	parser.add_argument("--repo", type=Path, default=repo)
	parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw" / "vscode_mined.jsonl")
	parser.add_argument("--file-limit", type=int, default=4000)
	parser.add_argument("--max-rows", type=int, default=8000)
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--max-file-bytes", type=int, default=18_000)
	parser.add_argument("--root", action="append", type=Path, default=None,
		help="Extra/override source roots (repeatable). Relative paths are under --repo.")
	parser.add_argument("--skip-part", action="append", default=None,
		help="Skip path parts (e.g. frameAI). Repeatable.")
	args = parser.parse_args()
	rng = random.Random(args.seed)

	if args.root:
		roots = []
		for r in args.root:
			p = r if r.is_absolute() else args.repo / r
			roots.append(p)
	else:
		roots = [
			args.repo / "vscode" / "src" / "vs" / "base",
			args.repo / "vscode" / "src" / "vs" / "platform",
			args.repo / "vscode" / "src" / "vs" / "editor",
			args.repo / "vscode" / "src" / "vs" / "workbench" / "contrib" / "frameAI",
			args.repo / "vscode" / "src" / "vs" / "workbench" / "services",
		]
	skip_extra = set(args.skip_part or [])

	files = find_ts_files(roots, args.file_limit)
	if skip_extra:
		files = [p for p in files if not any(x in p.parts for x in skip_extra)]
	rng.shuffle(files)
	print(f"candidate files: {len(files)}")

	rows: list[dict] = []
	seen: set[str] = set()
	stats = {"files_used": 0, "skipped_large": 0, "skipped_empty": 0}

	for path in files:
		if len(rows) >= args.max_rows:
			break
		text = read_capped(path, args.max_file_bytes)
		if text is None:
			stats["skipped_large"] += 1
			continue
		if len(text.strip()) < 80:
			stats["skipped_empty"] += 1
			continue
		rel = rel_path(args.repo, path)
		# Prefer workspace-relative under vscode/
		if rel.startswith("vscode/"):
			rel_ws = rel
		else:
			rel_ws = rel

		syms = extract_symbols(text)
		stats["files_used"] += 1

		# Variety of example types per file (not all — keep diversity)
		candidates: list[dict] = []
		if rng.random() < 0.35 and len(text) < 12_000:
			candidates.append(make_create_from_file(rel_ws, text))
		if rng.random() < 0.55:
			note = rng.choice([
				"local helper module",
				"keep public API stable",
				"used by workbench services",
				"prefer explicit types",
			])
			candidates.append(make_comment_edit(rel_ws, text, note))
		restored = make_restore_function(rel_ws, text)
		if restored and rng.random() < 0.45:
			candidates.append(restored)
		if syms and rng.random() < 0.5:
			_kind, sym = rng.choice(syms)
			doc = make_rename_symbol_doc(rel_ws, text, sym)
			if doc:
				candidates.append(doc)
			candidates.append(make_find_symbol_tool(sym))
		if rng.random() < 0.4:
			candidates.append(make_read_tool(rel_ws))

		for row in candidates:
			fp = fingerprint(row)
			if fp in seen:
				continue
			seen.add(fp)
			rows.append(row)
			if len(rows) >= args.max_rows:
				break

	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as f:
		for row in rows:
			f.write(json.dumps({"messages": row["messages"], "meta": row.get("meta")}, ensure_ascii=False) + "\n")

	manifest = {
		"out": str(args.out),
		"rows": len(rows),
		"stats": stats,
		"elapsed_sec": round(time.time() - t0, 2),
		"roots": [str(r) for r in roots],
	}
	args.out.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
	print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
	main()
