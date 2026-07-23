#!/usr/bin/env python3
"""
Dense VS Code miner for Frame LoRA: maximize high-quality rows per eligible file.

Targets workbench/contrib (non-frameAI), workbench/browser, editor/browser, platform,
plus optional extra roots. Emits create / modify / tool / function-extract rows.
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
For top/bottom additions, use append/prepend {path,content}; never repeat the full file.
Never dump unrelated documentation. Never invent tool results.
Operation kinds: create {path,content}, modify {path,newContent}, append {path,content}, prepend {path,content}, delete {path}, rename {fromPath,toPath}."""

FN_RE = re.compile(
	r"(?m)^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{",
)
CLASS_RE = re.compile(r"(?m)^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)")
CONST_FN_RE = re.compile(
	r"(?m)^export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>",
)
IFACE_RE = re.compile(r"(?ms)^export interface ([A-Za-z0-9_]+) \{([^}]*)\}")
FN_LINE_RE = re.compile(r"(?m)^(export\s+(?:async\s+)?function\s+[A-Za-z0-9_]+)")


def plan(summary: str, ops: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": ops}, indent=2) + "\n```"


def tool(name: str, args: dict) -> str:
	return "```frame-tool\n" + json.dumps({"name": name, "arguments": args}, indent=2) + "\n```"


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


def fp(row: dict) -> str:
	asst = [m["content"] for m in row["messages"] if m["role"] == "assistant"][-1]
	return hashlib.sha1(asst.encode("utf-8")).hexdigest()


def read_ok(path: Path, max_bytes: int) -> str | None:
	try:
		b = path.read_bytes()
	except OSError:
		return None
	if not (80 < len(b) <= max_bytes):
		return None
	try:
		t = b.decode("utf-8")
	except UnicodeDecodeError:
		return None
	if "\x00" in t:
		return None
	return t


def extract_fn_bodies(text: str) -> list[tuple[str, str]]:
	out: list[tuple[str, str]] = []
	for m in FN_RE.finditer(text):
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
		if 40 < len(body) < 2800:
			out.append((name, body if body.endswith("\n") else body + "\n"))
	return out


def symbols(text: str) -> list[str]:
	names: list[str] = []
	for rx in (FN_RE, CONST_FN_RE, CLASS_RE):
		names.extend(m.group(1) for m in rx.finditer(text))
	return names


def add_header_note(text: str, note: str) -> str:
	if text.startswith("/*---"):
		end = text.find("*/")
		if end != -1:
			return text[: end + 2] + f"\n\n// Frame-train note: {note}\n" + text[end + 2 :]
	return f"// Frame-train note: {note}\n" + text


def strip_last_export_fn(text: str) -> tuple[str, str, str] | None:
	matches = list(FN_RE.finditer(text))
	if not matches:
		return None
	m = matches[-1]
	name = m.group(1)
	i = text.find("{", m.end() - 1)
	if i < 0:
		return None
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
		return None
	while j < len(text) and text[j] in "\r\n":
		j += 1
	removed = text[m.start() : j]
	remaining = text[: m.start()] + text[j:]
	if len(removed) < 40 or len(remaining) < 40:
		return None
	return remaining, text, name


def mutate_jsdoc(text: str) -> tuple[str, str, str] | None:
	m = FN_LINE_RE.search(text)
	if not m:
		return None
	prefix = text[max(0, m.start() - 80) : m.start()]
	if "/**" in prefix:
		return None
	name_m = re.search(r"function\s+([A-Za-z0-9_]+)", m.group(1))
	name = name_m.group(1) if name_m else "helper"
	insert = f"/** {name} — keep public behavior stable. */\n"
	after = text[: m.start()] + insert + text[m.start() :]
	return text, after, f"add a one-line JSDoc above `{name}` saying to keep public behavior stable"


def mutate_append_const(text: str, token: str) -> tuple[str, str, str] | None:
	key = f"FRAME_TRAIN_{token}"
	if key in text:
		return None
	after = (text if text.endswith("\n") else text + "\n") + f"\nexport const {key} = true;\n"
	return text, after, f"append `export const {key} = true;` at the end of the file"


def mutate_remove_const(text: str, token: str) -> tuple[str, str, str] | None:
	key = f"FRAME_TRAIN_{token}"
	pat = re.compile(rf"\nexport const {re.escape(key)} = true;\n?")
	if not pat.search(text):
		# synthesize before with const, after without — teach removal
		before = (text if text.endswith("\n") else text + "\n") + f"\nexport const {key} = true;\n"
		return before, text if text.endswith("\n") else text + "\n", f"remove the `export const {key}` line"
	after = pat.sub("\n", text, count=1)
	return text, after, f"remove the `export const {key}` line"


def mutate_readonly(text: str) -> tuple[str, str, str] | None:
	m = IFACE_RE.search(text)
	if not m:
		return None
	body = m.group(2)
	fm = re.search(r"(?m)^(\t|  )(?!readonly\b)([A-Za-z0-9_]+)(\??:)", body)
	if not fm:
		return None
	field = fm.group(2)
	new_body = body[: fm.start()] + fm.group(1) + "readonly " + fm.group(2) + fm.group(3) + body[fm.end() :]
	after = text[: m.start(2)] + new_body + text[m.end(2) :]
	return text, after, f"make interface field `{field}` readonly"


def mutate_todo(text: str) -> tuple[str, str, str] | None:
	if "TODO(frame-train)" in text:
		return None
	m = FN_LINE_RE.search(text)
	if not m:
		return None
	brace = text.find("{", m.end() - 1)
	if brace < 0:
		return None
	insert = "\t// TODO(frame-train): consider consolidating helpers\n"
	after = text[: brace + 1] + "\n" + insert + text[brace + 1 :]
	return text, after, "add a TODO comment inside the first exported function about consolidating helpers"


def mutate_export_type_alias(text: str, name: str) -> tuple[str, str, str] | None:
	alias = f"FrameTrain{name[:1].upper()}{name[1:40]}Flag"
	alias = re.sub(r"[^A-Za-z0-9_]", "", alias) or "FrameTrainFlag"
	if alias in text:
		return None
	after = (text if text.endswith("\n") else text + "\n") + f"\nexport type {alias} = boolean;\n"
	return text, after, f"append `export type {alias} = boolean;` at the end"


def find_files(roots: list[Path], skip: set[str], limit: int) -> list[Path]:
	skip_parts = {"node_modules", "out", "dist", ".git", "test", "tests", "fixtures", "__snapshots__", *skip}
	out: list[Path] = []
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


def main() -> None:
	t0 = time.time()
	repo = Path(__file__).resolve().parents[3]
	parser = argparse.ArgumentParser()
	parser.add_argument("--out", type=Path, required=True)
	parser.add_argument("--max-rows", type=int, default=20000)
	parser.add_argument("--file-limit", type=int, default=10000)
	parser.add_argument("--max-file-bytes", type=int, default=16000)
	parser.add_argument("--seed", type=int, default=42)
	parser.add_argument("--root", action="append", type=Path, required=True)
	parser.add_argument("--skip-part", action="append", default=None)
	parser.add_argument("--tag", default="dense-agent")
	args = parser.parse_args()
	rng = random.Random(args.seed)

	roots = [r if r.is_absolute() else repo / r for r in args.root]
	files = find_files(roots, set(args.skip_part or []), args.file_limit)
	rng.shuffle(files)
	print(f"[{args.tag}] files={len(files)} roots={len(roots)}")

	rows: list[dict] = []
	seen: set[str] = set()
	tokens = list("ABCDEFGHJKLMNPQRSTUVWXYZ")

	def push(row: dict) -> bool:
		h = fp(row)
		if h in seen:
			return False
		seen.add(h)
		rows.append(row)
		return len(rows) >= args.max_rows

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

		syms = symbols(text)
		fns = extract_fn_bodies(text)

		# --- create whole module (smaller files only)
		if len(text) < 12_000 and (syms or len(text) > 200):
			brief = ", ".join(syms[:8]) or "module helpers"
			user = rng.choice([
				f"create {rel} implementing: {brief}. Use clean VS Code / TypeScript style.",
				f"write `{rel}` with exports: {brief}",
				f"add professional module {rel} covering {brief}",
			])
			asst = f"Creating `{rel}`.\n\n" + plan(
				f"Create {rel}.",
				[{"kind": "create", "path": rel, "content": text if text.endswith("\n") else text + "\n",
				  "reason": "Professional module from VS Code tree."}],
			)
			if push(chat(user, asst, f"{args.tag}-create")):
				break

		# --- comment edit
		note = rng.choice([
			"local helper module",
			"keep public API stable",
			"used by workbench services",
			"prefer explicit types",
			"browser UI helper",
			"editor contribution helper",
		])
		after = add_header_note(text, note)
		if after != text:
			asst = f"Adding a short note comment to `{rel}`.\n\n" + plan(
				f"Add comment to {rel}.",
				[{"kind": "modify", "path": rel, "newContent": after, "reason": "Comment-only change; preserve all code."}],
			)
			if push(chat(active(rel, text, f"add a short top-of-file comment: {note}"), asst, f"{args.tag}-comment")):
				break

		# --- restore last export function
		stripped = strip_last_export_fn(text)
		if stripped:
			remaining, full, fname = stripped
			asst = f"Restoring `{fname}` in `{rel}`.\n\n" + plan(
				f"Restore {fname} in {rel}.",
				[{"kind": "modify", "path": rel, "newContent": full if full.endswith("\n") else full + "\n",
				  "reason": "Re-add the removed export; leave the rest intact."}],
			)
			req = f"restore the missing export function `{fname}` that belongs in this module (keep existing code unchanged)."
			if push(chat(active(rel, remaining, req), asst, f"{args.tag}-restore")):
				break

		# --- JSDoc on a symbol
		if syms:
			sym = rng.choice([s for s in syms if FN_RE.search(f"export function {s}") or True][:8] or syms)
			pat = re.compile(rf"(?m)^(export\s+(?:async\s+)?function\s+{re.escape(sym)}\b)")
			m = pat.search(text)
			if m and "/**" not in text[max(0, m.start() - 40) : m.start()]:
				insert = f"/** {sym}: keep behavior stable; Frame train sample. */\n"
				new_text = text[: m.start()] + insert + text[m.start() :]
				asst = f"Documenting `{sym}`.\n\n" + plan(
					f"Document {sym} in {rel}.",
					[{"kind": "modify", "path": rel, "newContent": new_text, "reason": "JSDoc only."}],
				)
				if push(chat(active(rel, text, f"add a one-line JSDoc above `{sym}` saying it should keep behavior stable"), asst, f"{args.tag}-jsdoc")):
					break

		# --- mutations (apply several independently from original)
		mutators = [
			mutate_jsdoc,
			lambda t: mutate_append_const(t, rng.choice(tokens)),
			lambda t: mutate_remove_const(t, rng.choice(tokens)),
			mutate_readonly,
			mutate_todo,
			lambda t: mutate_export_type_alias(t, path.stem),
		]
		rng.shuffle(mutators)
		for mut in mutators:
			result = mut(text)
			if not result:
				continue
			before, after_m, req = result
			if before == after_m:
				continue
			asst = f"Updating `{rel}`.\n\n" + plan(
				req,
				[{"kind": "modify", "path": rel,
				  "newContent": after_m if after_m.endswith("\n") else after_m + "\n",
				  "reason": req}],
			)
			if push(chat(active(rel, before, req), asst, f"{args.tag}-mutate")):
				break
		if len(rows) >= args.max_rows:
			break

		# --- tools
		if syms:
			sym = rng.choice(syms)
			asst = f"Looking up `{sym}`.\n\n" + tool("findSymbol", {"name": sym, "limit": 20})
			if push(chat(rng.choice([f"find the symbol {sym}", f"where is {sym} defined?", f"locate {sym}"]), asst, f"{args.tag}-find")):
				break
		asst = f"Reading `{rel}`.\n\n" + tool("readFile", {"path": rel, "maxBytes": 20000})
		if push(chat(rng.choice([f"show me {rel}", f"read {rel}", f"open {rel}"]), asst, f"{args.tag}-read")):
			break
		asst = f"Searching the workspace.\n\n" + tool("grepWorkspace", {"pattern": path.stem, "limit": 40})
		if push(chat(rng.choice([f"grep for {path.stem}", f"search codebase for {path.stem}"]), asst, f"{args.tag}-grep")):
			break

		# --- function extracts as create units
		for name, body in fns[:4]:
			out_rel = f"src/extracted/{name}.ts"
			user = rng.choice([
				f"create {out_rel} with export function {name} matching typical VS Code style",
				f"write a TypeScript helper `{name}` to {out_rel}",
				f"add {out_rel} implementing `{name}`",
			])
			asst = f"Creating `{out_rel}` with `{name}`.\n\n" + plan(
				f"Create {name}",
				[{"kind": "create", "path": out_rel, "content": body,
				  "reason": "Extracted professional function unit from VS Code tree."}],
			)
			if push(chat(user, asst, f"{args.tag}-fn")):
				break
		if len(rows) >= args.max_rows:
			break

	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as f:
		for row in rows:
			f.write(json.dumps({"messages": row["messages"], "meta": row.get("meta")}, ensure_ascii=False) + "\n")

	manifest = {
		"out": str(args.out),
		"rows": len(rows),
		"files": len(files),
		"elapsed_sec": round(time.time() - t0, 2),
		"tag": args.tag,
		"roots": [str(r) for r in roots],
	}
	args.out.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
	print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
	main()
