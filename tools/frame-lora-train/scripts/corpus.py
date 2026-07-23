#!/usr/bin/env python3
"""Realistic workspace file corpora for Frame LoRA data (not toy one-liners)."""

from __future__ import annotations

import json
import random
from typing import Callable


def md_readme(rng: random.Random) -> str:
	title = rng.choice(["Frame notes", "Project alpha", "Local IDE", "Ship checklist", "Dev diary"])
	paras = [
		"This project runs models on-device.",
		"Keep changes small and reviewable.",
		"Prefer typed helpers over clever one-liners.",
		"Do not paste unrelated architecture docs into notes.",
		"Chat proposes edits; you click Apply.",
	]
	rng.shuffle(paras)
	body = "\n\n".join(paras[: rng.randint(2, 4)])
	return f"# {title}\n\n{body}\n"


def md_notes(rng: random.Random) -> str:
	lines = [
		"## Scratch",
		"- wire chat apply UI",
		"- tighten token budgets for Q4",
		"- teach frame-edit-plan format",
		"",
		"Open questions:",
		"- adapter fuse path",
		"- eval harness size",
	]
	# Drop / shuffle lightly
	keep = lines[:]
	if rng.random() < 0.4:
		keep.insert(2, f"- bump note {rng.randint(1, 99)}")
	return "\n".join(keep) + "\n"


def ts_module(rng: random.Random) -> str:
	name = rng.choice(["math", "text", "ids", "paths", "flags"])
	variants = {
		"math": '''export function add(a: number, b: number): number {
	return a + b;
}

export function mul(a: number, b: number): number {
	return a * b;
}
''',
		"text": '''export function trimOrEmpty(value: string | null | undefined): string {
	return (value ?? '').trim();
}

export function titleCase(value: string): string {
	return value
		.split(/\\s+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
		.join(' ');
}
''',
		"ids": '''let nextId = 1;

export function createId(prefix = 'id'): string {
	const value = `${prefix}_${nextId}`;
	nextId += 1;
	return value;
}
''',
		"paths": '''export function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p.length > 0)
		.join('/')
		.replace(/\\/+/g, '/');
}
''',
		"flags": '''export type FeatureFlags = {
	enableChat: boolean;
	enableEdits: boolean;
};

export const DEFAULT_FLAGS: FeatureFlags = {
	enableChat: true,
	enableEdits: true,
};

export function isEditEnabled(flags: FeatureFlags): boolean {
	return flags.enableChat && flags.enableEdits;
}
''',
	}
	header = f"// {name}.ts — local helpers\n"
	return header + variants[name]


def py_module(rng: random.Random) -> str:
	kind = rng.choice(["math", "text", "io"])
	if kind == "math":
		return '''"""Small numeric helpers."""

def add(a: int, b: int) -> int:
    return a + b


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))
'''
	if kind == "text":
		return '''"""String helpers."""

def is_blank(value: str | None) -> bool:
    return value is None or not value.strip()


def slugify(text: str) -> str:
    import re

    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower().strip())
    return cleaned.strip("-")
'''
	return '''"""Tiny file helpers."""

from pathlib import Path


def read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")
'''


def js_module(rng: random.Random) -> str:
	return '''export function unique(items) {
  return [...new Set(items)];
}

export function pick(obj, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}
'''


def go_main(rng: random.Random) -> str:
	return '''package main

import "fmt"

func add(a, b int) int {
	return a + b
}

func main() {
	fmt.Println(add(1, 2))
}
'''


def rust_main(rng: random.Random) -> str:
	return '''fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    println!("{}", add(1, 2));
}
'''


def json_config(rng: random.Random) -> str:
	obj = {
		"runtime": "llamacpp",
		"activeModelId": rng.choice(["qwen-coder-7b-q4", "local-dev"]),
		"enabled": True,
		"maxTokens": rng.choice([512, 1024, 2048]),
	}
	return json.dumps(obj, indent=2) + "\n"


def css_snippet(rng: random.Random) -> str:
	return ''':root {
  --bg: #111;
  --fg: #eee;
}

body {
  margin: 0;
  font-family: "IBM Plex Sans", sans-serif;
  background: var(--bg);
  color: var(--fg);
}
'''


def html_page(rng: random.Random) -> str:
	return '''<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Frame</title>
  </head>
  <body>
    <h1>Frame</h1>
  </body>
</html>
'''


def changelog(rng: random.Random) -> str:
	return '''# Changelog

## Unreleased

- chat apply UI
- local model worker

## 0.1.0

- initial scaffold
'''


def buggy_ts(rng: random.Random) -> str:
	# Off-by-one / missing return — used for fix-bug examples
	return '''export function average(nums: number[]): number {
	let sum = 0;
	for (let i = 0; i <= nums.length; i++) {
		sum += nums[i]!;
	}
	return sum / nums.length;
}
'''


def untyped_mess(rng: random.Random) -> str:
	return "export function Foo(X,Y){return X+Y}\n"


CORPUS: list[tuple[str, Callable[[random.Random], str]]] = [
	("README.md", md_readme),
	("NOTES.md", md_notes),
	("docs/guide.md", md_readme),
	("CHANGELOG.md", changelog),
	("src/math.ts", ts_module),
	("src/text.ts", ts_module),
	("src/utils.py", py_module),
	("lib/helpers.js", js_module),
	("pkg/main.go", go_main),
	("main.rs", rust_main),
	("config.json", json_config),
	(".frame/config/runtime.json", json_config),
	("styles/app.css", css_snippet),
	("index.html", html_page),
	("src/average.ts", buggy_ts),
	("src/format.ts", untyped_mess),
]


def sample_file(rng: random.Random) -> tuple[str, str]:
	path, factory = rng.choice(CORPUS)
	# Slight path jitter for common names
	if path.startswith("src/") and rng.random() < 0.3:
		alt = rng.choice(["src/app.ts", "src/lib.ts", "src/helpers.ts", "src/util.py", "src/main.py"])
		content = factory(rng)
		if alt.endswith(".py"):
			content = py_module(rng)
		elif alt.endswith(".ts"):
			content = ts_module(rng)
		return alt, content
	return path, factory(rng)


def active_block(path: str, content: str, request: str) -> str:
	return (
		f"Active file: {path}\n"
		f"Active file contents:\n```\n{content}```\n\n"
		f"User request:\n{request}"
	)
