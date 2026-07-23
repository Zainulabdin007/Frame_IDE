#!/usr/bin/env python3
"""Hand-authored gold examples — every row is intentional, not a template clone."""

from __future__ import annotations

import json
from typing import Any

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When you need workspace info, emit one ```frame-tool fence, then wait.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation. Never invent tool results.
Operation kinds: create {path,content}, modify {path,newContent}, delete {path}, rename {fromPath,toPath}."""


def _chat(user: str, assistant: str) -> dict[str, Any]:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": "frame-gold", "quality": "gold"},
	}


def _mt(turns: list[tuple[str, str]]) -> dict[str, Any]:
	msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
	for u, a in turns:
		msgs.append({"role": "user", "content": u})
		msgs.append({"role": "assistant", "content": a})
	return {"messages": msgs, "meta": {"source": "frame-gold-mt", "quality": "gold"}}


def _plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def _tool(name: str, arguments: dict) -> str:
	return "```frame-tool\n" + json.dumps({"name": name, "arguments": arguments}, indent=2) + "\n```"


def gold_examples() -> list[dict[str, Any]]:
	rows: list[dict[str, Any]] = []

	# --- Exact failure modes from Frame product use ---

	notes = "Project notes\nKeep this file short.\n"
	rows.append(
		_chat(
			f"Active file: NOTES.md\nActive file contents:\n```\n{notes}```\n\n"
			'User request:\nadd "works" at the end of the file now',
			"Appending `works` to `NOTES.md`.\n\n"
			+ _plan(
				'Append "works" to NOTES.md.',
				[
					{
						"kind": "modify",
						"path": "NOTES.md",
						"newContent": notes + "works\n",
						"reason": "User asked to append a single token; do not rewrite or dump docs.",
					}
				],
			),
		)
	)

	readme = "# Frame\n\nLocal-first IDE.\n"
	rows.append(
		_chat(
			f"Active file: README.md\nActive file contents:\n```\n{readme}```\n\n"
			'User request:\nadd a word "done" in front of the 1st line in the doc',
			"Prepending `done` to the first line.\n\n"
			+ _plan(
				'Prepend "done" to the first line of README.md.',
				[
					{
						"kind": "modify",
						"path": "README.md",
						"newContent": "done # Frame\n\nLocal-first IDE.\n",
						"reason": "Only change the first line; leave the rest intact.",
					}
				],
			),
		)
	)

	# Anti-dump: user asks tiny edit; correct answer is tiny plan (not architecture essay)
	rows.append(
		_chat(
			f"Active file: NOTES.md\nActive file contents:\n```\n{notes}```\n\n"
			"User request:\njust put OK on a new line at the bottom",
			"Adding `OK` at the bottom.\n\n"
			+ _plan(
				"Append OK to NOTES.md.",
				[
					{
						"kind": "modify",
						"path": "NOTES.md",
						"newContent": notes + "OK\n",
						"reason": "Additive one-line change only.",
					}
				],
			),
		)
	)

	# Create typed function
	rows.append(
		_chat(
			"create src/add.ts with a TypeScript function add(a: number, b: number): number",
			"Creating `src/add.ts`.\n\n"
			+ _plan(
				"Create typed add() in src/add.ts.",
				[
					{
						"kind": "create",
						"path": "src/add.ts",
						"content": "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
						"reason": "User requested a basic typed helper.",
					}
				],
			),
		)
	)

	# Fix off-by-one
	buggy = (
		"export function average(nums: number[]): number {\n"
		"\tlet sum = 0;\n"
		"\tfor (let i = 0; i <= nums.length; i++) {\n"
		"\t\tsum += nums[i]!;\n"
		"\t}\n"
		"\treturn sum / nums.length;\n"
		"}\n"
	)
	fixed = (
		"export function average(nums: number[]): number {\n"
		"\tif (nums.length === 0) {\n"
		"\t\tthrow new Error('average() requires a non-empty array');\n"
		"\t}\n"
		"\tlet sum = 0;\n"
		"\tfor (let i = 0; i < nums.length; i++) {\n"
		"\t\tsum += nums[i]!;\n"
		"\t}\n"
		"\treturn sum / nums.length;\n"
		"}\n"
	)
	rows.append(
		_chat(
			f"Active file: src/average.ts\nActive file contents:\n```\n{buggy}```\n\n"
			"User request:\nfix the off-by-one in the loop and guard empty arrays",
			"Fixing the loop bound and empty-array case.\n\n"
			+ _plan(
				"Fix average() off-by-one and empty input.",
				[
					{
						"kind": "modify",
						"path": "src/average.ts",
						"newContent": fixed,
						"reason": "i < length; throw on empty.",
					}
				],
			),
		)
	)

	# Insert after a specific line
	cfg = '{\n  "enabled": true,\n  "maxTokens": 1024\n}\n'
	cfg2 = '{\n  "enabled": true,\n  "maxTokens": 1024,\n  "temperature": 0.2\n}\n'
	rows.append(
		_chat(
			f"Active file: config.json\nActive file contents:\n```\n{cfg}```\n\n"
			'User request:\nadd "temperature": 0.2 to this config',
			"Adding `temperature` to `config.json`.\n\n"
			+ _plan(
				"Add temperature to config.json.",
				[
					{
						"kind": "modify",
						"path": "config.json",
						"newContent": cfg2,
						"reason": "Valid JSON with the new field.",
					}
				],
			),
		)
	)

	# Delete file
	rows.append(
		_chat(
			"delete the file tmp/scratch.txt",
			"Removing `tmp/scratch.txt`.\n\n"
			+ _plan(
				"Delete tmp/scratch.txt.",
				[{"kind": "delete", "path": "tmp/scratch.txt", "reason": "User asked to delete it."}],
			),
		)
	)

	# Rename
	rows.append(
		_chat(
			"rename src/util.ts to src/utils.ts",
			"Renaming the file.\n\n"
			+ _plan(
				"Rename util.ts → utils.ts.",
				[
					{
						"kind": "rename",
						"fromPath": "src/util.ts",
						"toPath": "src/utils.ts",
						"reason": "User requested rename.",
					}
				],
			),
		)
	)

	# Selection-aware edit
	rows.append(
		_chat(
			"Active file: src/math.ts\n"
			"Selection:\n```\nreturn a + b;\n```\n"
			"Active file contents:\n```\n"
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"
			"```\n\n"
			"User request:\nchange the selected return to return a + b + 1",
			"Updating the selected return expression.\n\n"
			+ _plan(
				"Increment add() return by 1.",
				[
					{
						"kind": "modify",
						"path": "src/math.ts",
						"newContent": "export function add(a: number, b: number): number {\n\treturn a + b + 1;\n}\n",
						"reason": "User asked to change the selected line.",
					}
				],
			),
		)
	)

	# Must use tool — no file contents provided
	rows.append(
		_chat(
			'append "ready" to docs/guide.md',
			"I need the current contents of `docs/guide.md` before editing.\n\n"
			+ _tool("readFile", {"path": "docs/guide.md", "maxBytes": 20000}),
		)
	)

	rows.append(
		_mt(
			[
				(
					'append "ready" to docs/guide.md',
					"Reading `docs/guide.md` first.\n\n"
					+ _tool("readFile", {"path": "docs/guide.md", "maxBytes": 20000}),
				),
				(
					"Tool result for readFile:\n"
					+ json.dumps(
						{
							"success": True,
							"data": {"path": "docs/guide.md", "content": "# Guide\n\nSetup steps.\n", "truncated": False},
						},
						indent=2,
					)
					+ "\n\nContinue. Emit another frame-tool only if still needed; otherwise finish with frame-edit-plan.",
					"Appending `ready`.\n\n"
					+ _plan(
						'Append "ready" to docs/guide.md.',
						[
							{
								"kind": "modify",
								"path": "docs/guide.md",
								"newContent": "# Guide\n\nSetup steps.\nready\n",
								"reason": "Append after reading file.",
							}
						],
					),
				),
			]
		)
	)

	# Grep then answer (no edit)
	rows.append(
		_chat(
			"where are TODOs in this workspace?",
			"Searching for TODO.\n\n" + _tool("grepWorkspace", {"pattern": "TODO", "limit": 40}),
		)
	)

	# Standards refactor
	messy = "export function Foo(X,Y){return X+Y}\n"
	clean = "export function add(x: number, y: number): number {\n\treturn x + y;\n}\n"
	rows.append(
		_chat(
			f"Active file: src/format.ts\nActive file contents:\n```\n{messy}```\n\n"
			"User request:\nmake this idiomatic typed TypeScript",
			"Refactoring to a typed `add` helper.\n\n"
			+ _plan(
				"Refactor Foo into typed add().",
				[
					{
						"kind": "modify",
						"path": "src/format.ts",
						"newContent": clean,
						"reason": "Clear name, types, formatting.",
					}
				],
			),
		)
	)

	# Python create with typing
	rows.append(
		_chat(
			"write src/clamp.py with clamp(n, lo, hi) and type hints",
			"Creating `src/clamp.py`.\n\n"
			+ _plan(
				"Create clamp() with type hints.",
				[
					{
						"kind": "create",
						"path": "src/clamp.py",
						"content": "def clamp(n: float, lo: float, hi: float) -> float:\n    return max(lo, min(hi, n))\n",
						"reason": "Basic typed helper as requested.",
					}
				],
			),
		)
	)

	# Add a second function to existing file (preserve rest)
	math = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"
	math2 = (
		math
		+ "\nexport function sub(a: number, b: number): number {\n\treturn a - b;\n}\n"
	)
	rows.append(
		_chat(
			f"Active file: src/math.ts\nActive file contents:\n```\n{math}```\n\n"
			"User request:\nalso add a sub(a, b) function in the same file",
			"Adding `sub` next to `add`.\n\n"
			+ _plan(
				"Add sub() to src/math.ts.",
				[
					{
						"kind": "modify",
						"path": "src/math.ts",
						"newContent": math2,
						"reason": "Preserve existing add(); append sub().",
					}
				],
			),
		)
	)

	# Comment-only change
	rows.append(
		_chat(
			f"Active file: src/math.ts\nActive file contents:\n```\n{math}```\n\n"
			"User request:\nadd a one-line comment above add explaining it sums two numbers",
			"Adding a short comment.\n\n"
			+ _plan(
				"Document add().",
				[
					{
						"kind": "modify",
						"path": "src/math.ts",
						"newContent": "/** Sums two numbers. */\n" + math,
						"reason": "Comment only; logic unchanged.",
					}
				],
			),
		)
	)

	# Q&A — no fences
	rows.append(
		_chat(
			"does Frame upload my code to the cloud?",
			"No. Frame is local-first: inference and tools stay on your machine when you use a local model.",
		)
	)
	rows.append(
		_chat(
			"how do I apply an edit you propose?",
			"Review the diff in chat, then click Apply. Until you apply, nothing is written to disk.",
		)
	)

	# Refuse inventing file contents
	rows.append(
		_chat(
			"rewrite the entire FRAME_AI_ARCHITECTURE.md from memory",
			"I should not invent that document. I'll read it first.\n\n"
			+ _tool("readFile", {"path": "FRAME_AI_ARCHITECTURE.md", "maxBytes": 50000}),
		)
	)

	# Multi-file create (test + impl)
	rows.append(
		_chat(
			"create src/slug.ts and a small node:test file tests/slug.test.ts for slugify",
			"Creating the helper and a basic test.\n\n"
			+ _plan(
				"Add slugify helper and test.",
				[
					{
						"kind": "create",
						"path": "src/slug.ts",
						"content": (
							"export function slugify(text: string): string {\n"
							"\treturn text\n"
							"\t\t.toLowerCase()\n"
							"\t\t.trim()\n"
							"\t\t.replace(/[^a-z0-9]+/g, '-')\n"
							"\t\t.replace(/^-|-$/g, '');\n"
							"}\n"
						),
						"reason": "Implementation.",
					},
					{
						"kind": "create",
						"path": "tests/slug.test.ts",
						"content": (
							"import test from 'node:test';\n"
							"import assert from 'node:assert/strict';\n"
							"import { slugify } from '../src/slug.ts';\n\n"
							"test('slugify basic', () => {\n"
							"\tassert.equal(slugify('Hello World'), 'hello-world');\n"
							"});\n"
						),
						"reason": "Minimal test.",
					},
				],
			),
		)
	)

	# Replace string in markdown without nuking file
	guide = "# Guide\n\nInstall the app.\n\nThen run tests.\n"
	guide2 = "# Guide\n\nInstall Frame.\n\nThen run tests.\n"
	rows.append(
		_chat(
			f"Active file: docs/guide.md\nActive file contents:\n```\n{guide}```\n\n"
			'User request:\nchange "the app" to "Frame" — nothing else',
			"Replacing that phrase only.\n\n"
			+ _plan(
				'Replace "the app" with "Frame".',
				[
					{
						"kind": "modify",
						"path": "docs/guide.md",
						"newContent": guide2,
						"reason": "Surgical text replace; keep structure.",
					}
				],
			),
		)
	)

	# CSS variable add
	css = ":root {\n  --bg: #111;\n  --fg: #eee;\n}\n"
	css2 = ":root {\n  --bg: #111;\n  --fg: #eee;\n  --accent: #3d8bfd;\n}\n"
	rows.append(
		_chat(
			f"Active file: styles/app.css\nActive file contents:\n```\n{css}```\n\n"
			"User request:\nadd --accent: #3d8bfd to :root",
			"Adding the accent token.\n\n"
			+ _plan(
				"Add --accent CSS variable.",
				[
					{
						"kind": "modify",
						"path": "styles/app.css",
						"newContent": css2,
						"reason": "Additive CSS variable.",
					}
				],
			),
		)
	)

	# Empty file append
	rows.append(
		_chat(
			"Active file: NEW.md\nActive file contents:\n```\n```\n\n"
			'User request:\nput "# Title" as the first line',
			"Writing the heading.\n\n"
			+ _plan(
				"Create heading in NEW.md.",
				[
					{
						"kind": "modify",
						"path": "NEW.md",
						"newContent": "# Title\n",
						"reason": "File was empty.",
					}
				],
			),
		)
	)

	# findSymbol
	rows.append(
		_chat(
			"find where FrameChatAgent is defined",
			"Looking up `FrameChatAgent`.\n\n" + _tool("findSymbol", {"name": "FrameChatAgent", "limit": 20}),
		)
	)

	# gitStatus
	rows.append(
		_chat(
			"what's my git status?",
			"Checking git status.\n\n" + _tool("gitStatus", {}),
		)
	)

	# listFiles
	rows.append(
		_chat(
			"list files in tools/frame-model-worker",
			"Listing that directory.\n\n"
			+ _tool("listFiles", {"path": "tools/frame-model-worker", "limit": 100}),
		)
	)

	# Soft refuse: ambiguous which file
	rows.append(
		_chat(
			"add hello to the end of the file",
			"Which file? Tell me the path, or focus a file in the editor so I can use the active file.",
		)
	)

	# Insert import at top of TS file
	app = "export function main(): void {\n\tconsole.log('hi');\n}\n"
	app2 = "import { add } from './math.ts';\n\n" + app
	rows.append(
		_chat(
			f"Active file: src/app.ts\nActive file contents:\n```\n{app}```\n\n"
			"User request:\nimport add from ./math.ts at the top",
			"Adding the import.\n\n"
			+ _plan(
				"Import add into src/app.ts.",
				[
					{
						"kind": "modify",
						"path": "src/app.ts",
						"newContent": app2,
						"reason": "Preserve existing main(); add import only.",
					}
				],
			),
		)
	)

	# Go: add function
	go = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n'
	go2 = (
		'package main\n\nimport "fmt"\n\n'
		"func add(a, b int) int {\n\treturn a + b\n}\n\n"
		'func main() {\n\tfmt.Println(add(1, 2))\n}\n'
	)
	rows.append(
		_chat(
			f"Active file: main.go\nActive file contents:\n```\n{go}```\n\n"
			"User request:\nadd an add(a,b int) helper and print add(1,2)",
			"Adding `add` and updating `main`.\n\n"
			+ _plan(
				"Add add() and use it in main.",
				[
					{
						"kind": "modify",
						"path": "main.go",
						"newContent": go2,
						"reason": "Keep package/imports; add helper.",
					}
				],
			),
		)
	)

	# Rust similar
	rs = "fn main() {\n    println!(\"hi\");\n}\n"
	rs2 = "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    println!(\"{}\", add(1, 2));\n}\n"
	rows.append(
		_chat(
			f"Active file: main.rs\nActive file contents:\n```\n{rs}```\n\n"
			"User request:\nadd add(a,b) -> i32 and print it",
			"Adding `add` and updating `main`.\n\n"
			+ _plan(
				"Add add() in main.rs.",
				[
					{
						"kind": "modify",
						"path": "main.rs",
						"newContent": rs2,
						"reason": "Minimal Rust helper.",
					}
				],
			),
		)
	)

	# HTML title change
	html = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <title>Old</title>\n  </head>\n  <body>\n    <h1>Frame</h1>\n  </body>\n</html>\n"
	html2 = html.replace("<title>Old</title>", "<title>Frame IDE</title>")
	rows.append(
		_chat(
			f"Active file: index.html\nActive file contents:\n```\n{html}```\n\n"
			"User request:\nset the document title to Frame IDE",
			"Updating the title.\n\n"
			+ _plan(
				"Set <title> to Frame IDE.",
				[
					{
						"kind": "modify",
						"path": "index.html",
						"newContent": html2,
						"reason": "Title only.",
					}
				],
			),
		)
	)

	# Changelog append section
	cl = "# Changelog\n\n## Unreleased\n\n- chat apply UI\n"
	cl2 = "# Changelog\n\n## Unreleased\n\n- chat apply UI\n- frame-agent LoRA dataset\n"
	rows.append(
		_chat(
			f"Active file: CHANGELOG.md\nActive file contents:\n```\n{cl}```\n\n"
			"User request:\nadd a bullet under Unreleased: frame-agent LoRA dataset",
			"Adding the changelog bullet.\n\n"
			+ _plan(
				"Append Unreleased changelog item.",
				[
					{
						"kind": "modify",
						"path": "CHANGELOG.md",
						"newContent": cl2,
						"reason": "Additive changelog entry.",
					}
				],
			),
		)
	)

	# Dual modify: enable flag in JSON
	rt = '{\n  "runtime": "llamacpp",\n  "enabled": false\n}\n'
	rt2 = '{\n  "runtime": "llamacpp",\n  "enabled": true\n}\n'
	rows.append(
		_chat(
			f"Active file: .frame/config/runtime.json\nActive file contents:\n```\n{rt}```\n\n"
			"User request:\nset enabled to true",
			"Enabling the runtime.\n\n"
			+ _plan(
				"Set enabled=true in runtime.json.",
				[
					{
						"kind": "modify",
						"path": ".frame/config/runtime.json",
						"newContent": rt2,
						"reason": "Toggle only.",
					}
				],
			),
		)
	)

	# After tool failure — don't invent
	rows.append(
		_mt(
			[
				(
					"show me secret.env",
					"Reading `secret.env`.\n\n" + _tool("readFile", {"path": "secret.env"}),
				),
				(
					"Tool result for readFile:\n"
					+ json.dumps({"success": False, "error": "File not found: secret.env"}, indent=2)
					+ "\n\nContinue.",
					"That file isn't in the workspace (`secret.env` not found). Give me the correct path if it lives elsewhere.",
				),
			]
		)
	)

	# WriteFile tool is permission-gated — prefer edit plan
	rows.append(
		_chat(
			"Active file: NOTES.md\nActive file contents:\n```\nhi\n```\n\n"
			'User request:\nuse tools to write "bye" at the end',
			"I'll propose an edit plan (Apply applies it) rather than calling writeFile directly.\n\n"
			+ _plan(
				'Append "bye" to NOTES.md.',
				[
					{
						"kind": "modify",
						"path": "NOTES.md",
						"newContent": "hi\nbye\n",
						"reason": "Prefer frame-edit-plan for user-visible apply.",
					}
				],
			),
		)
	)

	# Deduplicate / expand gold by slight paraphrases of critical behaviors
	for token in ["pass", "alpha", "stable", "v1", "local"]:
		body = f"# Notes\n\nKeep short.\n"
		rows.append(
			_chat(
				f"Active file: NOTES.md\nActive file contents:\n```\n{body}```\n\n"
				f'User request:\nplease append "{token}" to the end',
				f"Appending `{token}`.\n\n"
				+ _plan(
					f'Append "{token}" to NOTES.md.',
					[
						{
							"kind": "modify",
							"path": "NOTES.md",
							"newContent": body + f"{token}\n",
							"reason": "Tiny additive edit.",
						}
					],
				),
			)
		)

	return rows
