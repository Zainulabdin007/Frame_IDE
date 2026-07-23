#!/usr/bin/env python3
"""Generate novel Frame-format gold rows unlikely to collide with existing assistants.

Writes (does not overwrite):
  data/raw/novel_bugfix_gold.jsonl
  data/raw/novel_refactor_gold.jsonl
  data/raw/novel_tests_gold.jsonl
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When you need workspace info, emit one ```frame-tool fence, then wait.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation. Never invent tool results.
Operation kinds: create {path,content}, modify {path,newContent}, delete {path}, rename {fromPath,toPath}."""

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw"

LEADINS = [
	"Applying the fix.",
	"Patching that bug.",
	"Fixing it now.",
	"Here's the corrected version.",
	"Updating the file with the fix.",
	"Guarding the edge case.",
	"Tightening the bounds check.",
	"Correcting the async path.",
	"Refactoring as requested.",
	"Extracting the helper.",
	"Renaming across the file.",
	"Adding explicit types.",
	"Splitting into modules.",
	"Creating the test coverage.",
	"Adding unit tests.",
	"Updating the suite.",
	"Wiring impl + tests.",
	"Making the config change.",
	"Adjusting the stylesheet.",
	"Touching the markup.",
]

NOUNS = [
	"ledger", "beacon", "rivet", "orchid", "canvas", "harbor", "prism", "quartz",
	"anvil", "ember", "fjord", "glyph", "helix", "ivory", "jasper", "kepler",
	"lotus", "magma", "nexus", "onyx", "pixel", "quasar", "radar", "sable",
	"tide", "umbra", "vortex", "willow", "xenon", "yarrow", "zephyr", "cobalt",
	"delta", "echo", "falcon", "grove", "horizon", "iris", "jade", "kite",
]

VERBS = [
	"normalize", "flatten", "compact", "rotate", "mirror", "clamp", "fold",
	"expand", "merge", "split", "trim", "pad", "hash", "score", "rank",
	"filter", "sample", "buffer", "debounce", "throttle", "retry", "warmup",
]

DIRS = [
	"src", "lib", "pkg", "app", "services", "modules", "core", "utils",
	"packages/runtime", "packages/ui", "internal", "cmd", "crates", "tests",
	"styles", "config", "deploy", "ops", "infra", "web", "server", "client",
]


def plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def tool(name: str, arguments: dict) -> str:
	return "```frame-tool\n" + json.dumps({"name": name, "arguments": arguments}, indent=2) + "\n```"


def chat(user: str, assistant: str, *, source: str) -> dict:
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": {"source": source, "quality": "gold"},
	}


def active(path: str, content: str, request: str) -> str:
	return (
		f"Active file: {path}\n"
		f"Active file contents:\n```\n{content}```\n\n"
		f"User request:\n{request}"
	)


def uniq(rng: random.Random, i: int) -> str:
	return f"{rng.choice(NOUNS)}_{rng.choice(VERBS)}_{i:05d}"


def path_for(rng: random.Random, i: int, ext: str, stem: str | None = None) -> str:
	d = rng.choice(DIRS)
	s = stem or uniq(rng, i)
	return f"{d}/{s}.{ext}"


def lead(rng: random.Random) -> str:
	return rng.choice(LEADINS)


# ---------- bugfix templates ----------

def bug_ts_off_by_one(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "ts", fn)
	label = rng.choice(["sum", "product", "score", "weight", "delta"])
	buggy = (
		f"export function {fn}(items: number[]): number {{\n"
		f"\tlet {label} = 0;\n"
		f"\tfor (let i = 0; i <= items.length; i++) {{\n"
		f"\t\t{label} += items[i]!;\n"
		f"\t}}\n"
		f"\treturn {label};\n"
		f"}}\n"
	)
	fixed = (
		f"export function {fn}(items: number[]): number {{\n"
		f"\tif (items.length === 0) {{\n"
		f"\t\tthrow new Error('{fn}() requires a non-empty array');\n"
		f"\t}}\n"
		f"\tlet {label} = 0;\n"
		f"\tfor (let i = 0; i < items.length; i++) {{\n"
		f"\t\t{label} += items[i]!;\n"
		f"\t}}\n"
		f"\treturn {label};\n"
		f"}}\n"
	)
	req = rng.choice([
		f"fix the off-by-one in {fn} and reject empty arrays",
		f"{fn} indexes past the end — use i < length and guard empty input",
		f"loop bound is wrong in {fn}; also throw on []",
	])
	asst = (
		f"{lead(rng)} `{path}`.\n\n"
		+ plan(
			f"Fix off-by-one and empty guard in {fn}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": f"i < length; throw on empty ({label})."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_ts_null(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "ts", fn)
	field = rng.choice(["name", "title", "label", "slug", "email"])
	buggy = (
		f"export type Row_{i} = {{ {field}?: string | null }};\n\n"
		f"export function {fn}(row: Row_{i}): string {{\n"
		f"\treturn row.{field}.trim().toLowerCase();\n"
		f"}}\n"
	)
	fixed = (
		f"export type Row_{i} = {{ {field}?: string | null }};\n\n"
		f"export function {fn}(row: Row_{i}): string {{\n"
		f"\tconst value = row.{field};\n"
		f"\tif (value == null || value.trim() === '') {{\n"
		f"\t\tthrow new Error('{fn}: missing {field}');\n"
		f"\t}}\n"
		f"\treturn value.trim().toLowerCase();\n"
		f"}}\n"
	)
	req = rng.choice([
		f"null-check row.{field} before trim in {fn}",
		f"{fn} crashes on null/undefined {field} — guard it",
		f"add a nullish guard for {field} in {fn}",
	])
	asst = (
		f"{lead(rng)} null guard on `{path}`.\n\n"
		+ plan(
			f"Null-check {field} in {fn}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": f"Avoid calling trim on nullish {field}."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_ts_async(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "ts", fn)
	res = rng.choice(["User", "Order", "Session", "Ticket", "Device"])
	buggy = (
		f"export async function fetch{res}_{i}(id: string): Promise<{res}> {{\n"
		f"\tconst res = fetch(`/api/{res.lower()}/` + id);\n"
		f"\tconst data = res.json();\n"
		f"\treturn data as {res};\n"
		f"}}\n\n"
		f"export type {res} = {{ id: string; ok: boolean }};\n"
	)
	fixed = (
		f"export type {res} = {{ id: string; ok: boolean }};\n\n"
		f"export async function fetch{res}_{i}(id: string): Promise<{res}> {{\n"
		f"\tconst res = await fetch(`/api/{res.lower()}/` + id);\n"
		f"\tif (!res.ok) {{\n"
		f"\t\tthrow new Error(`fetch{res}_{i} failed: ${{res.status}}`);\n"
		f"\t}}\n"
		f"\treturn (await res.json()) as {res};\n"
		f"}}\n"
	)
	req = rng.choice([
		f"await fetch and json() in fetch{res}_{i}; check res.ok",
		f"missing await — fix the async path in fetch{res}_{i}",
		f"fetch{res}_{i} returns a Promise of a Promise; await properly and throw on !ok",
	])
	asst = (
		f"{lead(rng)} async/await on `{path}`.\n\n"
		+ plan(
			f"Await fetch/json and check status in fetch{res}_{i}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "Missing await caused races/wrong types."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_js_race_comment(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "js", fn)
	buggy = (
		f"let busy_{i} = false;\n\n"
		f"export async function {fn}(task) {{\n"
		f"  if (busy_{i}) return;\n"
		f"  busy_{i} = true;\n"
		f"  await task();\n"
		f"  busy_{i} = false;\n"
		f"}}\n"
	)
	fixed = (
		f"let busy_{i} = false;\n\n"
		f"/**\n"
		f" * Single-flight gate for {fn}. Not a mutex across workers — only\n"
		f" * prevents overlapping calls in this JS realm. Clears the flag in\n"
		f" * finally so a rejected task cannot leave busy_{i} stuck true.\n"
		f" */\n"
		f"export async function {fn}(task) {{\n"
		f"  if (busy_{i}) return;\n"
		f"  busy_{i} = true;\n"
		f"  try {{\n"
		f"    await task();\n"
		f"  }} finally {{\n"
		f"    busy_{i} = false;\n"
		f"  }}\n"
		f"}}\n"
	)
	req = rng.choice([
		f"if {fn} throws, busy_{i} stays true forever — use try/finally and document the race limit",
		f"fix the stuck lock in {fn}; add a comment that this is single-realm only",
		f"{fn} needs finally + a short race-ish comment about not being cross-worker safe",
	])
	asst = (
		f"{lead(rng)} `{path}` (finally + race note).\n\n"
		+ plan(
			f"Clear busy flag in finally for {fn}; document scope.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "Prevent stuck lock; clarify not cross-worker."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_py_off_by_one(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "py", fn)
	buggy = (
		f"def {fn}(values: list[int]) -> int:\n"
		f"    total = 0\n"
		f"    for idx in range(len(values) + 1):\n"
		f"        total += values[idx]\n"
		f"    return total\n"
	)
	fixed = (
		f"def {fn}(values: list[int]) -> int:\n"
		f"    if not values:\n"
		f"        raise ValueError(\"{fn} requires a non-empty list\")\n"
		f"    total = 0\n"
		f"    for idx in range(len(values)):\n"
		f"        total += values[idx]\n"
		f"    return total\n"
	)
	req = rng.choice([
		f"fix IndexError in {fn}: range is off-by-one; reject empty lists",
		f"{fn} uses len+1 — correct the loop and empty guard",
	])
	asst = (
		f"{lead(rng)} Python off-by-one in `{path}`.\n\n"
		+ plan(
			f"Fix range off-by-one in {fn}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "range(len); ValueError on empty."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_py_none(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "py", fn)
	key = rng.choice(["payload", "meta", "attrs", "config"])
	buggy = (
		f"def {fn}({key}: dict | None) -> str:\n"
		f"    return {key}[\"id\"].strip()\n"
	)
	fixed = (
		f"def {fn}({key}: dict | None) -> str:\n"
		f"    if {key} is None:\n"
		f"        raise ValueError(\"{fn}: {key} is None\")\n"
		f"    raw = {key}.get(\"id\")\n"
		f"    if not isinstance(raw, str) or not raw.strip():\n"
		f"        raise ValueError(\"{fn}: missing id\")\n"
		f"    return raw.strip()\n"
	)
	req = rng.choice([
		f"guard None {key} and missing id in {fn}",
		f"{fn} blows up on None — add checks",
	])
	asst = (
		f"{lead(rng)} None-safety in `{path}`.\n\n"
		+ plan(
			f"None/missing-id guards in {fn}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "Avoid TypeError on None."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_go_slice(rng: random.Random, i: int) -> dict:
	stem = uniq(rng, i).replace("-", "_")
	name = "".join(p.title() for p in stem.split("_"))
	pkg = rng.choice(["main", "ledger", "runtime", "worker"])
	path = path_for(rng, i, "go", stem)
	buggy = (
		f"package {pkg}\n\n"
		f"func {name}(xs []int) int {{\n"
		f"\tsum := 0\n"
		f"\tfor i := 0; i <= len(xs); i++ {{\n"
		f"\t\tsum += xs[i]\n"
		f"\t}}\n"
		f"\treturn sum\n"
		f"}}\n"
	)
	fixed = (
		f"package {pkg}\n\n"
		f"import \"fmt\"\n\n"
		f"func {name}(xs []int) (int, error) {{\n"
		f"\tif len(xs) == 0 {{\n"
		f"\t\treturn 0, fmt.Errorf(\"{name}: empty slice\")\n"
		f"\t}}\n"
		f"\tsum := 0\n"
		f"\tfor i := 0; i < len(xs); i++ {{\n"
		f"\t\tsum += xs[i]\n"
		f"\t}}\n"
		f"\treturn sum, nil\n"
		f"}}\n"
	)
	req = rng.choice([
		f"fix the Go slice off-by-one in {name}; return error on empty",
		f"{path} panics at i==len — bound check + empty error",
	])
	asst = (
		f"{lead(rng)} Go slice bound in `{path}`.\n\n"
		+ plan(
			f"Fix off-by-one in {name}; error on empty.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "i < len; return error."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_rust_option(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i).replace("-", "_")
	path = path_for(rng, i, "rs", fn)
	buggy = (
		f"pub fn {fn}(items: &[i32]) -> i32 {{\n"
		f"    items[0] + items[items.len()]\n"
		f"}}\n"
	)
	fixed = (
		f"pub fn {fn}(items: &[i32]) -> Result<i32, &'static str> {{\n"
		f"    let first = items.first().ok_or(\"{fn}: empty\")?;\n"
		f"    let last = items.last().ok_or(\"{fn}: empty\")?;\n"
		f"    Ok(first + last)\n"
		f"}}\n"
	)
	req = rng.choice([
		f"fix OOB in {fn}; return Result instead of panicking",
		f"{fn} indexes items[len] — use first/last Option and Result",
	])
	asst = (
		f"{lead(rng)} Rust Option/Result in `{path}`.\n\n"
		+ plan(
			f"Replace OOB indexing in {fn} with Result.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "first/last; no panic on empty."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_json_typo(rng: random.Random, i: int) -> dict:
	path = path_for(rng, i, "json", f"cfg_{uniq(rng, i)}")
	wrong_key = rng.choice(["enbled", "maxTokns", "temprature", "timeOut"])
	right_key = {"enbled": "enabled", "maxTokns": "maxTokens", "temprature": "temperature", "timeOut": "timeout"}[wrong_key]
	buggy_obj = {
		"runtime": "llamacpp",
		wrong_key: rng.choice([True, False, 0.2, 1024, 30]),
		"modelId": f"frame-coder-{i % 97}",
	}
	fixed_obj = {
		"runtime": "llamacpp",
		right_key: buggy_obj[wrong_key],
		"modelId": buggy_obj["modelId"],
		"notes": f"corrected key {wrong_key}->{right_key} (row {i})",
	}
	buggy = json.dumps(buggy_obj, indent=2) + "\n"
	fixed = json.dumps(fixed_obj, indent=2) + "\n"
	req = f'rename misspelled "{wrong_key}" to "{right_key}" and add a notes field'
	asst = (
		f"{lead(rng)} JSON key in `{path}`.\n\n"
		+ plan(
			f"Rename {wrong_key} → {right_key}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "Fix typo; keep value."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_yaml_indent(rng: random.Random, i: int) -> dict:
	svc = uniq(rng, i)
	path = path_for(rng, i, "yaml", f"deploy_{svc}")
	port = 8000 + (i % 1000)
	buggy = (
		f"service:\n"
		f"  name: {svc}\n"
		f"replicas: 2\n"
		f"  ports:\n"
		f"  - containerPort: {port}\n"
	)
	fixed = (
		f"service:\n"
		f"  name: {svc}\n"
		f"  replicas: 2\n"
		f"  ports:\n"
		f"    - containerPort: {port}\n"
		f"  env:\n"
		f"    FRAME_ROW: \"{i}\"\n"
	)
	req = f"fix YAML indentation for replicas/ports under service in {path}"
	asst = (
		f"{lead(rng)} YAML structure in `{path}`.\n\n"
		+ plan(
			f"Correct indentation for {svc} deploy.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "replicas/ports belong under service."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_css_selector(rng: random.Random, i: int) -> dict:
	cls = uniq(rng, i).replace("_", "-")
	path = path_for(rng, i, "css", f"theme_{cls}")
	buggy = (
		f".{cls} {{\n"
		f"  color: #eee;\n"
		f"  background: #111;\n"
		f"}}\n"
		f".{cls} button {{\n"
		f"  color: #eee\n"  # missing semicolon / intentional incomplete
		f"}}\n"
	)
	fixed = (
		f".{cls} {{\n"
		f"  color: #f5f5f5;\n"
		f"  background: #121212;\n"
		f"  --accent-{i % 50}: #3d8bfd;\n"
		f"}}\n"
		f".{cls} button {{\n"
		f"  color: var(--accent-{i % 50});\n"
		f"  border: 1px solid color-mix(in srgb, var(--accent-{i % 50}) 40%, transparent);\n"
		f"}}\n"
	)
	req = f"fix missing semicolon in .{cls} button and add --accent-{i % 50}"
	asst = (
		f"{lead(rng)} CSS in `{path}`.\n\n"
		+ plan(
			f"Fix .{cls} button rule; add accent token.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "Valid CSS + accent variable."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_html_a11y(rng: random.Random, i: int) -> dict:
	page = uniq(rng, i)
	path = path_for(rng, i, "html", page)
	buggy = (
		f"<!doctype html>\n<html>\n<head><title>{page}</title></head>\n"
		f"<body>\n"
		f"  <img src=\"/assets/{page}.png\">\n"
		f"  <button onclick=\"go()\">Go</button>\n"
		f"</body>\n</html>\n"
	)
	fixed = (
		f"<!doctype html>\n<html lang=\"en\">\n"
		f"<head>\n  <meta charset=\"utf-8\" />\n  <title>{page}</title>\n</head>\n"
		f"<body>\n"
		f"  <img src=\"/assets/{page}.png\" alt=\"Preview of {page} panel {i}\" />\n"
		f"  <button type=\"button\" onclick=\"go()\">Go</button>\n"
		f"</body>\n</html>\n"
	)
	req = f"add lang, charset, img alt, and type=button on {path}"
	asst = (
		f"{lead(rng)} HTML a11y on `{path}`.\n\n"
		+ plan(
			f"Accessibility fixes for {page}.",
			[{"kind": "modify", "path": path, "newContent": fixed, "reason": "lang/alt/button type."}],
		)
	)
	return chat(active(path, buggy, req), asst, source="novel-bugfix")


def bug_tool_then_fix(rng: random.Random, i: int) -> dict:
	"""frame-tool row — ask to fix without contents."""
	fn = uniq(rng, i)
	path = path_for(rng, i, "ts", fn)
	req = rng.choice([
		f"fix the off-by-one in {path}",
		f"null-check the helper in {path}",
		f"await the fetch in {path}",
	])
	asst = (
		f"I need the current contents of `{path}` before editing.\n\n"
		+ tool("readFile", {"path": path, "maxBytes": 20000 + (i % 500)})
	)
	return chat(req, asst, source="novel-bugfix-tool")


BUG_BUILDERS = [
	bug_ts_off_by_one,
	bug_ts_null,
	bug_ts_async,
	bug_js_race_comment,
	bug_py_off_by_one,
	bug_py_none,
	bug_go_slice,
	bug_rust_option,
	bug_json_typo,
	bug_yaml_indent,
	bug_css_selector,
	bug_html_a11y,
	bug_tool_then_fix,
]


# ---------- refactor templates ----------

def ref_extract_fn(rng: random.Random, i: int) -> dict:
	outer = uniq(rng, i)
	inner = f"format_{rng.choice(NOUNS)}_{i}"
	path = path_for(rng, i, "ts", outer)
	before = (
		f"export function {outer}(raw: string): string {{\n"
		f"\tconst cleaned = raw.trim().toLowerCase().replace(/\\s+/g, '-');\n"
		f"\treturn `item-${{cleaned}}-{i}`;\n"
		f"}}\n"
	)
	after = (
		f"function {inner}(raw: string): string {{\n"
		f"\treturn raw.trim().toLowerCase().replace(/\\s+/g, '-');\n"
		f"}}\n\n"
		f"export function {outer}(raw: string): string {{\n"
		f"\treturn `item-${{{inner}(raw)}}-{i}`;\n"
		f"}}\n"
	)
	req = rng.choice([
		f"extract the clean/normalize logic from {outer} into {inner}",
		f"refactor {outer}: pull trim/lower/replace into helper {inner}",
	])
	asst = (
		f"{lead(rng)} extract `{inner}` in `{path}`.\n\n"
		+ plan(
			f"Extract {inner} from {outer}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Local helper; behavior unchanged."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_rename_symbol(rng: random.Random, i: int) -> dict:
	old = f"doStuff_{i}"
	new = uniq(rng, i)
	path = path_for(rng, i, "ts", f"mod_{i}")
	before = (
		f"export function {old}(n: number): number {{\n"
		f"\treturn n * {2 + (i % 7)};\n"
		f"}}\n\n"
		f"export function run_{i}(xs: number[]): number[] {{\n"
		f"\treturn xs.map({old});\n"
		f"}}\n"
	)
	after = (
		f"export function {new}(n: number): number {{\n"
		f"\treturn n * {2 + (i % 7)};\n"
		f"}}\n\n"
		f"export function run_{i}(xs: number[]): number[] {{\n"
		f"\treturn xs.map({new});\n"
		f"}}\n"
	)
	req = f"rename {old} to {new} everywhere in this file"
	asst = (
		f"{lead(rng)} rename in `{path}`.\n\n"
		+ plan(
			f"Rename {old} → {new}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Symbol rename within one file."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_add_types(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	path = path_for(rng, i, "ts", fn)
	type_name = "".join(p.title() for p in fn.split("_")) + "Result"
	before = (
		f"export function {fn}(a, b) {{\n"
		f"\treturn {{ sum: a + b, id: '{fn}' }};\n"
		f"}}\n"
	)
	after = (
		f"export type {type_name} = {{ sum: number; id: string }};\n\n"
		f"export function {fn}(a: number, b: number): {type_name} {{\n"
		f"\treturn {{ sum: a + b, id: '{fn}' }};\n"
		f"}}\n"
	)
	req = rng.choice([
		f"add parameter/return types and a Result type for {fn}",
		f"make {fn} idiomatic typed TypeScript",
	])
	asst = (
		f"{lead(rng)} types on `{path}`.\n\n"
		+ plan(
			f"Add types for {fn}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Explicit types + named result."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_split_module(rng: random.Random, i: int) -> dict:
	base = uniq(rng, i)
	src = path_for(rng, i, "ts", base)
	types_path = src.replace(".ts", ".types.ts")
	util_path = src.replace(".ts", ".util.ts")
	before = (
		f"export type {base}Opts = {{ limit: number }};\n\n"
		f"export function clamp_{i}(n: number, lo: number, hi: number): number {{\n"
		f"\treturn Math.min(hi, Math.max(lo, n));\n"
		f"}}\n\n"
		f"export function run_{base}(opts: {base}Opts): number {{\n"
		f"\treturn clamp_{i}(opts.limit, 0, 100);\n"
		f"}}\n"
	)
	types_body = f"export type {base}Opts = {{ limit: number }};\n"
	util_body = (
		f"export function clamp_{i}(n: number, lo: number, hi: number): number {{\n"
		f"\treturn Math.min(hi, Math.max(lo, n));\n"
		f"}}\n"
	)
	main_body = (
		f"import type {{ {base}Opts }} from './{Path(types_path).stem}.ts';\n"
		f"import {{ clamp_{i} }} from './{Path(util_path).stem}.ts';\n\n"
		f"export function run_{base}(opts: {base}Opts): number {{\n"
		f"\treturn clamp_{i}(opts.limit, 0, 100);\n"
		f"}}\n"
	)
	req = f"split {src}: move types to {types_path} and clamp to {util_path}"
	asst = (
		f"{lead(rng)} split `{src}` into 3 files.\n\n"
		+ plan(
			f"Split {base} into types/util/main.",
			[
				{"kind": "create", "path": types_path, "content": types_body, "reason": "Extract type."},
				{"kind": "create", "path": util_path, "content": util_body, "reason": "Extract clamp helper."},
				{"kind": "modify", "path": src, "newContent": main_body, "reason": "Keep run_* importing siblings."},
			],
		)
	)
	return chat(active(src, before, req), asst, source="novel-refactor")


def ref_py_extract(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i)
	helper = f"_clean_{i}"
	path = path_for(rng, i, "py", fn)
	before = (
		f"def {fn}(text: str) -> str:\n"
		f"    return \"-\".join(text.strip().lower().split()) + \"-{i}\"\n"
	)
	after = (
		f"def {helper}(text: str) -> str:\n"
		f"    return \"-\".join(text.strip().lower().split())\n\n"
		f"def {fn}(text: str) -> str:\n"
		f"    return {helper}(text) + \"-{i}\"\n"
	)
	req = f"extract cleaning into {helper} inside {path}"
	asst = (
		f"{lead(rng)} Python extract in `{path}`.\n\n"
		+ plan(
			f"Extract {helper} from {fn}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Helper for readability."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_go_rename(rng: random.Random, i: int) -> dict:
	old = f"DoWork{i}"
	new = f"Process{rng.choice(NOUNS).title()}{i}"
	path = path_for(rng, i, "go", f"svc_{i}")
	before = (
		f"package worker\n\n"
		f"func {old}(n int) int {{\n"
		f"\treturn n + {i % 9}\n"
		f"}}\n\n"
		f"func Run{i}(xs []int) []int {{\n"
		f"\tout := make([]int, len(xs))\n"
		f"\tfor i, v := range xs {{\n"
		f"\t\tout[i] = {old}(v)\n"
		f"\t}}\n"
		f"\treturn out\n"
		f"}}\n"
	)
	after = before.replace(old, new)
	req = f"rename {old} to {new} in this Go file"
	asst = (
		f"{lead(rng)} Go rename in `{path}`.\n\n"
		+ plan(
			f"Rename {old} → {new}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Symbol rename."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_css_tokens(rng: random.Random, i: int) -> dict:
	path = path_for(rng, i, "css", f"tokens_{i}")
	before = (
		f"body {{\n"
		f"  background: #101018;\n"
		f"  color: #e8e8ef;\n"
		f"}}\n"
		f".card-{i} {{\n"
		f"  background: #101018;\n"
		f"  border: 1px solid #2a2a3a;\n"
		f"}}\n"
	)
	after = (
		f":root {{\n"
		f"  --bg-{i}: #101018;\n"
		f"  --fg-{i}: #e8e8ef;\n"
		f"  --border-{i}: #2a2a3a;\n"
		f"}}\n"
		f"body {{\n"
		f"  background: var(--bg-{i});\n"
		f"  color: var(--fg-{i});\n"
		f"}}\n"
		f".card-{i} {{\n"
		f"  background: var(--bg-{i});\n"
		f"  border: 1px solid var(--border-{i});\n"
		f"}}\n"
	)
	req = f"extract duplicated colors into CSS variables --bg-{i}/--fg-{i}/--border-{i}"
	asst = (
		f"{lead(rng)} CSS tokens in `{path}`.\n\n"
		+ plan(
			f"Introduce design tokens for card-{i}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "DRY color tokens."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_json_split(rng: random.Random, i: int) -> dict:
	base = uniq(rng, i)
	main = path_for(rng, i, "json", f"app_{base}")
	feat = main.replace(".json", ".features.json")
	before_obj = {
		"name": base,
		"version": f"1.{i % 10}.0",
		"features": {"darkMode": True, "experimental_{i}": False},
		"limits": {"maxTokens": 1024 + (i % 512)},
	}
	main_obj = {
		"name": base,
		"version": before_obj["version"],
		"limits": before_obj["limits"],
		"featuresFile": feat,
	}
	feat_obj = before_obj["features"]
	req = f"split features from {main} into {feat} and leave a featuresFile pointer"
	asst = (
		f"{lead(rng)} split JSON config.\n\n"
		+ plan(
			f"Split features out of {base} config.",
			[
				{"kind": "create", "path": feat, "content": json.dumps(feat_obj, indent=2) + "\n", "reason": "Features file."},
				{"kind": "modify", "path": main, "newContent": json.dumps(main_obj, indent=2) + "\n", "reason": "Pointer to features."},
			],
		)
	)
	return chat(active(main, json.dumps(before_obj, indent=2) + "\n", req), asst, source="novel-refactor")


def ref_yaml_rename_key(rng: random.Random, i: int) -> dict:
	path = path_for(rng, i, "yml", f"pipeline_{i}")
	before = (
		f"pipeline:\n"
		f"  job_name: build_{i}\n"
		f"  steps:\n"
		f"    - run: echo {uniq(rng, i)}\n"
	)
	after = (
		f"pipeline:\n"
		f"  name: build_{i}\n"
		f"  steps:\n"
		f"    - run: echo {uniq(rng, i)}\n"
		f"    - run: echo done-{i}\n"
	)
	req = f"rename job_name to name and append a done step in {path}"
	asst = (
		f"{lead(rng)} YAML key rename in `{path}`.\n\n"
		+ plan(
			"Rename job_name→name; append step.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Key rename + additive step."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-refactor")


def ref_html_extract_partial(rng: random.Random, i: int) -> dict:
	page = uniq(rng, i)
	main = path_for(rng, i, "html", page)
	partial = main.replace(".html", ".header.html")
	before = (
		f"<!doctype html>\n<html lang=\"en\">\n<head><title>{page}</title></head>\n"
		f"<body>\n"
		f"  <header class=\"top-{i}\"><h1>{page}</h1></header>\n"
		f"  <main>Row {i}</main>\n"
		f"</body>\n</html>\n"
	)
	partial_body = f"<header class=\"top-{i}\"><h1>{page}</h1></header>\n"
	main_after = (
		f"<!doctype html>\n<html lang=\"en\">\n<head><title>{page}</title></head>\n"
		f"<body>\n"
		f"  <!-- include: {partial} -->\n"
		f"  <main>Row {i}</main>\n"
		f"</body>\n</html>\n"
	)
	req = f"extract the header into {partial} and leave an include comment in {main}"
	asst = (
		f"{lead(rng)} HTML partial extract.\n\n"
		+ plan(
			f"Extract header partial for {page}.",
			[
				{"kind": "create", "path": partial, "content": partial_body, "reason": "Header partial."},
				{"kind": "modify", "path": main, "newContent": main_after, "reason": "Include marker; keep main."},
			],
		)
	)
	return chat(active(main, before, req), asst, source="novel-refactor")


def ref_tool(rng: random.Random, i: int) -> dict:
	path = path_for(rng, i, "ts", uniq(rng, i))
	req = f"extract a helper from {path} and rename the old export"
	asst = (
		f"Reading `{path}` first so the refactor stays surgical.\n\n"
		+ tool("readFile", {"path": path, "maxBytes": 24000 + (i % 300)})
	)
	return chat(req, asst, source="novel-refactor-tool")


REF_BUILDERS = [
	ref_extract_fn,
	ref_rename_symbol,
	ref_add_types,
	ref_split_module,
	ref_py_extract,
	ref_go_rename,
	ref_css_tokens,
	ref_json_split,
	ref_yaml_rename_key,
	ref_html_extract_partial,
	ref_tool,
]


# ---------- tests templates ----------

def test_node_create(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	impl_path = path_for(rng, i, "ts", name)
	# keep tests near root-ish for variety
	test_path = f"tests/{name}.test.ts" if rng.random() < 0.7 else f"{Path(impl_path).parent}/{name}.test.ts"
	mult = 2 + (i % 5)
	impl = (
		f"export function {name}(n: number): number {{\n"
		f"\treturn n * {mult};\n"
		f"}}\n"
	)
	test = (
		"import test from 'node:test';\n"
		"import assert from 'node:assert/strict';\n"
		f"import {{ {name} }} from '{_rel_import(test_path, impl_path)}';\n\n"
		f"test('{name} scales by {mult}', () => {{\n"
		f"\tassert.equal({name}(3), {3 * mult});\n"
		f"\tassert.equal({name}(0), 0);\n"
		f"}});\n"
	)
	req = rng.choice([
		f"create {impl_path} with {name}(n)=>n*{mult} and a node:test file at {test_path}",
		f"add {name} helper + node:test coverage ({impl_path}, {test_path})",
	])
	asst = (
		f"{lead(rng)} `{name}` + node:test.\n\n"
		+ plan(
			f"Create {name} and node:test suite.",
			[
				{"kind": "create", "path": impl_path, "content": impl, "reason": "Implementation."},
				{"kind": "create", "path": test_path, "content": test, "reason": "node:test coverage."},
			],
		)
	)
	return chat(req, asst, source="novel-tests")


def _rel_import(from_path: str, to_path: str) -> str:
	depth = from_path.count("/")
	prefix = "../" * depth if depth else "./"
	return f"{prefix}{to_path}"


def test_pytest_create(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	impl_path = path_for(rng, i, "py", name)
	test_path = f"tests/test_{name}.py"
	offset = i % 11
	impl = (
		f"def {name}(n: int) -> int:\n"
		f"    return n + {offset}\n"
	)
	mod = Path(impl_path).stem
	pkg = Path(impl_path).parts[0]
	test = (
		f"from {pkg}.{mod} import {name}\n\n"
		f"def test_{name}_basic():\n"
		f"    assert {name}(1) == {1 + offset}\n"
		f"    assert {name}(0) == {offset}\n"
	)
	req = f"create {impl_path} and pytest file {test_path} for {name}"
	asst = (
		f"{lead(rng)} pytest for `{name}`.\n\n"
		+ plan(
			f"Create {name} + pytest.",
			[
				{"kind": "create", "path": impl_path, "content": impl, "reason": "Implementation."},
				{"kind": "create", "path": test_path, "content": test, "reason": "pytest style."},
			],
		)
	)
	return chat(req, asst, source="novel-tests")


def test_update_existing(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	path = f"tests/{name}.test.ts"
	before = (
		"import test from 'node:test';\n"
		"import assert from 'node:assert/strict';\n"
		f"import {{ {name} }} from '../src/{name}.ts';\n\n"
		f"test('{name} happy path', () => {{\n"
		f"\tassert.equal({name}('a'), 'a');\n"
		f"}});\n"
	)
	after = (
		before
		+ f"\ntest('{name} empty string', () => {{\n"
		f"\tassert.equal({name}(''), '');\n"
		f"}});\n\n"
		f"test('{name} trims whitespace row {i}', () => {{\n"
		f"\tassert.equal({name}('  x  '), 'x');\n"
		f"}});\n"
	)
	req = rng.choice([
		f"add empty-string and trim cases to {path}",
		f"extend the node:test suite in {path} with two more asserts",
	])
	asst = (
		f"{lead(rng)} extend `{path}`.\n\n"
		+ plan(
			f"Add edge-case tests for {name}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Additive tests only."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-tests")


def test_pytest_update(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	path = f"tests/test_{name}.py"
	before = (
		f"from src.{name} import {name}\n\n"
		f"def test_{name}_basic():\n"
		f"    assert {name}(2) == 2\n"
	)
	after = (
		before
		+ f"\ndef test_{name}_negative():\n"
		f"    assert {name}(-3) == -3\n\n"
		f"def test_{name}_row_{i}():\n"
		f"    assert {name}({i % 17}) == {i % 17}\n"
	)
	req = f"add negative and row-specific pytest cases to {path}"
	asst = (
		f"{lead(rng)} pytest update `{path}`.\n\n"
		+ plan(
			f"Extend pytest for {name}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "More coverage."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-tests")


def test_impl_plus_fixture(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	impl = path_for(rng, i, "ts", name)
	test_path = f"tests/{name}.test.ts"
	fixture = f"tests/fixtures/{name}.json"
	type_name = "".join(p.title() for p in name.split("_"))
	body = (
		f"export type {type_name} = {{ id: string; n: number }};\n\n"
		f"export function {name}(row: {type_name}): number {{\n"
		f"\treturn row.n + {i % 4};\n"
		f"}}\n"
	)
	test_src = (
		"import test from 'node:test';\n"
		"import assert from 'node:assert/strict';\n"
		"import { readFileSync } from 'node:fs';\n"
		f"import {{ {name} }} from '../{impl}';\n\n"
		f"const fixture = JSON.parse(readFileSync(new URL('./fixtures/{name}.json', import.meta.url), 'utf8'));\n\n"
		f"test('{name} uses fixture {i}', () => {{\n"
		f"\tassert.equal({name}(fixture), fixture.n + {i % 4});\n"
		f"}});\n"
	)
	fix_json = json.dumps({"id": name, "n": 10 + (i % 20)}, indent=2) + "\n"
	req = f"create {impl}, fixture {fixture}, and node:test {test_path}"
	asst = (
		f"{lead(rng)} impl + fixture + test (3 ops).\n\n"
		+ plan(
			f"Add {name} with fixture-backed test.",
			[
				{"kind": "create", "path": impl, "content": body, "reason": "Implementation."},
				{"kind": "create", "path": fixture, "content": fix_json, "reason": "Test fixture."},
				{"kind": "create", "path": test_path, "content": test_src, "reason": "node:test + fixture."},
			],
		)
	)
	return chat(req, asst, source="novel-tests")


def test_go_table(rng: random.Random, i: int) -> dict:
	name = f"Score{rng.choice(NOUNS).title()}{i}"
	impl = path_for(rng, i, "go", f"score_{i}")
	test_path = impl.replace(".go", "_test.go")
	impl_body = (
		f"package score\n\n"
		f"func {name}(n int) int {{\n"
		f"\treturn n * {3 + (i % 4)}\n"
		f"}}\n"
	)
	test_body = (
		f"package score\n\n"
		f"import \"testing\"\n\n"
		f"func Test{name}(t *testing.T) {{\n"
		f"\tcases := []struct{{ in, want int }}{{\n"
		f"\t\t{{0, 0}}, {{1, {3 + (i % 4)}}}, {{2, {2 * (3 + (i % 4))}}},\n"
		f"\t}}\n"
		f"\tfor _, tc := range cases {{\n"
		f"\t\tif got := {name}(tc.in); got != tc.want {{\n"
		f"\t\t\tt.Fatalf(\"%d: got %d want %d\", tc.in, got, tc.want)\n"
		f"\t\t}}\n"
		f"\t}}\n"
		f"}}\n"
	)
	req = f"create {impl} with {name} and table-driven test {test_path}"
	asst = (
		f"{lead(rng)} Go table test.\n\n"
		+ plan(
			f"Add {name} + Test{name}.",
			[
				{"kind": "create", "path": impl, "content": impl_body, "reason": "Impl."},
				{"kind": "create", "path": test_path, "content": test_body, "reason": "Table-driven test."},
			],
		)
	)
	return chat(req, asst, source="novel-tests")


def test_rust_unit(rng: random.Random, i: int) -> dict:
	fn = uniq(rng, i).replace("-", "_")
	path = path_for(rng, i, "rs", fn)
	before = (
		f"pub fn {fn}(n: i32) -> i32 {{\n"
		f"    n + {i % 6}\n"
		f"}}\n"
	)
	after = (
		before
		+ f"\n#[cfg(test)]\nmod tests_{i} {{\n"
		f"    use super::*;\n\n"
		f"    #[test]\n"
		f"    fn {fn}_adds_offset() {{\n"
		f"        assert_eq!({fn}(1), {1 + (i % 6)});\n"
		f"    }}\n"
		f"}}\n"
	)
	req = f"add an inline #[cfg(test)] unit test for {fn} in {path}"
	asst = (
		f"{lead(rng)} Rust unit test in `{path}`.\n\n"
		+ plan(
			f"Add cfg(test) module for {fn}.",
			[{"kind": "modify", "path": path, "newContent": after, "reason": "Inline unit test."}],
		)
	)
	return chat(active(path, before, req), asst, source="novel-tests")


def test_config_snapshot(rng: random.Random, i: int) -> dict:
	name = uniq(rng, i)
	cfg = path_for(rng, i, "json", f"snap_{name}")
	test_path = f"tests/{name}.config.test.ts"
	obj = {"id": name, "row": i, "flags": {"a": True, "b": i % 2 == 0}}
	cfg_body = json.dumps(obj, indent=2) + "\n"
	test = (
		"import test from 'node:test';\n"
		"import assert from 'node:assert/strict';\n"
		"import { readFileSync } from 'node:fs';\n\n"
		f"test('config snapshot {name}', () => {{\n"
		f"\tconst raw = readFileSync('{cfg}', 'utf8');\n"
		f"\tconst parsed = JSON.parse(raw);\n"
		f"\tassert.equal(parsed.id, '{name}');\n"
		f"\tassert.equal(parsed.row, {i});\n"
		f"}});\n"
	)
	req = f"create config {cfg} and a node:test that snapshots its id/row"
	asst = (
		f"{lead(rng)} config + snapshot test.\n\n"
		+ plan(
			f"Add {name} config snapshot test.",
			[
				{"kind": "create", "path": cfg, "content": cfg_body, "reason": "Config fixture."},
				{"kind": "create", "path": test_path, "content": test, "reason": "Snapshot assertions."},
			],
		)
	)
	return chat(req, asst, source="novel-tests")


def test_tool(rng: random.Random, i: int) -> dict:
	path = f"tests/{uniq(rng, i)}.test.ts"
	req = f"add another assertion to {path}"
	asst = (
		f"I need the current test file before editing.\n\n"
		+ tool("readFile", {"path": path, "maxBytes": 16000 + (i % 200)})
	)
	return chat(req, asst, source="novel-tests-tool")


TEST_BUILDERS = [
	test_node_create,
	test_pytest_create,
	test_update_existing,
	test_pytest_update,
	test_impl_plus_fixture,
	test_go_table,
	test_rust_unit,
	test_config_snapshot,
	test_tool,
]


def write_rows(path: Path, rows: list[dict]) -> tuple[int, int]:
	path.parent.mkdir(parents=True, exist_ok=True)
	seen: set[str] = set()
	kept = 0
	with path.open("w", encoding="utf-8") as f:
		for row in rows:
			asst = [m["content"] for m in row["messages"] if m["role"] == "assistant"][-1]
			h = hashlib.sha1(asst.encode("utf-8")).hexdigest()
			if h in seen:
				continue
			seen.add(h)
			f.write(json.dumps({"messages": row["messages"], "meta": row.get("meta", {})}, ensure_ascii=False) + "\n")
			kept += 1
	return kept, len(rows)


def generate(builders: list, n: int, seed: int) -> list[dict]:
	rng = random.Random(seed)
	rows: list[dict] = []
	# round-robin builders with unique i
	for i in range(n):
		builder = builders[i % len(builders)]
		rows.append(builder(rng, i))
	return rows


def main() -> None:
	# Target ≥15k total; slightly oversample then dedupe within file
	targets = {
		"novel_bugfix_gold.jsonl": (BUG_BUILDERS, 5600, 701),
		"novel_refactor_gold.jsonl": (REF_BUILDERS, 5600, 702),
		"novel_tests_gold.jsonl": (TEST_BUILDERS, 5600, 703),
	}
	summary = {}
	for name, (builders, n, seed) in targets.items():
		out = OUT / name
		if out.exists():
			raise SystemExit(f"Refusing to overwrite existing {out}")
		rows = generate(builders, n, seed)
		kept, total = write_rows(out, rows)
		summary[name] = {"written": kept, "generated": total, "path": str(out)}
		print(json.dumps(summary[name], indent=2))
	print(json.dumps({"total_written": sum(v["written"] for v in summary.values()), "files": summary}, indent=2))


if __name__ == "__main__":
	main()
