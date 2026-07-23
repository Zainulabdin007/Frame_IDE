#!/usr/bin/env python3
"""
Frame-agent LoRA dataset builder.

Quality > template spam:
- gold_seeds.py: hand-authored critical behaviors
- corpus.py: realistic multi-line files
- Generators: surgical edits, tools, multi-turn, standards, anti-dump

Target scale: ~12k–18k rows with high format fidelity for Frame IDE.
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


def ensure_nl(s: str) -> str:
	return s if s.endswith("\n") or s == "" else s + "\n"


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
		body = ensure_nl(body) if body else body
		new_body = (body or "") + f"{token}\n"
		asst = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
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
		lines = body.splitlines(keepends=True)
		if not lines:
			lines = ["\n"]
		first = lines[0]
		# If first line is newline-only, put token as the line
		if first.strip() == "":
			lines[0] = f"{token}\n"
		else:
			# Preserve trailing newline of first line
			nl = "\n" if first.endswith("\n") else ""
			core = first[:-1] if first.endswith("\n") else first
			lines[0] = f"{token} {core}{nl}"
		new_body = "".join(lines)
		if not new_body.endswith("\n"):
			new_body += "\n"
		asst = (
			f"Prepending `{token}` to the first line of `{path}`.\n\n"
			+ edit_plan(
				f'Prepend "{token}" on the first line of {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
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
			# Force a body that contains old
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
	for _ in range(n):
		path = rng.choice(["NOTES.md", "CHANGELOG.md", "docs/guide.md"])
		lines = ["# Title", "", "- first item", "- second item", ""]
		body = "\n".join(lines) + "\n"
		token = rng.choice(TOKENS)
		# Insert after first bullet
		new_lines = lines[:3] + [f"- {token}"] + lines[3:]
		new_body = "\n".join(new_lines) + "\n"
		req = rng.choice([
			f'add a bullet "- {token}" after the first bullet',
			f'insert "- {token}" as the second list item',
		])
		asst = (
			f"Inserting the bullet into `{path}`.\n\n"
			+ edit_plan(
				f"Insert bullet in {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Insert mid-file; preserve surrounding lines.",
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
	for _ in range(n):
		if rng.random() < 0.5:
			path = rng.choice(["tmp/scratch.txt", "tmp/old.md", "build/out.txt", "notes.bak"])
			req = rng.choice([f"delete {path}", f"remove the file {path}"])
			asst = (
				f"Deleting `{path}`.\n\n"
				+ edit_plan(
					f"Delete {path}.",
					[{"kind": "delete", "path": path, "reason": "User asked to delete it."}],
				)
			)
		else:
			src = rng.choice(["src/util.ts", "src/helper.py", "lib/old.js"])
			dst = src.replace("util", "utils").replace("helper", "helpers").replace("old", "legacy")
			if dst == src:
				dst = src + ".bak"
			req = f"rename {src} to {dst}"
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
	out = []
	for _ in range(n):
		kind = rng.choice([
			"readFile", "grepWorkspace", "findSymbol", "findReferences",
			"listFiles", "searchWorkspace", "gitStatus", "gitDiff",
		])
		if kind == "readFile":
			path = rng.choice(["README.md", "src/app.ts", "FRAME_AI_ARCHITECTURE.md", "package.json"])
			user = rng.choice([f"show me {path}", f"open {path}", f"read {path}"])
			asst = f"Reading `{path}`.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
		elif kind == "grepWorkspace":
			pat = rng.choice(["TODO", "FIXME", "frame-edit-plan", "export function", "FrameChatAgent"])
			user = f"search the workspace for {pat}"
			asst = f"Searching for `{pat}`.\n\n" + tool_call("grepWorkspace", {"pattern": pat, "limit": 40})
		elif kind == "findSymbol":
			sym = rng.choice(["FrameChatAgent", "add", "clamp", "loadModel", "parseModelEditPlan"])
			user = f"find the symbol {sym}"
			asst = f"Looking up `{sym}`.\n\n" + tool_call("findSymbol", {"name": sym, "limit": 20})
		elif kind == "findReferences":
			sym = rng.choice(["add", "SYSTEM", "edit_plan", "FrameTaskKind"])
			user = f"find references to {sym}"
			asst = f"Finding references to `{sym}`.\n\n" + tool_call("findReferences", {"name": sym, "limit": 30})
		elif kind == "listFiles":
			d = rng.choice(["src", "tools", "tools/frame-model-worker", "vscode/src"])
			user = f"list files under {d}"
			asst = f"Listing `{d}`.\n\n" + tool_call("listFiles", {"path": d, "limit": 100})
		elif kind == "searchWorkspace":
			q = rng.choice(["frame", "lora", "runtime", "edit", "worker"])
			user = f"find files named like {q}"
			asst = f"Searching filenames for `{q}`.\n\n" + tool_call("searchWorkspace", {"query": q, "limit": 40})
		elif kind == "gitStatus":
			user = rng.choice(["git status", "what's my git status?", "show git status"])
			asst = "Checking git status.\n\n" + tool_call("gitStatus", {})
		else:
			user = rng.choice(["git diff", "show me the diff", "git diff for src/app.ts"])
			args = {} if "for" not in user else {"path": "src/app.ts"}
			asst = "Fetching git diff.\n\n" + tool_call("gitDiff", args)
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
		new_content = ensure_nl(original) + f"{token}\n"
		t1 = (
			f"Active file: (none focused)\n\nUser request:\nappend \"{token}\" to the end of {path}"
		)
		a1 = (
			f"I'll read `{path}` first, then propose the edit.\n\n"
			+ tool_call("readFile", {"path": path, "maxBytes": 20000})
		)
		t2 = (
			"Tool result for readFile:\n"
			+ json.dumps(
				{"success": True, "data": {"path": path, "content": original, "truncated": False}},
				indent=2,
			)
			+ "\n\nContinue answering the user. Emit another ```frame-tool block only if you still need a tool; "
			"otherwise give your final answer with no frame-tool block."
		)
		a2 = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_content,
					"reason": "Append after reading current contents.",
				}],
			)
		)
		out.append(multi_turn([(t1, a1), (t2, a2)], tag="tool-edit"))
	return out


def gen_ambiguous(n: int, rng: random.Random) -> list[dict]:
	out = []
	for _ in range(n):
		user = rng.choice([
			"add hello to the end of the file",
			"fix it",
			"change that",
			"update the config",
			"delete the temp file",
		])
		asst = rng.choice([
			"Which file should I change? Focus a file in the editor or give me a path.",
			"I need a path (or an active file) before I can propose an edit.",
			"Ambiguous — tell me the file path and the exact change you want.",
		])
		out.append(chat(user, asst, tag="clarify"))
	return out


def gen_qa(n: int, rng: random.Random) -> list[dict]:
	pairs = [
		("what is Frame?", "Frame is a local-first IDE fork. Chat and edits run on your machine with a user-provided model."),
		("how do I apply an edit?", "Review the proposed diff in chat, then click Apply to write it to disk."),
		("does Frame upload my code?", "No. Keep weights and adapters local; Frame is designed for on-device inference."),
		("what is a LoRA?", "A small set of trainable weights that specializes a base model without full retraining."),
		("why is the model slow?", "7B Q4 on Metal is local inference — first token and long contexts cost more. Shrink context or lower max tokens if needed."),
		("should I trust auto-apply?", "No. Frame proposes edits; you review and Apply."),
	]
	out = []
	for _ in range(n):
		u, a = rng.choice(pairs)
		out.append(chat(u, a, tag="qa"))
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
					"kind": "modify",
					"path": path,
					"newContent": ensure_nl(body) + f"{token}\n",
					"reason": "Tiny additive edit only — no unrelated documentation.",
				}],
			)
		)
		# Assert assistant stays short (training signal via content itself)
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
		req = rng.choice([
			f'use writeFile to put "{token}" at the end',
			f'call the write tool and append "{token}"',
		])
		asst = (
			"I'll propose an edit plan for Apply instead of calling writeFile directly.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": body + f"{token}\n",
					"reason": "Prefer frame-edit-plan for user-reviewed applies.",
				}],
			)
		)
		out.append(chat(active_block(path, body, req), asst, tag="prefer-plan"))
	return out


def build_dataset(seed: int = 7, scale: str = "full") -> list[dict]:
	rng = random.Random(seed)
	# scale: smoke (~1k), full (~15k), heavy (~25k)
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
	rows += gen_insert_line(n(600), rng)
	rows += gen_anti_dump(n(1200), rng)
	rows += gen_create_functions(n(1600), rng)
	rows += gen_add_sibling_fn(n(700), rng)
	rows += gen_bugfix(n(600), rng)
	rows += gen_standards(n(500), rng)
	rows += gen_json_edits(n(500), rng)
	rows += gen_delete_rename(n(400), rng)
	rows += gen_tool_only(n(1000), rng)
	rows += gen_tool_then_edit(n(900), rng)
	rows += gen_ambiguous(n(250), rng)
	rows += gen_qa(n(300), rng)
	rows += gen_import_comment(n(400), rng)
	rows += gen_multi_create(n(350), rng)
	rows += gen_selection_edit(n(300), rng)
	rows += gen_prefer_plan_over_writefile(n(350), rng)

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
			# Drop meta for mlx cleanliness but keep messages
			payload = {"messages": row["messages"]}
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
			# Must be valid-ish JSON
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


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "processed")
	parser.add_argument("--seed", type=int, default=7)
	parser.add_argument("--scale", choices=["smoke", "full", "heavy"], default="full")
	args = parser.parse_args()

	rows = build_dataset(args.seed, args.scale)
	train, valid = split_rows(rows, args.seed)
	write_jsonl(args.out_dir / "frame_agent_train.jsonl", train)
	write_jsonl(args.out_dir / "frame_agent_valid.jsonl", valid)
	write_jsonl(args.out_dir / "train.jsonl", train)
	write_jsonl(args.out_dir / "valid.jsonl", valid)

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
		"goal": "Frame-agent LoRA: surgical edits, tools, basic code, anti-dump",
		"by_source": dict(sorted(tag_counts.items(), key=lambda kv: -kv[1])),
		"audit": audit_stats,
	}
	(args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
	print(json.dumps(manifest, indent=2))
	if audit_stats["issue_count"]:
		print(f"WARNING: audit found {audit_stats['issue_count']} issues", file=sys.stderr)


if __name__ == "__main__":
	main()
