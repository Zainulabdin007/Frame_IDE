#!/usr/bin/env python3
"""
Long-running augmenter for the 3h campaign.

Reads existing high-quality Frame JSONL rows and emits paraphrase variants of
USER prompts (assistant plans stay identical) — teaches instruction robustness
without inventing wrong code edits.

Also mines additional vscode paths gradually across passes.
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
Never dump unrelated documentation."""

USER_PARAPHRASE_PREFIXES = [
	"please ",
	"can you ",
	"hey — ",
	"",
	"quickly ",
	"for me, ",
]

USER_PARAPHRASE_SUFFIXES = [
	"",
	" thanks",
	" — nothing else",
	" and keep the rest identical",
	" now",
]


def fp(text: str) -> str:
	return hashlib.sha1(text.encode("utf-8")).hexdigest()


def paraphrase_user(user: str, rng: random.Random) -> str:
	# Only paraphrase the trailing "User request:" section when present
	if "User request:\n" in user:
		head, req = user.split("User request:\n", 1)
		req = req.strip()
		pre = rng.choice(USER_PARAPHRASE_PREFIXES)
		suf = rng.choice(USER_PARAPHRASE_SUFFIXES)
		# light synonym swaps
		swaps = [
			("append", "add"),
			("add", "append"),
			("create", "write"),
			("write", "create"),
			("fix", "repair"),
			("repair", "fix"),
			("rename", "move/rename"),
			("modify", "update"),
			("update", "modify"),
			("change", "edit"),
			("edit", "change"),
			("delete", "remove"),
			("remove", "delete"),
			("replace", "swap"),
			("insert", "add in"),
			("refactor", "restructure"),
			("implement", "add"),
			("patch", "fix"),
		]
		# Apply 1–2 synonym swaps when possible for more instruction diversity
		req2 = req
		n_swaps = 1 if rng.random() < 0.55 else (2 if rng.random() < 0.7 else 0)
		for _ in range(n_swaps):
			old, new = rng.choice(swaps)
			cand = re.sub(rf"\b{re.escape(old)}\b", new, req2, count=1, flags=re.I)
			if cand != req2:
				req2 = cand
		return head + "User request:\n" + f"{pre}{req2}{suf}".strip()
	pre = rng.choice(USER_PARAPHRASE_PREFIXES)
	suf = rng.choice(USER_PARAPHRASE_SUFFIXES)
	return f"{pre}{user.strip()}{suf}".strip()


def load_rows(paths: list[Path]) -> list[dict]:
	rows = []
	for p in paths:
		if not p.exists():
			continue
		with p.open(encoding="utf-8") as f:
			for line in f:
				line = line.strip()
				if not line:
					continue
				try:
					rows.append(json.loads(line))
				except json.JSONDecodeError:
					# Concurrent writers can leave a truncated last line — skip it.
					continue
	return rows


def main() -> None:
	parser = argparse.ArgumentParser()
	root = Path(__file__).resolve().parents[1]
	parser.add_argument("--minutes", type=float, default=25.0)
	parser.add_argument("--out", type=Path, default=root / "data" / "raw" / "paraphrase_aug.jsonl")
	parser.add_argument("--seed", type=int, default=13)
	parser.add_argument("--variants-per-seed", type=int, default=2)
	args = parser.parse_args()
	rng = random.Random(args.seed)

	seed_paths = [
		root / "data" / "raw" / "vscode_mined.jsonl",
		root / "data" / "raw" / "vscode_mutations.jsonl",
		root / "data" / "raw" / "frameai_modules.jsonl",
		root / "data" / "processed" / "train.jsonl",
	]
	seeds = load_rows(seed_paths)
	# Prefer rows with edit plans
	seeds = [r for r in seeds if any(
		m["role"] == "assistant" and "frame-edit-plan" in m["content"]
		for m in r.get("messages", [])
	)]
	rng.shuffle(seeds)
	print(f"seed edit rows: {len(seeds)}")

	deadline = time.time() + args.minutes * 60
	seen = set()
	written = 0
	args.out.parent.mkdir(parents=True, exist_ok=True)
	# resume-friendly append
	if args.out.exists():
		for line in args.out.read_text(encoding="utf-8").splitlines():
			if line.strip():
				seen.add(fp(line))

	with args.out.open("a", encoding="utf-8") as f:
		i = 0
		while time.time() < deadline and seeds:
			row = seeds[i % len(seeds)]
			i += 1
			msgs = row["messages"]
			user = next(m["content"] for m in msgs if m["role"] == "user")
			asst = [m["content"] for m in msgs if m["role"] == "assistant"][-1]
			for _ in range(args.variants_per_seed):
				if time.time() >= deadline:
					break
				new_user = paraphrase_user(user, rng)
				if new_user == user:
					continue
				out_row = {
					"messages": [
						{"role": "system", "content": SYSTEM},
						{"role": "user", "content": new_user},
						{"role": "assistant", "content": asst},
					],
					"meta": {"source": "paraphrase-aug"},
				}
				line = json.dumps({"messages": out_row["messages"], "meta": out_row["meta"]}, ensure_ascii=False)
				h = fp(line)
				if h in seen:
					continue
				seen.add(h)
				f.write(line + "\n")
				written += 1
			if i % 500 == 0:
				f.flush()
				print(f"progress written={written} elapsed_seeds={i}")
			# gentle pace so this truly occupies wall time when minutes is large
			time.sleep(0.002)

	print(json.dumps({"written": written, "out": str(args.out), "minutes": args.minutes}, indent=2))


if __name__ == "__main__":
	main()
