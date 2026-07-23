#!/usr/bin/env python3
"""
High-precision Frame-product gold expansion.

Emits thousands of rows that teach the 7B to nail Frame IDE behaviors:
  - append/prepend tiny tokens (full newContent, no doc dumps)
  - ```frame-edit-plan with FULL newContent
  - readFile → edit multi-turn
  - basic typed TS/Python creates
  - clarify when path missing
  - prefer edit-plan over writeFile
  - delete/rename
  - JSON config toggles
  - anti-dump: never paste FRAME_AI_ARCHITECTURE into NOTES.md

Outputs (under data/raw/):
  recovery_gold_b.jsonl
  frame_product_gold.jsonl
  multiturn_gold.jsonl
"""

from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import (  # noqa: E402
	active_block,
	changelog,
	css_snippet,
	html_page,
	json_config,
	md_notes,
	md_readme,
	py_module,
	sample_file,
	ts_module,
)
from gold_seeds import SYSTEM  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
LOGS = ROOT / "logs"
FRAMEAI = (
	ROOT.parents[1]
	/ "vscode"
	/ "src"
	/ "vs"
	/ "workbench"
	/ "contrib"
	/ "frameAI"
)

TOKENS = [
	"works", "done", "ready", "ok", "pass", "frame", "local", "alpha", "beta",
	"note", "TODO", "FIXME", "draft", "v1", "stable", "ship", "wip", "nits",
	"checked", "verified", "lgtm", "hotfix", "patch", "release", "yes", "noop",
	"shipit", "okey", "ack", "fin", "end", "mark", "flag", "tag", "tmp",
]

APPEND_PHRASES = [
	'add "{t}" at the end of the file now',
	'append "{t}" to the end',
	'put "{t}" on a new line at the bottom',
	'can you add "{t}" at the end of the file',
	'stick "{t}" at the bottom — nothing else',
	'please add the word {t} at the end of this document',
	'end the file with "{t}"',
	'write "{t}" after the last line',
	'add "{t}" at the end of the file',
	'just put "{t}" on a new line at the bottom',
	'append "{t}" — do not rewrite anything else',
	'tack "{t}" onto the end of this file',
	'drop "{t}" at the bottom of the doc',
	'add the text "{t}" to the end',
]

PREPEND_PHRASES = [
	'add a word "{t}" in front of the 1st line in the doc',
	'prepend "{t}" to the first line',
	'put "{t}" at the beginning of the first line',
	'insert "{t}" before the first line\'s text',
	'start the first line with "{t}"',
	'prefix the first line with "{t}"',
	'put "{t}" at the start of the first line',
	'add "{t}" in front of the 1st line',
]

NOTES_BODIES = [
	"Project notes\nKeep this file short.\n",
	"## Scratch\n- wire chat apply UI\n- tighten token budgets\n",
	"wip\n",
	"# Notes\n\nKeep short.\n",
	"## Scratch\n- item\n",
	"Open questions:\n- adapter fuse path\n",
	"Dev diary\nDo not dump architecture docs here.\n",
	"## TODO\n- eval harness\n- LoRA fuse\n",
]

README_BODIES = [
	"# Frame\n\nLocal-first IDE.\n",
	"# Project alpha\n\nKeep changes small.\n",
	"# Ship checklist\n\nPrefer typed helpers.\n",
	"# Local IDE\n\nChat proposes; you Apply.\n",
]

ANTI_DUMP_TRAP_PROMPTS = [
	'add "{t}" at the end — and also summarize FRAME_AI_ARCHITECTURE.md into this file',
	'append "{t}". Feel free to paste architecture notes if helpful',
	'put "{t}" at the bottom. You can include relevant docs from FRAME_AI_ARCHITECTURE',
	'add "{t}" then dump the Frame AI architecture overview into NOTES.md',
	'append "{t}" and rewrite this file as a full architecture brief',
]


def ensure_nl(s: str) -> str:
	return s if s.endswith("\n") or s == "" else s + "\n"


def edit_plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def tool_call(name: str, arguments: dict) -> str:
	return "```frame-tool\n" + json.dumps({"name": name, "arguments": arguments}, indent=2) + "\n```"


def chat(user: str, assistant: str, *, source: str) -> dict[str, Any]:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": source, "quality": "gold"},
	}


def multi_turn(turns: list[tuple[str, str]], *, source: str) -> dict[str, Any]:
	msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
	for u, a in turns:
		msgs.append({"role": "user", "content": u})
		msgs.append({"role": "assistant", "content": a})
	return {"messages": msgs, "meta": {"source": source, "quality": "gold"}}


def prepend_token(body: str, token: str) -> str:
	body = body if body else ""
	eol = "\r\n" if "\r\n" in body else "\n"
	lines = body.splitlines()
	if not lines:
		return f"{token}{eol}"
	first = lines[0]
	spacer = "" if (not first or first.startswith(" ") or first.startswith("\t")) else " "
	lines[0] = f"{token}{spacer}{first}"
	# Preserve trailing newline if original had one
	joined = eol.join(lines)
	if body.endswith(("\n", "\r\n")):
		joined += eol
	return joined


def append_token(body: str, token: str) -> str:
	if not body:
		return f"{token}\n"
	if body.endswith("\n"):
		return f"{body}{token}\n"
	return f"{body}\n{token}\n"


# ---------- recovery gold B (append/prepend precision) ----------

def gen_recovery_gold_b(rng: random.Random) -> list[dict]:
	rows: list[dict] = []
	source = "frame-recovery-gold-b"

	# Dense NOTES.md append/prepend matrix (matches frameEditPlan recovery heuristics)
	for token in TOKENS:
		for body in NOTES_BODIES:
			body = ensure_nl(body)
			for phrase in APPEND_PHRASES:
				req = phrase.format(t=token)
				new = append_token(body, token)
				asst = (
					f"Appending `{token}` to `NOTES.md`.\n\n"
					+ edit_plan(
						f'Append "{token}" to NOTES.md.',
						[{
							"kind": "modify",
							"path": "NOTES.md",
							"newContent": new,
							"reason": "Tiny additive edit only — no unrelated documentation.",
						}],
					)
				)
				assert "FRAME_AI_ARCHITECTURE" not in asst
				rows.append(chat(active_block("NOTES.md", body, req), asst, source=source))

			for phrase in PREPEND_PHRASES:
				req = phrase.format(t=token)
				new = prepend_token(body, token)
				asst = (
					f"Prepending `{token}` to the first line of `NOTES.md`.\n\n"
					+ edit_plan(
						f'Prepend "{token}" on first line of NOTES.md.',
						[{
							"kind": "modify",
							"path": "NOTES.md",
							"newContent": new,
							"reason": "Only the first line changes.",
						}],
					)
				)
				rows.append(chat(active_block("NOTES.md", body, req), asst, source=source))

	# README / guide / changelog variants with corpus bodies
	alt_paths = [
		("README.md", README_BODIES),
		("docs/guide.md", [md_readme(rng) for _ in range(4)]),
		("CHANGELOG.md", [changelog(rng) for _ in range(3)]),
		("DEV.md", [md_notes(rng) for _ in range(4)]),
	]
	for path, bodies in alt_paths:
		for body in bodies:
			body = ensure_nl(body)
			token = rng.choice(TOKENS)
			phrase = rng.choice(APPEND_PHRASES).format(t=token)
			new = append_token(body, token)
			asst = (
				f"Appending `{token}` to `{path}`.\n\n"
				+ edit_plan(
					f'Append "{token}" to {path}.',
					[{
						"kind": "modify",
						"path": path,
						"newContent": new,
						"reason": "Tiny additive edit only — no unrelated documentation.",
					}],
				)
			)
			rows.append(chat(active_block(path, body, phrase), asst, source=source))

			token2 = rng.choice(TOKENS)
			phrase2 = rng.choice(PREPEND_PHRASES).format(t=token2)
			new2 = prepend_token(body, token2)
			asst2 = (
				f"Prepending `{token2}` to the first line of `{path}`.\n\n"
				+ edit_plan(
					f'Prepend "{token2}" on first line of {path}.',
					[{
						"kind": "modify",
						"path": path,
						"newContent": new2,
						"reason": "Only the first line changes.",
					}],
				)
			)
			rows.append(chat(active_block(path, body, phrase2), asst2, source=source))

	# Empty-file edge cases
	for token in TOKENS[:20]:
		req = f'put "{token}" as the first line'
		asst = (
			f"Writing `{token}`.\n\n"
			+ edit_plan(
				f"Write {token} into NEW.md.",
				[{
					"kind": "modify",
					"path": "NEW.md",
					"newContent": f"{token}\n",
					"reason": "File was empty.",
				}],
			)
		)
		rows.append(chat(active_block("NEW.md", "", req), asst, source=source))

	rng.shuffle(rows)
	return rows


# ---------- product gold (behaviors beyond recovery) ----------

TS_SPECS = [
	("add", "a: number, b: number", "number", "\treturn a + b;"),
	("sub", "a: number, b: number", "number", "\treturn a - b;"),
	("mul", "a: number, b: number", "number", "\treturn a * b;"),
	("clamp", "n: number, min: number, max: number", "number", "\treturn Math.min(max, Math.max(min, n));"),
	("isEmpty", "value: string | null | undefined", "boolean", "\treturn !value || value.trim().length === 0;"),
	("unique", "items: string[]", "string[]", "\treturn [...new Set(items)];"),
	(
		"slugify",
		"text: string",
		"string",
		"\treturn text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');",
	),
	("sum", "nums: number[]", "number", "\treturn nums.reduce((a, b) => a + b, 0);"),
	("pick", "obj: Record<string, unknown>, key: string", "unknown", "\treturn obj[key];"),
	("compact", "items: Array<string | null | undefined>", "string[]", "\treturn items.filter((x): x is string => Boolean(x));"),
	("titleCase", "value: string", "string", "\treturn value.split(/\\s+/).filter(Boolean).map(p => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join(' ');"),
	("once", "fn: () => void", "() => void", "\tlet called = false;\n\treturn () => {\n\t\tif (called) return;\n\t\tcalled = true;\n\t\tfn();\n\t};"),
]

PY_SPECS = [
	("add", "a: int, b: int", "int", "    return a + b"),
	("sub", "a: int, b: int", "int", "    return a - b"),
	("mul", "a: int, b: int", "int", "    return a * b"),
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
	("mean", "nums: list[float]", "float", "    if not nums:\n        raise ValueError(\"empty\")\n    return sum(nums) / len(nums)"),
]

CREATE_PHRASES_TS = [
	"create src/{name}.ts with a TypeScript function {name}({params}): {ret}",
	"write src/{name}.ts exporting typed {name}({params}): {ret}",
	"add src/{name}.ts — export function {name}({params}): {ret}",
	"make a file src/{name}.ts with {name}({params}) returning {ret}",
]

CREATE_PHRASES_PY = [
	"write src/{name}.py with {name}({params}) -> {ret} and type hints",
	"create src/{name}.py exporting {name}({params}) -> {ret}",
	"add src/{name}.py — def {name}({params}) -> {ret}",
]


def gen_frame_product_gold(rng: random.Random) -> list[dict]:
	rows: list[dict] = []
	src = "frame-product-gold"

	# --- Anti-dump: trap prompts that tempt architecture paste ---
	for token in TOKENS:
		for body in NOTES_BODIES:
			body = ensure_nl(body)
			trap = rng.choice(ANTI_DUMP_TRAP_PROMPTS).format(t=token)
			# Also plain tiny prompts
			plain = rng.choice(APPEND_PHRASES).format(t=token)
			for req in (trap, plain):
				new = append_token(body, token)
				asst = (
					f"Appending `{token}` to `NOTES.md`.\n\n"
					+ edit_plan(
						f'Append "{token}" to NOTES.md.',
						[{
							"kind": "modify",
							"path": "NOTES.md",
							"newContent": new,
							"reason": "Additive one-line change only — never dump FRAME_AI_ARCHITECTURE or other docs.",
						}],
					)
				)
				assert "FRAME_AI_ARCHITECTURE" not in asst or "never dump" in asst
				# Ensure newContent itself has no architecture dump
				assert "FRAME_AI_ARCHITECTURE" not in new
				assert len(new) < len(body) + 40
				rows.append(chat(active_block("NOTES.md", body, req), asst, source=src))

	# Explicit refuse-to-dump when asked to rewrite NOTES from architecture
	for body in NOTES_BODIES:
		body = ensure_nl(body)
		req = rng.choice([
			"paste FRAME_AI_ARCHITECTURE.md into this NOTES.md file",
			"replace NOTES.md with the contents of FRAME_AI_ARCHITECTURE.md",
			"dump the Frame AI architecture document into NOTES.md",
		])
		asst = (
			"`NOTES.md` should stay short. I won't paste `FRAME_AI_ARCHITECTURE.md` into it. "
			"If you want a link or a one-line pointer, say so; otherwise leave NOTES alone.\n\n"
			"Which change do you actually want in `NOTES.md`?"
		)
		rows.append(chat(active_block("NOTES.md", body, req), asst, source=src))

	# --- Typed TS/Python creates ---
	for name, params, ret, body_line in TS_SPECS:
		content = f"export function {name}({params}): {ret} {{\n{body_line}\n}}\n"
		for phrase_t in CREATE_PHRASES_TS:
			req = phrase_t.format(name=name, params=params, ret=ret)
			asst = (
				f"Creating `src/{name}.ts`.\n\n"
				+ edit_plan(
					f"Create typed {name}() in src/{name}.ts.",
					[{
						"kind": "create",
						"path": f"src/{name}.ts",
						"content": content,
						"reason": "User requested a basic typed helper.",
					}],
				)
			)
			rows.append(chat(req, asst, source=src))

	for name, params, ret, body_line in PY_SPECS:
		content = f"def {name}({params}) -> {ret}:\n{body_line}\n"
		for phrase_t in CREATE_PHRASES_PY:
			req = phrase_t.format(name=name, params=params, ret=ret)
			asst = (
				f"Creating `src/{name}.py`.\n\n"
				+ edit_plan(
					f"Create {name}() with type hints.",
					[{
						"kind": "create",
						"path": f"src/{name}.py",
						"content": content,
						"reason": "Basic typed helper as requested.",
					}],
				)
			)
			rows.append(chat(req, asst, source=src))

	# --- JSON config field toggles ---
	json_cases = [
		(
			".frame/config/runtime.json",
			'{\n  "runtime": "llamacpp",\n  "enabled": false,\n  "maxTokens": 1024\n}\n',
			'{\n  "runtime": "llamacpp",\n  "enabled": true,\n  "maxTokens": 1024\n}\n',
			"set enabled to true",
			"Set enabled=true in runtime.json.",
		),
		(
			".frame/config/runtime.json",
			'{\n  "runtime": "llamacpp",\n  "enabled": true,\n  "maxTokens": 1024\n}\n',
			'{\n  "runtime": "llamacpp",\n  "enabled": false,\n  "maxTokens": 1024\n}\n',
			"set enabled to false",
			"Set enabled=false in runtime.json.",
		),
		(
			"config.json",
			'{\n  "enabled": true,\n  "maxTokens": 1024\n}\n',
			'{\n  "enabled": true,\n  "maxTokens": 1024,\n  "temperature": 0.2\n}\n',
			'add "temperature": 0.2 to this config',
			"Add temperature to config.json.",
		),
		(
			"config.json",
			'{\n  "enabled": true,\n  "maxTokens": 1024,\n  "temperature": 0.2\n}\n',
			'{\n  "enabled": true,\n  "maxTokens": 2048,\n  "temperature": 0.2\n}\n',
			"change maxTokens to 2048",
			"Bump maxTokens to 2048.",
		),
		(
			".frame/config/runtime.json",
			'{\n  "runtime": "stub",\n  "activeModelId": "local-dev",\n  "enabled": true\n}\n',
			'{\n  "runtime": "llamacpp",\n  "activeModelId": "local-dev",\n  "enabled": true\n}\n',
			'set runtime to "llamacpp"',
			"Switch runtime to llamacpp.",
		),
		(
			"package.json",
			'{\n  "name": "frame-app",\n  "version": "0.1.0",\n  "private": true\n}\n',
			'{\n  "name": "frame-app",\n  "version": "0.1.1",\n  "private": true\n}\n',
			'bump version to "0.1.1"',
			"Bump package.json version.",
		),
		(
			"tsconfig.json",
			'{\n  "compilerOptions": {\n    "strict": false,\n    "target": "ES2022"\n  }\n}\n',
			'{\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022"\n  }\n}\n',
			"turn on strict mode",
			"Enable compilerOptions.strict.",
		),
	]
	toggle_paraphrases = [
		"{req}",
		"please {req}",
		"{req} only — nothing else",
		"in this file, {req}",
		"update the json: {req}",
	]
	for path, before, after, req_base, summary in json_cases:
		for para in toggle_paraphrases:
			req = para.format(req=req_base)
			asst = (
				f"Updating `{path}`.\n\n"
				+ edit_plan(
					summary,
					[{
						"kind": "modify",
						"path": path,
						"newContent": after,
						"reason": "Toggle/field change only; preserve other keys.",
					}],
				)
			)
			rows.append(chat(active_block(path, before, req), asst, source=src))
		# Extra: corpus-generated json with enabled flip
		for _ in range(8):
			cfg = json_config(rng)
			obj = json.loads(cfg)
			obj["enabled"] = not bool(obj.get("enabled", True))
			after2 = json.dumps(obj, indent=2) + "\n"
			req = "set enabled to " + ("true" if obj["enabled"] else "false")
			asst = (
				f"Updating `{path}`.\n\n"
				+ edit_plan(
					f"Set enabled={str(obj['enabled']).lower()}.",
					[{
						"kind": "modify",
						"path": path,
						"newContent": after2,
						"reason": "Toggle only.",
					}],
				)
			)
			rows.append(chat(active_block(path, cfg, req), asst, source=src))

	# --- Delete / rename ---
	delete_targets = [
		"tmp/scratch.txt", "tmp/out.log", "build/cache.bin", ".DS_Store",
		"notes.bak", "src/old.ts", "scripts/tmp.sh", "coverage/lcov.info",
		"dist/bundle.js.map", "tmp/frame-debug.json",
	]
	delete_phrases = [
		"delete the file {p}",
		"remove {p}",
		"please delete {p}",
		"trash {p}",
		"delete {p} from the workspace",
	]
	for p in delete_targets:
		for phrase in delete_phrases:
			req = phrase.format(p=p)
			asst = (
				f"Removing `{p}`.\n\n"
				+ edit_plan(
					f"Delete {p}.",
					[{"kind": "delete", "path": p, "reason": "User asked to delete it."}],
				)
			)
			rows.append(chat(req, asst, source=src))

	renames = [
		("src/util.ts", "src/utils.ts"),
		("src/helper.ts", "src/helpers.ts"),
		("lib/old.js", "lib/index.js"),
		("docs/guide.md", "docs/getting-started.md"),
		("NOTES.md", "DEVNOTES.md"),
		("src/math.ts", "src/arith.ts"),
		("scripts/run.sh", "scripts/launch.sh"),
		("config.json", "settings.json"),
	]
	rename_phrases = [
		"rename {a} to {b}",
		"please rename {a} → {b}",
		"move {a} to {b}",
		"rename file {a} as {b}",
	]
	for a, b in renames:
		for phrase in rename_phrases:
			req = phrase.format(a=a, b=b)
			asst = (
				"Renaming the file.\n\n"
				+ edit_plan(
					f"Rename {Path(a).name} → {Path(b).name}.",
					[{
						"kind": "rename",
						"fromPath": a,
						"toPath": b,
						"reason": "User requested rename.",
					}],
				)
			)
			rows.append(chat(req, asst, source=src))

	# --- Prefer edit-plan over writeFile ---
	prefer_phrases = [
		'use writeFile to put "{t}" at the end',
		'call the write tool and append "{t}"',
		'use the writeFile tool to append "{t}"',
		'don\'t use an edit plan — just writeFile "{t}" at the end',
		'invoke writeFile and add "{t}" to the bottom',
	]
	for _ in range(400):
		path, body = sample_file(rng)
		if path.endswith((".ts", ".py", ".js", ".go", ".rs", ".css", ".html")):
			# Prefer md/json for append token clarity sometimes
			if rng.random() < 0.4:
				path, body = "NOTES.md", rng.choice(NOTES_BODIES)
		body = ensure_nl(body)
		token = rng.choice(TOKENS)
		req = rng.choice(prefer_phrases).format(t=token)
		asst = (
			"I'll propose an edit plan for Apply instead of calling writeFile directly.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": append_token(body, token),
					"reason": "Prefer frame-edit-plan for user-reviewed applies.",
				}],
			)
		)
		assert "```frame-tool" not in asst or "writeFile" not in asst.split("```frame-edit-plan")[0]
		rows.append(chat(active_block(path, body, req), asst, source=src))

	# --- Clarify when path missing ---
	ambiguous = [
		"add hello to the end of the file",
		"fix it",
		"change that",
		"update the config",
		"delete the temp file",
		"append ready",
		"put ok at the bottom",
		"rename the util file",
		"add a temperature field",
		"toggle enabled",
		"prepend done to the first line",
		"create the helper",
	]
	clarifications = [
		"Which file? Tell me the path, or focus a file in the editor so I can use the active file.",
		"I need a path (or an active file) before I can propose an edit.",
		"Ambiguous — tell me the file path and the exact change you want.",
		"No active file in context. Give me a workspace-relative path to edit.",
	]
	for req in ambiguous:
		for asst in clarifications:
			rows.append(chat(req, asst, source=src))
		# paraphrase variants
		for _ in range(6):
			rows.append(chat(req + rng.choice(["", " please", " now", " thanks"]), rng.choice(clarifications), source=src))

	# --- Add sibling function / comment / import on realistic TS bodies ---
	for _ in range(350):
		body = ts_module(rng)
		path = rng.choice(["src/math.ts", "src/helpers.ts", "src/lib.ts", "src/utils.ts"])
		kind = rng.choice(["sibling", "comment", "import"])
		if kind == "sibling":
			extra = "\nexport function sub(a: number, b: number): number {\n\treturn a - b;\n}\n"
			new_body = ensure_nl(body) + extra.lstrip("\n") if not body.endswith("\n") else body + extra.lstrip("\n")
			# cleaner: ensure body ends with nl then append
			new_body = ensure_nl(body) + "export function sub(a: number, b: number): number {\n\treturn a - b;\n}\n"
			req = rng.choice([
				"also add a sub(a, b) function in the same file",
				"add typed sub(a: number, b: number): number below",
				"append a sub helper next to the existing exports",
			])
			reason = "Preserve existing exports; append sub()."
		elif kind == "comment":
			new_body = "/** Local helpers. */\n" + body
			req = rng.choice([
				"add a one-line file comment at the top",
				"add a short JSDoc banner at the top of the file",
			])
			reason = "Comment only; logic unchanged."
		else:
			new_body = "import { clamp } from './math.ts';\n\n" + body
			req = rng.choice([
				"import clamp from ./math.ts at the top",
				"add import { clamp } from './math.ts' at the top",
			])
			reason = "Add import; keep rest."
		asst = (
			f"Updating `{path}`.\n\n"
			+ edit_plan(
				f"Update {path}.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": reason,
				}],
			)
		)
		rows.append(chat(active_block(path, body, req), asst, source=src))

	# --- Surgical phrase replace / CSS / HTML / changelog ---
	for _ in range(200):
		path = "docs/guide.md"
		body = md_readme(rng)
		# Find a word to replace if possible
		words = [w for w in body.replace("\n", " ").split() if len(w) > 3 and w.isalpha()]
		if not words:
			continue
		old = rng.choice(words)
		new = rng.choice(["Frame", "local", "reviewable", "typed", "Apply"])
		if old == new:
			continue
		new_body = body.replace(old, new)
		req = f'change "{old}" to "{new}" — nothing else'
		asst = (
			"Replacing that phrase only.\n\n"
			+ edit_plan(
				f'Replace "{old}" with "{new}".',
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Surgical text replace; keep structure.",
				}],
			)
		)
		rows.append(chat(active_block(path, body, req), asst, source=src))

	for _ in range(80):
		path = "styles/app.css"
		body = css_snippet(rng)
		if "--accent" in body:
			continue
		new_body = body.replace(
			"  --fg: #eee;\n}",
			"  --fg: #eee;\n  --accent: #3d8bfd;\n}",
		)
		req = "add --accent: #3d8bfd to :root"
		asst = (
			"Adding the accent token.\n\n"
			+ edit_plan(
				"Add --accent CSS variable.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Additive CSS variable.",
				}],
			)
		)
		rows.append(chat(active_block(path, body, req), asst, source=src))

	for _ in range(60):
		path = "index.html"
		body = html_page(rng)
		new_body = body.replace("<title>Frame</title>", "<title>Frame IDE</title>")
		req = "set the document title to Frame IDE"
		asst = (
			"Updating the title.\n\n"
			+ edit_plan(
				"Set <title> to Frame IDE.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new_body,
					"reason": "Title only.",
				}],
			)
		)
		rows.append(chat(active_block(path, body, req), asst, source=src))

	# --- Tool-only (no invent) ---
	tool_only = [
		("where are TODOs in this workspace?", "grepWorkspace", {"pattern": "TODO", "limit": 40}, "Searching for TODO."),
		("find where FrameChatAgent is defined", "findSymbol", {"name": "FrameChatAgent", "limit": 20}, "Looking up `FrameChatAgent`."),
		("what's my git status?", "gitStatus", {}, "Checking git status."),
		("list files in tools/frame-model-worker", "listFiles", {"path": "tools/frame-model-worker", "limit": 100}, "Listing that directory."),
		("search the workspace for frame-edit-plan", "grepWorkspace", {"pattern": "frame-edit-plan", "limit": 40}, "Searching for frame-edit-plan."),
		("find references to synthesizeRecoveredEditPlan", "findReferences", {"name": "synthesizeRecoveredEditPlan", "limit": 20}, "Finding references."),
		("show git diff for NOTES.md", "gitDiff", {"path": "NOTES.md"}, "Checking git diff."),
		("rewrite the entire FRAME_AI_ARCHITECTURE.md from memory", "readFile", {"path": "FRAME_AI_ARCHITECTURE.md", "maxBytes": 50000}, "I should not invent that document. I'll read it first."),
	]
	for user, name, args, lead in tool_only:
		for _ in range(15):
			asst = f"{lead}\n\n" + tool_call(name, args)
			rows.append(chat(user, asst, source=src))

	# --- QA (no fences) ---
	qa = [
		("does Frame upload my code to the cloud?", "No. Frame is local-first: inference and tools stay on your machine when you use a local model."),
		("how do I apply an edit you propose?", "Review the diff in chat, then click Apply. Until you apply, nothing is written to disk."),
		("what is a frame-edit-plan?", "A fenced JSON block with summary + operations (create/modify/delete/rename). Apply writes those ops after you review."),
		("should I use writeFile or an edit plan?", "Prefer ```frame-edit-plan``` so you can review and Apply. writeFile is permission-gated and skips that review flow."),
		("why didn't you paste the architecture doc into NOTES?", "NOTES should stay short. Tiny append/prepend requests must not dump unrelated documentation."),
	]
	for u, a in qa:
		for _ in range(20):
			rows.append(chat(u, a, source=src))

	# --- Active-file append on diverse corpus (product path) ---
	for _ in range(500):
		path, body = sample_file(rng)
		body = ensure_nl(body)
		token = rng.choice(TOKENS)
		req = rng.choice(APPEND_PHRASES).format(t=token)
		asst = (
			f"Appending `{token}` to `{path}`.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": append_token(body, token),
					"reason": "Tiny additive edit only — no unrelated documentation.",
				}],
			)
		)
		rows.append(chat(active_block(path, body, req), asst, source=src))

	rng.shuffle(rows)
	return rows


# ---------- multi-turn gold (readFile → edit) ----------

def _load_frameai_snippets(max_files: int = 80, max_bytes: int = 12_000) -> list[tuple[str, str]]:
	"""Real frameAI paths with truncated-but-real bodies."""
	if not FRAMEAI.is_dir():
		return []
	out: list[tuple[str, str]] = []
	paths = sorted(FRAMEAI.rglob("*.ts"))
	# Prefer smaller / mid-size modules for FULL newContent tractability
	scored = []
	for p in paths:
		try:
			size = p.stat().st_size
		except OSError:
			continue
		if size < 200 or size > max_bytes:
			continue
		scored.append((size, p))
	scored.sort(key=lambda x: x[0])
	for _, p in scored[:max_files]:
		rel = str(p.relative_to(ROOT.parents[1])).replace("\\", "/")
		text = p.read_text(encoding="utf-8", errors="replace")
		if not text.endswith("\n"):
			text += "\n"
		out.append((rel, text))
	return out


def gen_multiturn_gold(rng: random.Random) -> list[dict]:
	rows: list[dict] = []
	src = "frame-multiturn-gold"
	snippets = _load_frameai_snippets()

	# Real frameAI: read → append trailing comment
	comment_tokens = ["pass", "note", "ready", "ok", "wip", "local", "frame", "stable", "v1", "checked"]
	for path, content in snippets:
		for token in comment_tokens[:4]:  # 4 variants per file
			comment = f"// {token}"
			t1 = rng.choice([
				f'append "{token}" as a trailing comment to {path}',
				f'add a trailing `// {token}` comment at the end of {path}',
				f'read {path} and append // {token} at the bottom',
			])
			a1 = (
				f"Reading `{path}` first.\n\n"
				+ tool_call("readFile", {"path": path, "maxBytes": 20000})
			)
			tool_result = {
				"success": True,
				"data": {"path": path, "content": content, "truncated": False},
			}
			t2 = (
				"Tool result for readFile:\n"
				+ json.dumps(tool_result, indent=2)
				+ "\n\nContinue. Emit another frame-tool only if still needed; otherwise finish with frame-edit-plan."
			)
			new_content = content if content.endswith("\n") else content + "\n"
			new_content = new_content + f"{comment}\n"
			a2 = (
				f"Appending `{comment}`.\n\n"
				+ edit_plan(
					f"Append comment to {path}",
					[{
						"kind": "modify",
						"path": path,
						"newContent": new_content,
						"reason": "Additive comment after read.",
					}],
				)
			)
			rows.append(multi_turn([(t1, a1), (t2, a2)], source=src))

	# Synthetic paths: read → append token
	synth_files = [
		("docs/guide.md", "# Guide\n\nSetup steps.\n"),
		("NOTES.md", "Project notes\nKeep this file short.\n"),
		("README.md", "# Frame\n\nLocal-first IDE.\n"),
		("src/math.ts", "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"),
		("src/utils.py", "def add(a: int, b: int) -> int:\n    return a + b\n"),
		(".frame/config/runtime.json", '{\n  "runtime": "llamacpp",\n  "enabled": false\n}\n'),
		("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- chat apply UI\n"),
		("config.json", '{\n  "enabled": true,\n  "maxTokens": 1024\n}\n'),
	]
	for path, content in synth_files:
		for token in TOKENS:
			for phrase in APPEND_PHRASES[:6]:
				req = phrase.format(t=token).replace("the file", path).replace("this document", path)
				# Ensure path is mentioned when not active
				if path not in req:
					req = f'{req.rstrip(".")} in {path}'
				a1 = (
					f"I need the current contents of `{path}` before editing.\n\n"
					+ tool_call("readFile", {"path": path, "maxBytes": 20000})
				)
				# Single-turn read-first variant
				rows.append(chat(req, a1, source=src))

				t2 = (
					"Tool result for readFile:\n"
					+ json.dumps(
						{"success": True, "data": {"path": path, "content": content, "truncated": False}},
						indent=2,
					)
					+ "\n\nContinue. Emit another frame-tool only if still needed; otherwise finish with frame-edit-plan."
				)
				a2 = (
					f"Appending `{token}`.\n\n"
					+ edit_plan(
						f'Append "{token}" to {path}.',
						[{
							"kind": "modify",
							"path": path,
							"newContent": append_token(content, token),
							"reason": "Append after reading file.",
						}],
					)
				)
				rows.append(multi_turn([(req, a1), (t2, a2)], source=src))

	# JSON toggle multi-turn
	for _ in range(120):
		path = ".frame/config/runtime.json"
		content = '{\n  "runtime": "llamacpp",\n  "enabled": false,\n  "maxTokens": 1024\n}\n'
		after = '{\n  "runtime": "llamacpp",\n  "enabled": true,\n  "maxTokens": 1024\n}\n'
		req = rng.choice([
			f"set enabled to true in {path}",
			f"enable the runtime in {path}",
			f"flip enabled to true for {path}",
		])
		a1 = f"Reading `{path}` first.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
		t2 = (
			"Tool result for readFile:\n"
			+ json.dumps({"success": True, "data": {"path": path, "content": content, "truncated": False}}, indent=2)
			+ "\n\nContinue. Emit frame-edit-plan when ready."
		)
		a2 = (
			"Enabling the runtime.\n\n"
			+ edit_plan(
				"Set enabled=true in runtime.json.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": after,
					"reason": "Toggle only after read.",
				}],
			)
		)
		rows.append(multi_turn([(req, a1), (t2, a2)], source=src))

	# Tool failure — don't invent
	fail_paths = ["secret.env", "missing/nope.ts", "FRAME_PRIVATE.md", "tmp/gone.txt"]
	for p in fail_paths:
		for _ in range(25):
			a1 = f"Reading `{p}`.\n\n" + tool_call("readFile", {"path": p})
			t2 = (
				"Tool result for readFile:\n"
				+ json.dumps({"success": False, "error": f"File not found: {p}"}, indent=2)
				+ "\n\nContinue."
			)
			a2 = f"That file isn't in the workspace (`{p}` not found). Give me the correct path if it lives elsewhere."
			rows.append(multi_turn([(f"show me {p}", a1), (t2, a2)], source=src))

	# Prefer plan after user asks to writeFile without contents
	for token in TOKENS[:20]:
		path = "docs/guide.md"
		content = "# Guide\n\nSetup steps.\n"
		req = f'use writeFile to append "{token}" to {path}'
		a1 = (
			f"I'll read `{path}` first, then propose an edit plan (not writeFile).\n\n"
			+ tool_call("readFile", {"path": path, "maxBytes": 20000})
		)
		t2 = (
			"Tool result for readFile:\n"
			+ json.dumps({"success": True, "data": {"path": path, "content": content, "truncated": False}}, indent=2)
			+ "\n\nContinue."
		)
		a2 = (
			"Appending via edit plan for Apply.\n\n"
			+ edit_plan(
				f'Append "{token}" to {path}.',
				[{
					"kind": "modify",
					"path": path,
					"newContent": append_token(content, token),
					"reason": "Prefer frame-edit-plan over writeFile.",
				}],
			)
		)
		rows.append(multi_turn([(req, a1), (t2, a2)], source=src))

	# Python create via multi-turn? Not needed — keep create single-turn.
	# Add sibling fn after read on synth TS
	for _ in range(100):
		path = "src/math.ts"
		content = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"
		req = f"add a typed sub(a, b) to {path}"
		a1 = f"Reading `{path}` first.\n\n" + tool_call("readFile", {"path": path, "maxBytes": 20000})
		t2 = (
			"Tool result for readFile:\n"
			+ json.dumps({"success": True, "data": {"path": path, "content": content, "truncated": False}}, indent=2)
			+ "\n\nContinue."
		)
		new = content + "\nexport function sub(a: number, b: number): number {\n\treturn a - b;\n}\n"
		a2 = (
			"Adding `sub` next to `add`.\n\n"
			+ edit_plan(
				"Add sub() to src/math.ts.",
				[{
					"kind": "modify",
					"path": path,
					"newContent": new,
					"reason": "Preserve existing add(); append sub() after read.",
				}],
			)
		)
		rows.append(multi_turn([(req, a1), (t2, a2)], source=src))

	rng.shuffle(rows)
	return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for row in rows:
			f.write(json.dumps(row, ensure_ascii=False) + "\n")


def audit_sample(rows: list[dict], rng: random.Random, n: int = 100) -> dict:
	sample = rng.sample(rows, min(n, len(rows)))
	issues = []
	for row in sample:
		asst = next(m["content"] for m in reversed(row["messages"]) if m["role"] == "assistant")
		if "```frame-edit-plan" in asst:
			m = __import__("re").search(r"```frame-edit-plan\s*\n([\s\S]*?)```", asst)
			if not m:
				issues.append("unclosed edit-plan")
				continue
			try:
				payload = json.loads(m.group(1))
			except json.JSONDecodeError:
				issues.append("bad edit-plan json")
				continue
			for op in payload.get("operations", []):
				if op.get("kind") in ("modify", "create"):
					key = "newContent" if op["kind"] == "modify" else "content"
					if key not in op or not isinstance(op[key], str):
						issues.append(f"missing {key}")
				# Anti-dump: NOTES modify must not contain architecture
				if op.get("path") == "NOTES.md" and op.get("kind") == "modify":
					nc = op.get("newContent", "")
					if "FRAME_AI_ARCHITECTURE" in nc or len(nc) > 2000:
						issues.append("NOTES dump")
		if "FRAME_AI_ARCHITECTURE" in asst and "```frame-edit-plan" in asst and "never dump" not in asst.lower():
			# Allow reason text mentioning never dump; flag dumps in newContent already above
			pass
	return {"sample": len(sample), "issues": issues[:20], "issue_count": len(issues)}


def main() -> None:
	rng = random.Random(42)
	print("Generating recovery_gold_b…", flush=True)
	recovery = gen_recovery_gold_b(rng)
	print(f"  {len(recovery)} rows", flush=True)

	print("Generating frame_product_gold…", flush=True)
	product = gen_frame_product_gold(rng)
	print(f"  {len(product)} rows", flush=True)

	print("Generating multiturn_gold…", flush=True)
	multiturn = gen_multiturn_gold(rng)
	print(f"  {len(multiturn)} rows", flush=True)

	paths = {
		"recovery_gold_b.jsonl": recovery,
		"frame_product_gold.jsonl": product,
		"multiturn_gold.jsonl": multiturn,
	}
	for name, rows in paths.items():
		write_jsonl(RAW / name, rows)

	audits = {name: audit_sample(rows, rng) for name, rows in paths.items()}
	counts = {name: len(rows) for name, rows in paths.items()}
	total = sum(counts.values())

	LOGS.mkdir(parents=True, exist_ok=True)
	stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
	block = (
		f"\n## Product gold expansion {stamp}\n"
		f"- recovery_gold_b.jsonl: {counts['recovery_gold_b.jsonl']}\n"
		f"- frame_product_gold.jsonl: {counts['frame_product_gold.jsonl']}\n"
		f"- multiturn_gold.jsonl: {counts['multiturn_gold.jsonl']}\n"
		f"- **new gold total: {total}**\n"
		f"- behaviors: append/prepend, edit-plan full newContent, readFile→edit, typed creates,\n"
		f"  clarify missing path, prefer plan over writeFile, delete/rename, JSON toggles, anti-dump\n"
		f"- audit: {json.dumps(audits)}\n"
	)
	campaign = LOGS / "campaign.md"
	with campaign.open("a", encoding="utf-8") as f:
		f.write(block)

	print(json.dumps({"counts": counts, "total": total, "audits": audits}, indent=2))
	if any(a["issue_count"] for a in audits.values()):
		print("WARNING: audit issues found", file=sys.stderr)
		sys.exit(1)


if __name__ == "__main__":
	main()
