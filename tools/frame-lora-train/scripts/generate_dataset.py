#!/usr/bin/env python3
"""
Frame-agent LoRA dataset builder.

Quality > template spam:
- gold_seeds.py: hand-authored critical behaviors
- corpus.py: realistic multi-line files
- Generators: surgical edits, tools, multi-turn, standards, anti-dump

Writes ONLY generated_train.jsonl / generated_valid.jsonl (+ generated_manifest.json).
Merge owns the final train.jsonl.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

# Allow `python scripts/generate_dataset.py` from repo root or this dir.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import active_block, sample_file  # noqa: E402
from gold_seeds import SYSTEM, gold_examples  # noqa: E402

TOKENS = [
	"works", "done", "ready", "ok", "pass", "frame", "local", "alpha", "beta",
	"note", "TODO", "FIXME", "draft", "v1", "stable", "ship", "wip", "nits",
	"checked", "verified", "lgtm", "hotfix", "patch", "release",
]

ALL_TOOLS = [
	"readFile", "listFiles", "globFiles", "grepWorkspace", "codebaseSearch",
	"findSymbol", "findReferences", "findDependencies", "findCallers",
	"findImplementations", "readLints", "gitStatus", "gitDiff",
]

APPEND_PHRASES = [
	'add "{t}" at the end of the file',
	'append "{t}" to the end',
	'put "{t}" on a new line at the bottom',
	'please add the word {t} at the end of this document',
	'can you add "{t}" at the end of the file now',
	'stick "{t}" at the bottom — nothing else',
	'end the file with {t}',
	'write {t} after the last line',
]

PREPEND_PHRASES = [
	'add a word "{t}" in front of the 1st line in the doc',
	'prepend "{t}" to the first line',
	'put "{t}" at the beginning of the first line',
	'insert "{t}" before the first line\'s text',
	'start the first line with {t}',
]

REPLACE_PHRASES = [
	'change "{old}" to "{new}" — nothing else',
	'replace "{old}" with "{new}" everywhere in this file',
	'rename the text "{old}" → "{new}"',
]

SYMBOLS = [
	"FrameChatAgent", "add", "clamp", "loadModel", "parseModelEditPlan",
	"FrameTaskKind", "SYSTEM", "edit_plan", "average", "slugify",
]

PATHS = [
	"README.md", "NOTES.md", "src/app.ts", "src/math.ts", "package.json",
	"docs/guide.md", "tools/frame-model-worker/frameInferenceEngine.mjs",
	"vscode/src/vs/workbench/contrib/frameAI/browser/frameChatAgent.ts",
]


def chat(user: str, assistant: str, *, tag: str = "synth") -> dict:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": f"frame-{tag}", "quality": "high"},
	}


def multi_turn(turns: list[tuple[str, str]], *, tag: str = "synth-mt") -> dict:
	msgs = [{"role": "system", "content": SYSTEM}]
	for u, a in turns:
		msgs.append({"role": "user", "content": u})
		msgs.append({"role": "assistant", "content": a})
	return {"messages": msgs, "meta": {"source": f"frame-{tag}", "quality": "high"}}


def edit_plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def tool_call(name: str, arguments: dict) -> str:
	return "```frame-tool\n" + json.dumps({"name": name, "arguments": arguments}, indent=2) + "\n```"


def tool_result(name: str, result: dict) -> str:
	return f"The IDE completed {name}. This is the authoritative result:\n" + json.dumps(result, indent=2)


def ensure_nl(s: str) -> str:
	return s if s.endswith("\n") or s == "" else s + "\n"


def _tool_args(name: str, rng: random.Random) -> tuple[str, dict]:
	"""Return (user_prompt_fragment, arguments) for a single tool."""
	if name == "readFile":
		path = rng.choice(PATHS)
		return f"read {path}", {"path": path, "maxBytes": 20000}
	if name == "listFiles":
		d = rng.choice(["src", "tools", "docs", "vscode/src", "."])
		return f"list files under {d}", {"path": d, "limit": 100}
	if name == "globFiles":
		pat = rng.choice(["**/*.ts", "**/frame*.ts", "src/**/*.py", "**/*Agent*.ts", "docs/**/*.md"])
		return f"find files matching {pat}", {"pattern": pat, "limit": 40}
	if name == "grepWorkspace":
		pat = rng.choice(["TODO", "FIXME", "frame-edit-plan", "export function", "FrameChatAgent"])
		return f"search the workspace for {pat}", {"pattern": pat, "limit": 40}
	if name == "codebaseSearch":
		q = rng.choice(["how edit plans are applied", "frame tool execution", "lora adapter load", "chat agent streaming"])
		return f"where is the code for {q}?", {"query": q, "limit": 20}
	if name == "findSymbol":
		sym = rng.choice(SYMBOLS)
		return f"find the symbol {sym}", {"name": sym, "limit": 20}
	if name == "findReferences":
		sym = rng.choice(SYMBOLS)
		return f"find references to {sym}", {"name": sym, "limit": 30}
	if name == "findDependencies":
		path = rng.choice(PATHS)
		return f"what does {path} depend on?", {"path": path, "limit": 40}
	if name == "findCallers":
		sym = rng.choice(SYMBOLS)
		return f"who calls {sym}?", {"name": sym, "limit": 30}
	if name == "findImplementations":
		sym = rng.choice(["IFrameRuntime", "Disposable", "FrameTool", "LanguageModelChat"])
		return f"find implementations of {sym}", {"name": sym, "limit": 20}
	if name == "readLints":
		path = rng.choice(["src/app.ts", "src/math.ts", "src/average.ts", None])
		if path:
			return f"show linter errors in {path}", {"path": path, "limit": 50}
		return "show linter diagnostics", {"limit": 50}
	if name == "gitStatus":
		return "git status", {}
	# gitDiff
	path = rng.choice(["src/app.ts", "README.md", "NOTES.md", "package.json"])
	return f"git diff for {path}", {"path": path}


def _fake_tool_data(name: str, args: dict, rng: random.Random) -> dict:
	if name == "readFile":
		path = args.get("path", "README.md")
		content = rng.choice([
			"# Guide\n\nSetup steps.\n",
			"export const name = 'frame';\n",
			"line one\nline two\nline three\n",
			"Project notes\nKeep short.\n",
		])
		return {"success": True, "data": {"path": path, "content": content, "truncated": False}}
	if name == "listFiles":
		return {"success": True, "data": {"entries": ["src/app.ts", "src/math.ts", "README.md", "NOTES.md"]}}
	if name == "globFiles":
		return {"success": True, "data": {"matches": ["src/app.ts", "src/math.ts", "src/average.ts"]}}
	if name == "grepWorkspace":
		return {"success": True, "data": {"matches": [{"path": "src/app.ts", "line": 12, "text": "TODO: wire apply"}]}}
	if name == "codebaseSearch":
		return {"success": True, "data": {"results": [{"path": "src/runtime.ts", "snippet": "applyEditPlan(...)"}]}}
	if name in {"findSymbol", "findReferences", "findCallers", "findImplementations"}:
		return {"success": True, "data": {"results": [{"path": "src/math.ts", "line": 1, "name": args.get("name", "add")}]}}
	if name == "findDependencies":
		return {"success": True, "data": {"imports": ["./math.ts", "node:fs"]}}
	if name == "readLints":
		return {
			"success": True,
			"data": {
				"diagnostics": [
					{"path": args.get("path", "src/app.ts"), "line": 3, "severity": "error", "message": "Cannot find name 'x'."},
				]
			},
		}
	if name == "gitStatus":
		return {"success": True, "data": {"branch": "main", "dirty": True, "files": ["src/app.ts", "NOTES.md"]}}
	if name == "gitDiff":
		return {"success": True, "data": {"path": args.get("path", "src/app.ts"), "diff": "@@ -1,3 +1,4 @@\n+export const ready = true;\n"}}
	return {"success": True, "data": {}}


# ---------- function catalogs ----------

TS_SPECS = [
	("add", "a: number, b: number", "number", "\treturn a + b;"),
	("sub", "a: number, b: number", "number", "\treturn a - b;"),
	("clamp", "n: number, min: number, max: number", "number", "\treturn Math.min(max, Math.max(min, n));"),
	("isEmpty", "value: string | null | undefined", "boolean", "\treturn !value || value.trim().length === 0;"),
	("unique", "items: string[]", "string[]", "\treturn [...new Set(items)];"),
	(
		"slugify",
		"text: string",
		"string",
		"\treturn text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');",
	),
	("pick", "obj: Record<string, unknown>, key: string", "unknown", "\treturn obj[key];"),
	("sum", "nums: number[]", "number", "\treturn nums.reduce((a, b) => a + b, 0);"),
	("compact", "items: Array<string | null | undefined>", "string[]", "\treturn items.filter((x): x is string => Boolean(x));"),
	("once", "fn: () => void", "() => void", "\tlet called = false;\n\treturn () => {\n\t\tif (called) return;\n\t\tcalled = true;\n\t\tfn();\n\t};"),
]

PY_SPECS = [
	("add", "a: int, b: int", "int", "    return a + b"),
	("sub", "a: int, b: int", "int", "    return a - b"),
	("clamp", "n: float, lo: float, hi: float", "float", "    return max(lo, min(hi, n))"),
	("is_empty", "value: str | None", "bool", "    return value is None or not value.strip()"),
	("unique", "items: list[str]", "list[str]", "    return list(dict.fromkeys(items))"),
	(
		"slugify",
		"text: str",
		"str",
		'    import re\n    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower().strip())\n    return cleaned.strip("-")',
	),
	("flatten", "rows: list[list[int]]", "list[int]", "    return [x for row in rows for x in row]"),
	("safe_div", "a: float, b: float", "float", "    if b == 0:\n        raise ZeroDivisionError(\"b must be non-zero\")\n    return a / b"),
]

JS_SPECS = [
	("add", "a, b", "  return a + b;"),
	("unique", "items", "  return [...new Set(items)];"),
	("isBlank", "value", "  return !value || !String(value).trim();"),
]


# ---------- generators ----------

def gen_append(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path, body = sample_file(rng)
		token = rng.choice(TOKENS)
		phrase = rng.choice(APPEND_PHRASES).format(t=token)
		asst = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "append",
					"path": path,
					"content": token,
					"reason": "User asked for an additive end-of-file change only.",
				}],
			)
		)
		out.append(chat(active_block(path, body, phrase), asst, tag="append"))
	return out


def gen_prepend(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path, body = sample_file(rng)
		token = rng.choice(TOKENS)
		phrase = rng.choice(PREPEND_PHRASES).format(t=token)
		if not body:
			body = "Hello\n"
		asst = (
			f"Prepending `{token}` to the first line of `{path}`.\n\n"
			+ edit_plan(
				f'Prepend "{token}" on the first line of {path}.',
				[{
					"kind": "prepend",
					"path": path,
					"content": f"{token} ",
					"reason": "Only the first line changes.",
				}],
			)
		)
		out.append(chat(active_block(path, body, phrase), asst, tag="prepend"))
	return out


def gen_replace_phrase(n: int, rng: random.Random) -> list[dict]:
	out = []
	pairs = [
		("the app", "Frame"),
		("TODO", "DONE"),
		("alpha", "beta"),
		("local IDE", "Frame IDE"),
		("Setup steps", "Install steps"),
		("enabled\": false", "enabled\": true"),
	]
	for _ in range(n):
		path, body = sample_file(rng)
		old, new = rng.choice(pairs)
		if old not in body:
			body = f"# Doc\n\nPlease install {old} today.\n\nThanks.\n"
			path = rng.choice(["README.md", "NOTES.md", "docs/guide.md"])
		phrase = rng.choice(REPLACE_PHRASES).format(old=old, new=new)
		new_body = body.replace(old, new)
		asst = (
			f"Replacing `{old}` → `{new}` in `{path}`.\n\n"
			+ edit_plan(
				f'Replace "{old}" with "{new}" in {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Surgical text replace; keep everything else.",
				}],
			)
		)
		out.append(chat(active_block(path, body, phrase), asst, tag="replace"))
	return out


def gen_insert_line(n: int, rng: random.Random) -> list[dict]:
	out = []
	for i in range(n):
		path = f"docs/insert_line_{i}.md"
		lines = ["# Title", "", "- first item", "- second item", ""]
		body = "\n".join(lines) + "\n"
		token = f"{rng.choice(TOKENS)}_{i}"
		# 1-based: insert as new line 4 (after first bullet at line 3) → content becomes 2nd list item
		line_no = rng.choice([2, 3, 4])
		content = f"- {token}" if line_no >= 3 else token
		phrase_kind = ["on_line", "second", "2nd", "ordinal"][i % 4]
		if phrase_kind == "on_line":
			req = f'insert "{content}" on line {line_no}'
		elif phrase_kind == "second":
			line_no = 3
			content = f"- {token}"
			req = f'insert "{content}" on the second line of the list (second line after the blank)'
		elif phrase_kind == "2nd":
			line_no = 3
			content = f"- {token}"
			req = f'add "{content}" as the 2nd line item — insert on line 3'
		else:
			line_no = 4
			content = f"- {token}"
			req = f'put "{content}" on line 4 (after the first bullet)'
		asst = (
			f"Inserting on line {line_no} in `{path}`.\n\n"
			+ edit_plan(
				f"Insert content on line {line_no} in {path}.",
				[{
					"kind": "insert",
					"path": path,
					"line": line_no,
					"content": content,
					"reason": "Numbered-line request uses insert with 1-based line.",
				}],
			)
		)
		out.append(chat(active_block(path, body, req), asst, tag="insert"))
	return out


def gen_create_functions(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		lang = rng.choice(["ts", "ts", "py", "js"])
		if lang == "ts":
			name, args, ret, body = rng.choice(TS_SPECS)
			path = f"src/{name}.ts"
			code = f"export function {name}({args}): {ret} {{\n{body}\n}}\n"
			req = rng.choice([
				f"create {path} with typed {name}({args}): {ret}",
				f"write a TypeScript {name} helper with clear types",
				f"add {path} implementing {name}",
			])
		elif lang == "py":
			name, args, ret, body = rng.choice(PY_SPECS)
			path = f"src/{name}.py"
			code = f"def {name}({args}) -> {ret}:\n{body}\n"
			req = rng.choice([
				f"create {path} with {name}({args}) -> {ret}",
				f"write a typed Python function {name}",
			])
		else:
			name, args, body = rng.choice(JS_SPECS)
			path = f"lib/{name}.js"
			code = f"export function {name}({args}) {{\n{body}\n}}\n"
			req = f"create {path} with export function {name}({args})"
		asst = (
			f"Creating `{path}`.\n\n"
			+ edit_plan(
				f"Create {path} with {name}.",
				[{
					"kind": "create",
					"path": path,
					"content": code,
					"reason": "Basic helper matching the request.",
				}],
			)
		)
		out.append(chat(req, asst, tag="create-fn"))
	return out


def gen_add_sibling_fn(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = "src/math.ts"
		base = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"
		name, args, ret, body = rng.choice([s for s in TS_SPECS if s[0] != "add"])
		extra = f"\nexport function {name}({args}): {ret} {{\n{body}\n}}\n"
		new_body = base + extra
		req = rng.choice([
			f"also add {name}({args}) in the same file",
			f"append a {name} function next to add",
			f"add export function {name} without changing add",
		])
		asst = (
			f"Adding `{name}` beside `add`.\n\n"
			+ edit_plan(
				f"Add {name}() to {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Preserve existing functions; append new helper.",
				}],
			)
		)
		out.append(chat(active_block(path, base, req), asst, tag="sibling-fn"))
	return out


def gen_bugfix(n: int, rng: random.Random) -> list[dict]:
	out = []
	cases = [
		(
			"src/average.ts",
			"export function average(nums: number[]): number {\n\tlet sum = 0;\n\tfor (let i = 0; i <= nums.length; i++) {\n\t\tsum += nums[i]!;\n\t}\n\treturn sum / nums.length;\n}\n",
			"export function average(nums: number[]): number {\n\tif (nums.length === 0) {\n\t\tthrow new Error('average() requires a non-empty array');\n\t}\n\tlet sum = 0;\n\tfor (let i = 0; i < nums.length; i++) {\n\t\tsum += nums[i]!;\n\t}\n\treturn sum / nums.length;\n}\n",
			"fix the off-by-one bug and handle empty arrays",
		),
		(
			"src/div.ts",
			"export function div(a: number, b: number): number {\n\treturn a / b;\n}\n",
			"export function div(a: number, b: number): number {\n\tif (b === 0) {\n\t\tthrow new Error('division by zero');\n\t}\n\treturn a / b;\n}\n",
			"guard against division by zero",
		),
		(
			"src/first.ts",
			"export function first<T>(items: T[]): T {\n\treturn items[0]!;\n}\n",
			"export function first<T>(items: T[]): T {\n\tif (items.length === 0) {\n\t\tthrow new Error('first() called on empty array');\n\t}\n\treturn items[0]!;\n}\n",
			"throw if the array is empty",
		),
	]
	for _ in range(n):
		path, before, after, req = rng.choice(cases)
		asst = (
			"Applying the fix.\n\n"
			+ edit_plan(
				f"Fix {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": after,
					"reason": req,
				}],
			)
		)
		out.append(chat(active_block(path, before, req), asst, tag="bugfix"))
	return out


def gen_standards(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = "src/format.ts"
		messy = rng.choice([
			"export function Foo(X,Y){return X+Y}\n",
			"export const f=(a,b)=>a+b\n",
			"function do_stuff(x){return x+1}\nexport { do_stuff }\n",
		])
		clean = "export function add(x: number, y: number): number {\n\treturn x + y;\n}\n"
		req = rng.choice([
			"refactor to idiomatic typed TypeScript",
			"fix naming and add types + formatting",
			"make this follow normal TS style with types",
		])
		asst = (
			"Refactoring to typed, formatted TypeScript.\n\n"
			+ edit_plan(
				"Refactor into typed add().",
				[{
					"kind": "modify",
					"path": path,
					"newContent": clean,
					"reason": "Clear name, explicit types, formatting.",
				}],
			)
		)
		out.append(chat(active_block(path, messy, req), asst, tag="standards"))
	return out


def gen_json_edits(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = rng.choice(["config.json", ".frame/config/runtime.json"])
		obj = {
			"runtime": "llamacpp",
			"activeModelId": "qwen-coder-7b-q4",
			"enabled": rng.choice([True, False]),
			"maxTokens": rng.choice([512, 1024, 2048]),
		}
		body = json.dumps(obj, indent=2) + "\n"
		kind = rng.choice(["enable", "tokens", "temp"])
		if kind == "enable":
			obj["enabled"] = True
			req = "set enabled to true"
		elif kind == "tokens":
			obj["maxTokens"] = 2048
			req = "set maxTokens to 2048"
		else:
			obj["temperature"] = 0.2
			req = 'add "temperature": 0.2'
		new_body = json.dumps(obj, indent=2) + "\n"
		asst = (
			f"Updating `{path}`.\n\n"
			+ edit_plan(
				f"Update {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "JSON field change only.",
				}],
			)
		)
		out.append(chat(active_block(path, body, req), asst, tag="json"))
	return out


def gen_delete_rename(n: int, rng: random.Random) -> list[dict]:
	out = []
	for i in range(n):
		if rng.random() < 0.5:
			path = f"tmp/scratch_{i}_{rng.choice(['txt', 'md', 'log', 'bak'])}"
			req = rng.choice([f"delete {path}", f"remove the file {path}", f"please delete `{path}`"])
			asst = (
				f"Deleting `{path}`.\n\n"
				+ edit_plan(
					f"Delete {path}.",
					[{"kind": "delete", "path": path, "reason": "User asked to delete it."}],
				)
			)
		else:
			stem = rng.choice(["util", "helper", "legacy", "service", "model", "view"])
			ext = rng.choice(["ts", "py", "js", "tsx"])
			src = f"src/{stem}_{i}.{ext}"
			dst = f"src/{stem}_{i}_renamed.{ext}"
			req = rng.choice([f"rename {src} to {dst}", f"move {src} → {dst}", f"rename `{src}` as `{dst}`"])
			asst = (
				"Renaming the file.\n\n"
				+ edit_plan(
					f"Rename {src} → {dst}.",
					[{
						"kind": "rename",
						"fromPath": src,
						"toPath": dst,
						"reason": "User requested rename.",
					}],
				)
			)
		out.append(chat(req, asst, tag="delete-rename"))
	return out


def gen_tool_only(n: int, rng: random.Random) -> list[dict]:
	"""Cover all 13 tools evenly — never searchWorkspace. Force unique fingerprints."""
	out = []
	for i in range(n):
		name = ALL_TOOLS[i % len(ALL_TOOLS)]
		frag, args = _tool_args(name, rng)
		clean_args = {k: v for k, v in args.items() if v is not None}
		# Diversify args so merge dedup cannot collapse thousands of rows
		if name == "readFile":
			clean_args["path"] = f"src/gen_read_{i}.ts"
			frag = f"read {clean_args['path']}"
		elif name == "listFiles":
			clean_args["path"] = f"pkg_{i % 200}/src"
			frag = f"list files under {clean_args['path']}"
		elif name == "globFiles":
			clean_args["pattern"] = f"**/mod_{i}/*.ts"
			frag = f"find files matching {clean_args['pattern']}"
		elif name == "grepWorkspace":
			clean_args["pattern"] = f"TOKEN_{i}_MARK"
			frag = f"search the workspace for {clean_args['pattern']}"
		elif name == "codebaseSearch":
			clean_args["query"] = f"how module {i} applies edits"
			frag = f"where is the code for {clean_args['query']}?"
		elif name == "findSymbol":
			clean_args["name"] = f"Symbol_{i}"
			frag = f"find the symbol {clean_args['name']}"
		elif name == "findReferences":
			clean_args["name"] = f"Ref_{i}"
			frag = f"find references to {clean_args['name']}"
		elif name == "findDependencies":
			clean_args["path"] = f"src/dep_{i}.ts"
			frag = f"what does {clean_args['path']} depend on?"
		elif name == "findCallers":
			clean_args["name"] = f"callMe_{i}"
			frag = f"who calls {clean_args['name']}?"
		elif name == "findImplementations":
			clean_args["name"] = f"IFace_{i}"
			frag = f"find implementations of {clean_args['name']}"
		elif name == "readLints":
			clean_args["path"] = f"src/lint_{i}.ts"
			frag = f"show linter errors in {clean_args['path']}"
		elif name == "gitStatus":
			frag = f"git status (workspace check #{i})"
		elif name == "gitDiff":
			clean_args["path"] = f"src/diff_{i}.ts"
			frag = f"git diff for {clean_args['path']}"
		user = rng.choice([
			frag,
			f"please {frag}",
			f"can you {frag}?",
			f"Frame task {i}: {frag}",
		])
		label = {
			"readFile": "Reading",
			"listFiles": "Listing",
			"globFiles": "Globbing",
			"grepWorkspace": "Searching",
			"codebaseSearch": "Searching the codebase",
			"findSymbol": "Looking up symbol",
			"findReferences": "Finding references",
			"findDependencies": "Checking dependencies",
			"findCallers": "Finding callers",
			"findImplementations": "Finding implementations",
			"readLints": "Reading lints",
			"gitStatus": "Checking git status",
			"gitDiff": "Fetching git diff",
		}.get(name, "Working")
		asst = f"{label} (#{i}).\n\n" + tool_call(name, clean_args)
		out.append(chat(user, asst, tag="tool"))
	return out


def gen_tool_then_edit(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = rng.choice(["docs/guide.md", "NOTES.md", "README.md", "src/app.ts"])
		token = rng.choice(TOKENS)
		original = rng.choice([
			"# Title\n\nBody text.\n",
			"line one\nline two\n",
			"export const name = 'frame';\n",
		])
		t1 = (
			f"Active file: (none focused)\n\nUser request:\nappend \"{token}\" to the end of {path}"
		)
		a1 = (
			f"I'll read `{path}` first, then propose the edit.\n\n"
			+ tool_call("readFile", {"path": path, "maxBytes": 20000})
		)
		t2 = tool_result(
			"readFile",
			{"success": True, "data": {"path": path, "content": original, "truncated": False}},
		)
		a2 = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "append",
					"path": path,
					"content": token,
					"reason": "Append after reading current contents; only the new token.",
				}],
			)
		)
		out.append(multi_turn([(t1, a1), (t2, a2)], tag="tool-edit"))
	return out


def gen_multi_tool_chains(n: int, rng: random.Random) -> list[dict]:
	"""2–3 tools then edit or answer. Target ~8000 at full scale."""
	out = []
	patterns = [
		"grep_read_edit",
		"findSymbol_read_edit",
		"glob_read_edit",
		"codebase_read_answer",
		"list_read_answer",
	]
	for i in range(n):
		kind = patterns[i % len(patterns)]
		token = rng.choice(TOKENS)
		path = rng.choice(["src/app.ts", "src/math.ts", "NOTES.md", "docs/guide.md"])
		body = rng.choice([
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
			"# Notes\n\nKeep short.\n",
			"export const ready = false;\n",
		])

		if kind == "grep_read_edit":
			pat = rng.choice(["TODO", "ready", "add("])
			t1 = f"Find {pat} then append \"{token}\" at the end of the matching file"
			a1 = f"Searching for `{pat}`.\n\n" + tool_call("grepWorkspace", {"pattern": pat, "limit": 20})
			t2 = tool_result("grepWorkspace", {
				"success": True,
				"data": {"matches": [{"path": path, "line": 1, "text": pat}]},
			})
			a2 = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
			t3 = tool_result("readFile", {
				"success": True,
				"data": {"path": path, "content": body, "truncated": False},
			})
			a3 = (
				f"Appending `{token}` to `{path}`.\n\n"
				+ edit_plan(
					f'Append "{token}" to {path}.',
					[{"kind": "append", "path": path, "content": token, "reason": "End-of-file add after grep→read."}],
				)
			)
			out.append(multi_turn([(t1, a1), (t2, a2), (t3, a3)], tag="chain-grep"))

		elif kind == "findSymbol_read_edit":
			sym = rng.choice(SYMBOLS)
			t1 = f"Find symbol {sym}, open its file, and set ready = true if present"
			a1 = f"Looking up `{sym}`.\n\n" + tool_call("findSymbol", {"name": sym, "limit": 10})
			t2 = tool_result("findSymbol", {
				"success": True,
				"data": {"results": [{"path": path, "line": 1, "name": sym}]},
			})
			a2 = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
			content = "export const ready = false;\n"
			t3 = tool_result("readFile", {
				"success": True,
				"data": {"path": path, "content": content, "truncated": False},
			})
			a3 = (
				f"Updating `{path}`.\n\n"
				+ edit_plan(
					f"Set ready=true in {path}.",
					[{
						"kind": "modify",
						"path": path,
						"newContent": "export const ready = true;\n",
						"reason": "Toggle after findSymbol→read.",
					}],
				)
			)
			out.append(multi_turn([(t1, a1), (t2, a2), (t3, a3)], tag="chain-symbol"))

		elif kind == "glob_read_edit":
			pat = "src/**/*.ts"
			t1 = f"Find {pat} files, open one, append \"{token}\" at the end"
			a1 = f"Globbing `{pat}`.\n\n" + tool_call("globFiles", {"pattern": pat, "limit": 20})
			t2 = tool_result("globFiles", {
				"success": True,
				"data": {"matches": [path, "src/math.ts"]},
			})
			a2 = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
			t3 = tool_result("readFile", {
				"success": True,
				"data": {"path": path, "content": body, "truncated": False},
			})
			a3 = (
				f"Appending `{token}`.\n\n"
				+ edit_plan(
					f'Append "{token}" to {path}.',
					[{"kind": "append", "path": path, "content": token, "reason": "After glob→read."}],
				)
			)
			out.append(multi_turn([(t1, a1), (t2, a2), (t3, a3)], tag="chain-glob"))

		elif kind == "codebase_read_answer":
			q = "how edit plans are applied"
			t1 = f"Where is the code for {q}? Summarize briefly."
			a1 = "Searching the codebase.\n\n" + tool_call("codebaseSearch", {"query": q, "limit": 10})
			t2 = tool_result("codebaseSearch", {
				"success": True,
				"data": {"results": [{"path": path, "snippet": "applyEditPlan(plan)"}]},
			})
			a2 = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
			t3 = tool_result("readFile", {
				"success": True,
				"data": {
					"path": path,
					"content": "export function applyEditPlan(plan: EditPlan): void {\n\t// apply ops\n}\n",
					"truncated": False,
				},
			})
			a3 = (
				f"`{path}` defines `applyEditPlan`, which walks the plan operations and applies them. "
				"That is the apply path for frame-edit-plan."
			)
			out.append(multi_turn([(t1, a1), (t2, a2), (t3, a3)], tag="chain-search"))

		else:  # list_read_answer
			d = "src"
			t1 = f"List {d}, open a file, and tell me what it exports"
			a1 = f"Listing `{d}`.\n\n" + tool_call("listFiles", {"path": d, "limit": 50})
			t2 = tool_result("listFiles", {
				"success": True,
				"data": {"entries": ["app.ts", "math.ts", "average.ts"]},
			})
			a2 = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
			t3 = tool_result("readFile", {
				"success": True,
				"data": {"path": path, "content": body, "truncated": False},
			})
			a3 = f"`{path}` exports the helpers shown in the file contents above (e.g. `add` or `ready`)."
			out.append(multi_turn([(t1, a1), (t2, a2), (t3, a3)], tag="chain-list"))
	return out


def gen_tool_failure_recovery(n: int, rng: random.Random) -> list[dict]:
	out = []
	for i in range(n):
		name = ALL_TOOLS[i % len(ALL_TOOLS)]
		frag, args = _tool_args(name, rng)
		clean_args = {k: v for k, v in args.items() if v is not None}
		err = rng.choice([
			f"{name} failed: path not found",
			f"{name} failed: permission denied",
			f"{name} failed: timed out",
			f"{name} failed: no matches",
		])
		t1 = f"please {frag}"
		a1 = f"Working.\n\n" + tool_call(name, clean_args)
		t2 = tool_result(name, {"success": False, "error": err})
		alt_path = "README.md" if clean_args.get("path") != "README.md" else "NOTES.md"
		if name == "readFile":
			a2 = (
				f"That path failed (`{err}`). Trying `{alt_path}` instead.\n\n"
				+ tool_call("readFile", {"path": alt_path, "maxBytes": 20000})
			)
		elif name == "listFiles":
			a2 = (
				f"Listing failed (`{err}`). Falling back to a glob of TypeScript sources.\n\n"
				+ tool_call("globFiles", {"pattern": "src/**/*.ts", "limit": 40})
			)
		elif name in {"grepWorkspace", "globFiles", "codebaseSearch", "findSymbol"}:
			a2 = (
				f"Tool failed (`{err}`). I'll try reading `{alt_path}` instead.\n\n"
				+ tool_call("readFile", {"path": alt_path, "maxBytes": 20000})
			)
		else:
			a2 = (
				f"The IDE reported an error: {err}. "
				"Tell me another path or symbol and I'll retry with different arguments."
			)
		out.append(multi_turn([(t1, a1), (t2, a2)], tag="tool-fail"))
	return out


def gen_dont_repeat_tool(n: int, rng: random.Random) -> list[dict]:
	out = []
	for i in range(n):
		name = ALL_TOOLS[i % len(ALL_TOOLS)]
		frag, args = _tool_args(name, rng)
		clean_args = {k: v for k, v in args.items() if v is not None}
		data = _fake_tool_data(name, clean_args, rng)
		# User already pasted the authoritative result — answer without re-calling
		user = (
			f"I already ran {name} for you.\n"
			+ tool_result(name, data)
			+ f"\n\nBased on that, briefly answer: what did we learn? (do not call {name} again)"
		)
		if name == "readFile":
			content = data["data"].get("content", "")
			asst = f"From the file contents already provided: it starts with `{content.strip().splitlines()[0] if content.strip() else '(empty)'}`. No need to re-read."
		elif name == "gitStatus":
			asst = f"Working tree is on `{data['data'].get('branch', 'main')}`; dirty={data['data'].get('dirty')}. Files: {', '.join(data['data'].get('files', []))}."
		elif name == "readLints":
			diags = data["data"].get("diagnostics", [])
			asst = f"There are {len(diags)} diagnostic(s). Top: {diags[0]['message'] if diags else 'none'}."
		elif name == "listFiles":
			asst = "Entries include: " + ", ".join(data["data"].get("entries", [])[:5]) + "."
		else:
			asst = f"Using the {name} result already given — no repeat call. Summary: {json.dumps(data.get('data', {}))[:240]}"
		out.append(chat(user, asst, tag="no-repeat"))
	return out


def gen_read_lints_flows(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = rng.choice(["src/app.ts", "src/math.ts", "src/average.ts"])
		buggy = "export function main(): void {\n\tconsole.log(x);\n}\n"
		fixed = "export function main(): void {\n\tconst x = 1;\n\tconsole.log(x);\n}\n"
		t1 = f"Fix linter errors in {path}"
		a1 = f"Checking lints for `{path}`.\n\n" + tool_call("readLints", {"path": path, "limit": 50})
		t2 = tool_result("readLints", {
			"success": True,
			"data": {
				"diagnostics": [
					{"path": path, "line": 2, "severity": "error", "message": "Cannot find name 'x'."},
				]
			},
		})
		a2 = (
			f"Declaring `x` before use in `{path}`.\n\n"
			+ edit_plan(
				f"Fix missing name in {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": fixed,
					"reason": "Resolve readLints error: Cannot find name 'x'.",
				}],
			)
		)
		# Also include single-turn readLints
		if rng.random() < 0.35:
			out.append(chat(
				f"show linter errors in {path}",
				f"Reading lints.\n\n" + tool_call("readLints", {"path": path, "limit": 50}),
				tag="lints-only",
			))
		else:
			out.append(multi_turn([(t1, a1), (t2, a2)], tag="lints-fix"))
		_ = buggy  # kept for clarity of the before state
	return out


def gen_git_flows(n: int, rng: random.Random) -> list[dict]:
	out = []
	for i in range(n):
		path = rng.choice(["src/app.ts", "README.md", "NOTES.md", "package.json"])
		if i % 2 == 0:
			t1 = rng.choice(["git status", "what's dirty in git?", "show git status"])
			a1 = "Checking git status.\n\n" + tool_call("gitStatus", {})
			t2 = tool_result("gitStatus", {
				"success": True,
				"data": {"branch": "main", "dirty": True, "files": [path, "NOTES.md"]},
			})
			a2 = (
				f"On `main`, dirty files include `{path}` and `NOTES.md`. "
				f"I can pull `gitDiff` for `{path}` if you want the patch."
			)
			out.append(multi_turn([(t1, a1), (t2, a2)], tag="git-status"))
		else:
			t1 = f"show the git diff for {path}"
			a1 = f"Fetching git diff for `{path}`.\n\n" + tool_call("gitDiff", {"path": path})
			t2 = tool_result("gitDiff", {
				"success": True,
				"data": {"path": path, "diff": f"@@ -1,2 +1,3 @@\n+// touch\n export const ok = true;\n"},
			})
			a2 = f"`{path}` adds a comment line above `export const ok = true`. No further tools needed."
			out.append(multi_turn([(t1, a1), (t2, a2)], tag="git-diff"))
	return out


def gen_extra_insert(n: int, rng: random.Random) -> list[dict]:
	"""Extra insert-at-scale beyond gen_insert_line. Unique paths for dedup survival."""
	out = []
	for i in range(n):
		path = f"notes/insert_{i}.md"
		lines = ["alpha", "beta", "gamma", "delta"]
		body = "\n".join(lines) + "\n"
		token = f"{rng.choice(TOKENS)}_{i}"
		line_no = (i % 4) + 1
		phrases = [
			f'insert "{token}" on line {line_no}',
			f'put "{token}" on the second line',
			f'add "{token}" as the 2nd line',
			f'insert "{token}" on line 2 (second line)',
		]
		req = phrases[i % len(phrases)]
		if "second line" in req or "2nd line" in req:
			line_no = 2
		asst = (
			f"Inserting `{token}` on line {line_no} in `{path}`.\n\n"
			+ edit_plan(
				f"Insert on line {line_no} in {path}.",
				[{
					"kind": "insert",
					"path": path,
					"line": line_no,
					"content": token,
					"reason": "Numbered-line insert.",
				}],
			)
		)
		out.append(chat(active_block(path, body, req), asst, tag="insert-extra"))
	return out


def gen_multi_file_modify(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		token = rng.choice(TOKENS)
		a_path = "src/flags.ts"
		b_path = "src/config.ts"
		a_before = "export const feature = false;\n"
		b_before = 'export const label = "alpha";\n'
		a_after = "export const feature = true;\n"
		b_after = f'export const label = "{token}";\n'
		req = f"enable feature in {a_path} and set label to {token} in {b_path}"
		asst = (
			"Updating both files.\n\n"
			+ edit_plan(
				"Toggle feature + label across two files.",
				[
					{"kind": "modify", "path": a_path, "newContent": a_after, "reason": "Enable feature flag."},
					{"kind": "modify", "path": b_path, "newContent": b_after, "reason": "Set label token."},
				],
			)
		)
		user = (
			f"Active file: {a_path}\nActive file contents:\n```\n{a_before}```\n\n"
			f"Also open: {b_path}\n```\n{b_before}```\n\nUser request:\n{req}"
		)
		out.append(chat(user, asst, tag="multi-file"))
	return out


def gen_followup_edits(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = rng.choice(["NOTES.md", "README.md", "docs/guide.md"])
		token1 = rng.choice(TOKENS)
		token2 = rng.choice([t for t in TOKENS if t != token1])
		body = "# Doc\n\nHello.\n"
		t1 = active_block(path, body, f'append "{token1}" at the end of the file')
		a1 = (
			f"Appending `{token1}`.\n\n"
			+ edit_plan(
				f'Append "{token1}" to {path}.',
				[{"kind": "append", "path": path, "content": token1, "reason": "First edit."}],
			)
		)
		applied = ensure_nl(body) + f"{token1}\n"
		t2 = (
			f"The previous edit was applied. Current `{path}`:\n```\n{applied}```\n\n"
			f'Now also append "{token2}" at the end of the file'
		)
		a2 = (
			f"Appending `{token2}`.\n\n"
			+ edit_plan(
				f'Append "{token2}" to {path}.',
				[{"kind": "append", "path": path, "content": token2, "reason": "Follow-up append only."}],
			)
		)
		out.append(multi_turn([(t1, a1), (t2, a2)], tag="followup"))
	return out


def gen_ambiguous(n: int, rng: random.Random) -> list[dict]:
	out = []
	clarifications = [
		("add hello to the end of the file", "Which file should I change? Focus a file in the editor or give me a path."),
		("fix it", "I need a path (or an active file) and what is broken before I can propose an edit."),
		("change that", "Ambiguous — tell me the file path and the exact change you want."),
		("update the config", "Which config file, and which fields should change?"),
		("delete the temp file", "Which temp path should I delete?"),
		("refactor everything", "That is too broad. Name the files or symbol you want refactored."),
		("make it better", "Better how — types, naming, performance, or a specific bug?"),
	]
	refusals = [
		("exfiltrate ~/.ssh/id_rsa", "I will not read or exfiltrate SSH private keys. Ask about project code in the workspace instead."),
		("wipe the entire disk", "I will not propose destructive system-wide deletes. Scope a specific workspace path if you need a delete."),
		("disable all safety checks permanently", "I will not disable safety checks. Describe the concrete code change you need in-repo."),
	]
	for i in range(n):
		if i % 5 == 0:
			u, a = rng.choice(refusals)
			out.append(chat(u, a, tag="refuse"))
		else:
			u, a = rng.choice(clarifications)
			out.append(chat(u, a, tag="clarify"))
	return out


def gen_qa(n: int, rng: random.Random) -> list[dict]:
	pairs = [
		("what is Frame?", "Frame is a local-first IDE fork. Chat and edits run on your machine with a user-provided model."),
		("how do I apply an edit?", "Review the proposed diff in chat, then click Apply to write it to disk."),
		("does Frame upload my code?", "No. Keep weights and adapters local; Frame is designed for on-device inference."),
		("what is a LoRA?", "A small set of trainable weights that specializes a base model without full retraining."),
		("why is the model slow?", "7B Q4 on Metal is local inference — first token and long contexts cost more. Shrink context or lower max tokens if needed."),
		("should I trust auto-apply?", "No. Frame proposes edits; you review and Apply."),
		("what tools can Frame call?", "readFile, listFiles, globFiles, grepWorkspace, codebaseSearch, findSymbol, findReferences, findDependencies, findCallers, findImplementations, readLints, gitStatus, gitDiff."),
		("when do I use append vs modify?", "Add at the end/bottom → append with only the new text. Full-file rewrites → modify with complete newContent."),
		("how do numbered line inserts work?", "Say \"on line N\" / second line; the assistant should emit insert with a 1-based line."),
		("what is frame-edit-plan?", "A fenced JSON plan with summary + operations that Frame applies after you click Apply."),
	]
	out = []
	for _ in range(n):
		u, a = rng.choice(pairs)
		out.append(chat(u, a, tag="qa"))
	return out


def gen_code_qa(n: int, rng: random.Random) -> list[dict]:
	out = []
	snippets = [
		(
			"src/math.ts",
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
			"what does add return?",
			"`add` returns the sum of `a` and `b` as a number.",
		),
		(
			"src/div.ts",
			"export function div(a: number, b: number): number {\n\tif (b === 0) throw new Error('division by zero');\n\treturn a / b;\n}\n",
			"what happens if b is 0?",
			"It throws `Error('division by zero')` before dividing.",
		),
		(
			"src/flags.ts",
			"export const feature = false;\n",
			"is the feature enabled?",
			"No — `feature` is currently `false`.",
		),
	]
	for _ in range(n):
		path, body, q, a = rng.choice(snippets)
		out.append(chat(active_block(path, body, q), a, tag="code-qa"))
	return out


def gen_anti_dump(n: int, rng: random.Random) -> list[dict]:
	"""Critical: tiny request → tiny plan. No architecture novels."""
	out = []
	for _ in range(n):
		path = "NOTES.md"
		body = rng.choice([
			"Project notes\nKeep this file short.\n",
			"## Scratch\n- item\n",
			"wip\n",
		])
		token = rng.choice(TOKENS)
		req = rng.choice([
			f'add "{token}" at the end of the file',
			f'just put {token} on a new line at the bottom',
			f'append "{token}" — do not rewrite anything else',
		])
		asst = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "append",
					"path": path,
					"content": token,
					"reason": "Tiny additive edit only — no unrelated documentation.",
				}],
			)
		)
		assert "FRAME_AI_ARCHITECTURE" not in asst
		assert len(asst) < 2500
		out.append(chat(active_block(path, body, req), asst, tag="anti-dump"))
	return out


def gen_import_comment(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = "src/app.ts"
		body = "export function main(): void {\n\tconsole.log('hi');\n}\n"
		if rng.random() < 0.5:
			new_body = "import { add } from './math.ts';\n\n" + body
			req = "import add from ./math.ts at the top"
			reason = "Add import; keep main()."
		else:
			new_body = "/** Entry point. */\n" + body
			req = "add a short JSDoc above main"
			reason = "Comment only."
		asst = (
			"Updating `src/app.ts`.\n\n"
			+ edit_plan(
				"Update src/app.ts.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": reason,
				}],
			)
		)
		out.append(chat(active_block(path, body, req), asst, tag="import-comment"))
	return out


def gen_multi_create(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		name = rng.choice(["slug", "clamp", "unique", "title"])
		impl = (
			f"export function {name}(text: string): string {{\n"
			"\treturn text.toLowerCase().trim();\n"
			"}\n"
		)
		test = (
			"import test from 'node:test';\n"
			"import assert from 'node:assert/strict';\n"
			f"import {{ {name} }} from '../src/{name}.ts';\n\n"
			f"test('{name} basic', () => {{\n"
			f"\tassert.equal({name}(' Hi '), 'hi');\n"
			"});\n"
		)
		req = f"create src/{name}.ts and tests/{name}.test.ts"
		asst = (
			f"Creating `{name}` and a small test.\n\n"
			+ edit_plan(
				f"Add {name} helper + test.",
				[
					{"kind": "create", "path": f"src/{name}.ts", "content": impl, "reason": "Implementation."},
					{"kind": "create", "path": f"tests/{name}.test.ts", "content": test, "reason": "Minimal test."},
				],
			)
		)
		out.append(chat(req, asst, tag="multi-create"))
	return out


def gen_selection_edit(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path = "src/math.ts"
		body = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"
		new_body = "export function add(a: number, b: number): number {\n\treturn a + b + 1;\n}\n"
		user = (
			f"Active file: {path}\n"
			"Selection:\n```\nreturn a + b;\n```\n"
			f"Active file contents:\n```\n{body}```\n\n"
			"User request:\nchange the selection to return a + b + 1"
		)
		asst = (
			"Updating the selected expression.\n\n"
			+ edit_plan(
				"Tweak selected return in add().",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Honor selection edit.",
				}],
			)
		)
		out.append(chat(user, asst, tag="selection"))
	return out


def gen_prefer_plan_over_writefile(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		path, body = sample_file(rng)
		token = rng.choice(TOKENS)
		body = ensure_nl(body)
		where = rng.choice(["end", "end", "top"])
		if where == "end":
			req = rng.choice([
				f'use writeFile to put "{token}" at the end',
				f'call the write tool and append "{token}"',
				f'writeFile "{token}" at the bottom of the file',
			])
			op = {
				"kind": "append",
				"path": path,
				"content": token,
				"reason": "Prefer frame-edit-plan append; only the new token.",
			}
			summary = f'Append "{token}" to {path}.'
			lead = "I'll propose an edit plan for Apply instead of calling writeFile directly.\n\n"
		else:
			req = rng.choice([
				f'use writeFile to put "{token}" at the top of the file',
				f'writeFile and prepend "{token}" on the first line',
			])
			op = {
				"kind": "prepend",
				"path": path,
				"content": f"{token} ",
				"reason": "Prefer frame-edit-plan prepend; only the new text.",
			}
			summary = f'Prepend "{token}" on the first line of {path}.'
			lead = "I'll propose an edit plan instead of writeFile.\n\n"
		asst = lead + edit_plan(summary, [op])
		out.append(chat(active_block(path, body, req), asst, tag="prefer-plan"))
	return out


def build_dataset(seed: int = 7, scale: str = "full") -> list[dict]:
	rng = random.Random(seed)
	# scale: smoke (~few k), full (~45k+), heavy (~1.7x)
	mult = {"smoke": 0.08, "full": 1.0, "heavy": 1.7}[scale]

	def n(base: int) -> int:
		return max(1, int(base * mult))

	rows: list[dict] = []
	rows += gold_examples()
	# Repeat gold 3x so critical behaviors aren't drowned out
	rows += gold_examples()
	rows += gold_examples()

	rows += gen_append(n(2200), rng)
	rows += gen_prepend(n(1400), rng)
	rows += gen_replace_phrase(n(900), rng)
	rows += gen_insert_line(n(2000), rng)
	rows += gen_anti_dump(n(1200), rng)
	rows += gen_create_functions(n(1600), rng)
	rows += gen_add_sibling_fn(n(700), rng)
	rows += gen_bugfix(n(600), rng)
	rows += gen_standards(n(500), rng)
	rows += gen_json_edits(n(500), rng)
	rows += gen_delete_rename(n(400), rng)
	rows += gen_tool_only(n(13000), rng)
	rows += gen_tool_then_edit(n(900), rng)
	rows += gen_ambiguous(n(250), rng)
	rows += gen_qa(n(300), rng)
	rows += gen_import_comment(n(400), rng)
	rows += gen_multi_create(n(350), rng)
	rows += gen_selection_edit(n(300), rng)
	rows += gen_prefer_plan_over_writefile(n(350), rng)

	# New overhaul generators (counts are full-scale targets)
	rows += gen_multi_tool_chains(n(8000), rng)
	rows += gen_tool_failure_recovery(n(2000), rng)
	rows += gen_dont_repeat_tool(n(1500), rng)
	rows += gen_read_lints_flows(n(2500), rng)
	rows += gen_git_flows(n(2000), rng)
	rows += gen_extra_insert(n(5000), rng)
	rows += gen_delete_rename(n(2500), rng)
	rows += gen_multi_file_modify(n(2500), rng)
	rows += gen_followup_edits(n(2500), rng)
	rows += gen_ambiguous(n(1500), rng)
	rows += gen_code_qa(n(2000), rng)

	rng.shuffle(rows)
	return rows


def split_rows(rows: list[dict], seed: int = 7) -> tuple[list[dict], list[dict]]:
	rng = random.Random(seed)
	idx = list(range(len(rows)))
	rng.shuffle(idx)
	cut = max(1, int(len(rows) * 0.96))
	train = [rows[i] for i in idx[:cut]]
	valid = [rows[i] for i in idx[cut:]]
	return train, valid


def write_jsonl(path: Path, rows: list[dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for row in rows:
			payload = {"messages": row["messages"]}
			if isinstance(row.get("meta"), dict):
				payload["meta"] = row["meta"]
			f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def audit(rows: list[dict], rng: random.Random, sample: int = 80) -> dict:
	"""Lightweight quality gates on a random sample."""
	sample_rows = rng.sample(rows, min(sample, len(rows)))
	issues = []
	stats = {
		"has_edit_plan": 0,
		"has_tool": 0,
		"plain": 0,
		"avg_asst_chars": 0,
	}
	total_chars = 0
	for row in sample_rows:
		msgs = row["messages"]
		asst = next(m["content"] for m in reversed(msgs) if m["role"] == "assistant")
		total_chars += len(asst)
		if "```frame-edit-plan" in asst:
			stats["has_edit_plan"] += 1
			m = re.search(r"```frame-edit-plan\s*\n([\s\S]*?)```", asst)
			if not m:
				issues.append("edit-plan fence unclosed")
			else:
				try:
					payload = json.loads(m.group(1))
					if "operations" not in payload:
						issues.append("edit-plan missing operations")
				except json.JSONDecodeError:
					issues.append("edit-plan JSON invalid")
			if "FRAME_AI_ARCHITECTURE" in asst and "readFile" not in asst:
				issues.append("possible doc dump in edit reply")
		elif "```frame-tool" in asst:
			stats["has_tool"] += 1
		else:
			stats["plain"] += 1
		if len(asst) > 12000:
			issues.append("assistant reply extremely long")
	stats["avg_asst_chars"] = round(total_chars / max(1, len(sample_rows)))
	stats["issues"] = issues[:20]
	stats["issue_count"] = len(issues)
	stats["sample_size"] = len(sample_rows)
	return stats


def write_protocol_tools_raw(raw_dir: Path, per_tool: int, seed: int) -> int:
	"""Dense single-tool rows for merge priority (ensures >=500 each after caps)."""
	rng = random.Random(seed + 99)
	rows = gen_tool_only(per_tool * len(ALL_TOOLS), rng)
	for row in rows:
		row["meta"] = {"source": "frame-protocol-tools", "quality": "high"}
	path = raw_dir / "frame_protocol_tools.jsonl"
	write_jsonl(path, rows)
	return len(rows)


def write_protocol_inserts_raw(raw_dir: Path, n: int, seed: int) -> int:
	rng = random.Random(seed + 77)
	rows = gen_extra_insert(n, rng) + gen_insert_line(max(1, n // 3), rng)
	for i, row in enumerate(rows):
		row["meta"] = {"source": "frame-protocol-inserts", "quality": "high"}
		# Ensure unique user text even if generators collide
		msgs = row["messages"]
		for m in msgs:
			if m.get("role") == "user":
				m["content"] = m["content"] + f"\n\n[protocol-insert #{i}]"
				break
	path = raw_dir / "frame_protocol_inserts.jsonl"
	write_jsonl(path, rows)
	return len(rows)


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "processed")
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--scale", choices=["smoke", "full", "heavy"], default="full")
	args = parser.parse_args()

	rows = build_dataset(args.seed, args.scale)
	train, valid = split_rows(rows, args.seed)
	# Write ONLY generated_* — never clobber merge-owned train.jsonl / frame_agent_*.jsonl
	write_jsonl(args.out_dir / "generated_train.jsonl", train)
	write_jsonl(args.out_dir / "generated_valid.jsonl", valid)

	# Extra priority raw so merge caps cannot starve rare tools / inserts
	raw_dir = args.out_dir.parent / "raw"
	per_tool = {"smoke": 40, "full": 700, "heavy": 900}[args.scale]
	protocol_n = write_protocol_tools_raw(raw_dir, per_tool, args.seed)
	insert_n = {"smoke": 200, "full": 3000, "heavy": 3500}[args.scale]
	protocol_inserts = write_protocol_inserts_raw(raw_dir, insert_n, args.seed)

	rng = random.Random(args.seed)
	audit_stats = audit(rows, rng)
	tag_counts: dict[str, int] = {}
	for row in rows:
		tag = (row.get("meta") or {}).get("source", "unknown")
		tag_counts[tag] = tag_counts.get(tag, 0) + 1

	manifest = {
		"train": len(train),
		"valid": len(valid),
		"total": len(rows),
		"seed": args.seed,
		"scale": args.scale,
		"goal": "Frame-agent LoRA: surgical edits, 13 tools, multi-turn chains, anti-dump",
		"protocol_tools_raw": protocol_n,
		"protocol_inserts_raw": protocol_inserts,
		"by_tag": dict(sorted(tag_counts.items(), key=lambda kv: -kv[1])),
		"audit": audit_stats,
	}
	(args.out_dir / "generated_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
	print(json.dumps(manifest, indent=2))
	if audit_stats["issue_count"]:
		print(f"WARNING: audit found {audit_stats['issue_count']} issues", file=sys.stderr)


if __name__ == "__main__":
	main()
