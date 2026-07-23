#!/usr/bin/env python3
"""
Download additional public code-edit corpora and convert to Frame frame-edit-plan JSONL.

Writes NEW files only (does not overwrite existing raw dumps):
  - instructcoder_slice_b.jsonl   (InstructCoder train[90000:] + valid + seeds)
  - editpack_extra.jsonl         (nuprl/EditPackFT-Multi + kseniasych test)
  - commitpack_instruct.jsonl    (chargoddard/commitpack-ft-instruct)
  - codealpaca_more.jsonl        (Magicoder-OSS-Instruct creates)

Skips rows with before/after >12k chars; requires valid-looking edits.
Dedupes EditPack/commitpack against known nuprl EditPackFT commit hashes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

SYSTEM = """You are Frame, a local coding assistant inside Frame IDE.
Be concise. Prefer tools and edit plans over long explanations.
When changing files, end with one ```frame-edit-plan JSON fence.
For modify/create operations, put FULL file contents in content/newContent.
Never dump unrelated documentation."""

CODE_CUES = [
	"def ", "function ", "class ", "export ", "import ", "package ", "fn ",
	"const ", "return ", "void ", "public ", "private ", "System.out", "console.log",
	"let ", "var ", "=>", "#include", "#!/", "from ",
]


def edit_plan(summary: str, operations: list[dict]) -> str:
	return "```frame-edit-plan\n" + json.dumps({"summary": summary, "operations": operations}, indent=2) + "\n```"


def row(user: str, assistant: str, source: str, extra_meta: dict | None = None) -> dict:
	meta = {"source": source}
	if extra_meta:
		meta.update(extra_meta)
	return {
		"messages": [
			{"role": "system", "content": SYSTEM},
			{"role": "user", "content": user},
			{"role": "assistant", "content": assistant},
		],
		"meta": meta,
	}


def looks_like_code(s: str) -> bool:
	if len(s) < 40 or len(s) > 12_000:
		return False
	hits = sum(1 for c in CODE_CUES if c in s)
	return hits >= 1 and ("\n" in s)


def fence_strip(s: str) -> str:
	m = re.search(r"```(?:\w+)?\n([\s\S]*?)```", s)
	if m:
		return m.group(1).strip() + "\n"
	return s if s.endswith("\n") else s + "\n"


def guess_path(lang: str | None, fallback: str = "edit") -> str:
	ext = {
		"python": "py", "py": "py", "javascript": "js", "js": "js",
		"typescript": "ts", "ts": "ts", "java": "java", "go": "go",
		"rust": "rs", "c": "c", "cpp": "cpp", "c++": "cpp",
		"ruby": "rb", "php": "php", "csharp": "cs", "c#": "cs",
		"swift": "swift", "kotlin": "kt", "scala": "scala",
	}.get((lang or "").lower(), "txt")
	return f"src/edit_sample.{ext}" if fallback == "edit" else f"src/sample.{ext}"


def detect_ext(code: str, instruction: str) -> str:
	blob = (instruction + "\n" + code).lower()
	if "typescript" in blob or ".ts" in blob:
		return "ts"
	if "javascript" in blob or ".js" in blob:
		return "js"
	if "rust" in blob or "fn main" in code:
		return "rs"
	if "golang" in blob or "package main" in code:
		return "go"
	if "java" in blob and "public class" in code:
		return "java"
	if "cpp" in blob or "#include" in code:
		return "cpp"
	return "py"


def convert_before_after(
	instruction: str,
	before: str,
	after: str,
	path: str,
	source: str,
	extra_meta: dict | None = None,
) -> dict | None:
	instruction = str(instruction or "").strip()
	before = str(before or "")
	after = str(after or "")
	if not instruction or not after:
		return None
	if len(after) > 12_000 or len(before) > 12_000:
		return None
	if len(after) < 20:
		return None
	if not looks_like_code(after) and not looks_like_code(before + after):
		# still allow if after has newlines and some structure
		if "\n" not in after or len(after) < 40:
			return None
	path = str(path).lstrip("./") or "src/sample.txt"
	if "/" not in path:
		path = f"src/{path}"

	after_n = after if after.endswith("\n") else after + "\n"
	if before.strip():
		user = (
			f"Active file: {path}\nActive file contents:\n```\n{before}```\n\n"
			f"User request:\n{instruction}"
		)
		op = {
			"kind": "modify",
			"path": path,
			"newContent": after_n,
			"reason": "Apply requested code edit.",
		}
	else:
		user = f"User request:\n{instruction}\n\nCreate or write file `{path}`."
		op = {
			"kind": "create",
			"path": path,
			"content": after_n,
			"reason": "Create file from instruction.",
		}
	asst = f"Applying the edit to `{path}`.\n\n" + edit_plan(instruction[:120], [op])
	return row(user, asst, source, extra_meta)


def convert_instructcoder_obj(obj: dict) -> dict | None:
	instruction = obj.get("instruction") or obj.get("prompt") or obj.get("task") or ""
	before = obj.get("input") or obj.get("code") or obj.get("before") or ""
	after = obj.get("output") or obj.get("edited_code") or obj.get("after") or ""
	lang = obj.get("language") or obj.get("lang")
	path = obj.get("path") or guess_path(lang, "edit")
	return convert_before_after(instruction, before, after, path, "instructcoder")


def convert_editpack_obj(obj: dict, source: str = "editpack_multi") -> dict | None:
	instruction = (
		obj.get("instruction")
		or obj.get("subject")
		or (str(obj.get("message") or "").split("\n")[0])
		or ""
	)
	instruction = re.sub(r"^#+\s*", "", str(instruction)).strip()
	instruction = instruction[:240] or "Apply the code edit."
	before = obj.get("old_contents") or ""
	after = obj.get("new_contents") or ""
	if before == after:
		return None
	path = obj.get("new_file") or obj.get("old_file") or guess_path(obj.get("lang"), "edit")
	meta = {}
	if obj.get("commit"):
		meta["commit"] = str(obj["commit"])
	if obj.get("lang"):
		meta["lang"] = str(obj["lang"])
	return convert_before_after(instruction, before, after, path, source, meta or None)


def convert_commitpack_obj(obj: dict, known_commits: set[str]) -> dict | None:
	cid = str(obj.get("id") or "")
	commit = ""
	if cid.startswith("commitpackft."):
		commit = cid.split(".", 1)[1]
	if commit and commit in known_commits:
		return None
	instruction = (obj.get("instruction") or "").strip()
	# Trim verbose "For your reference..." wrappers to first meaningful line
	first = instruction.split("\n")[0].strip()
	if "achieves this:" in first:
		m = re.search(r'achieves this:\s*"([^"]+)"', first)
		if m:
			instruction = m.group(1).strip()
	elif len(instruction) > 240:
		instruction = first[:240]
	before = fence_strip(obj.get("input") or "")
	after = fence_strip(obj.get("output") or "")
	if before.strip() == after.strip():
		return None
	lang = obj.get("language")
	path = guess_path(lang, "edit")
	meta = {"commit": commit} if commit else None
	return convert_before_after(instruction, before, after, path, "commitpack_instruct", meta)


def convert_magicoder_obj(obj: dict, idx: int) -> dict | None:
	problem = (obj.get("problem") or "").strip()
	solution = (obj.get("solution") or "").strip()
	if not problem or not solution:
		return None
	code = fence_strip(solution)
	if not looks_like_code(code):
		return None
	lang = obj.get("lang") or ""
	ext = detect_ext(code, problem + "\n" + lang)
	path = f"src/magicoder_{idx:05d}.{ext}"
	user = f"{problem}\n\nWrite the result to `{path}`."
	op = {
		"kind": "create",
		"path": path,
		"content": code,
		"reason": "Create from instruction.",
	}
	asst = f"Working on `{path}`.\n\n" + edit_plan(problem[:120], [op])
	return row(user, asst, "magicoder", {"lang": str(lang)} if lang else None)


def write_jsonl(path: Path, rows: list[dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for r in rows:
			f.write(json.dumps({"messages": r["messages"], "meta": r.get("meta")}, ensure_ascii=False) + "\n")


def load_nuprl_commits() -> set[str]:
	try:
		from datasets import load_dataset
	except ImportError:
		return set()
	print("loading nuprl/EditPackFT commits for dedupe ...")
	ds = load_dataset("nuprl/EditPackFT", split="train")
	return {str(ds[i]["commit"]) for i in range(len(ds)) if ds[i].get("commit")}


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "raw")
	parser.add_argument("--instructcoder-offset", type=int, default=90_000, help="Skip first N train rows already ingested")
	parser.add_argument("--editpack-multi-limit", type=int, default=40_000)
	parser.add_argument("--commitpack-limit", type=int, default=40_000)
	parser.add_argument("--magicoder-limit", type=int, default=25_000)
	parser.add_argument("--seed", type=int, default=11)
	args = parser.parse_args()
	rng = random.Random(args.seed)
	args.out_dir.mkdir(parents=True, exist_ok=True)

	from datasets import load_dataset
	from huggingface_hub import hf_hub_download

	report: dict = {"sources": {}, "outs": {}}

	# --- InstructCoder remaining + valid + seeds ---
	print("InstructCoder remaining slice ...")
	ic = load_dataset("likaixin/InstructCoder")
	train = ic["train"]
	valid = ic["validation"]
	ic_rows: list[dict] = []
	offset = min(args.instructcoder_offset, len(train))
	for i in range(offset, len(train)):
		r = convert_instructcoder_obj(dict(train[i]))
		if r:
			ic_rows.append(r)
	for i in range(len(valid)):
		r = convert_instructcoder_obj(dict(valid[i]))
		if r:
			ic_rows.append(r)
	for seed_name in ("additional_seed.json", "github_seed.json"):
		try:
			p = hf_hub_download("likaixin/InstructCoder", seed_name, repo_type="dataset")
			seed_data = json.loads(Path(p).read_text(encoding="utf-8"))
			seed_ok = 0
			for obj in seed_data:
				r = convert_instructcoder_obj(obj)
				if r:
					r["meta"]["source"] = f"instructcoder_seed:{seed_name}"
					ic_rows.append(r)
					seed_ok += 1
			report["sources"][f"instructcoder_{seed_name}"] = seed_ok
		except Exception as e:
			report.setdefault("errors", []).append(f"{seed_name}: {e}")
	rng.shuffle(ic_rows)
	ic_out = args.out_dir / "instructcoder_slice_b.jsonl"
	write_jsonl(ic_out, ic_rows)
	report["sources"]["instructcoder_slice_b"] = {
		"train_offset": offset,
		"train_remaining": len(train) - offset,
		"valid": len(valid),
		"converted": len(ic_rows),
	}
	report["outs"]["instructcoder_slice_b"] = str(ic_out)
	print(f"wrote {len(ic_rows)} {ic_out}")

	known_commits = load_nuprl_commits()
	print(f"known nuprl commits: {len(known_commits)}")

	# --- EditPackFT-Multi + kseniasych test ---
	print("EditPackFT-Multi ...")
	multi = load_dataset("nuprl/EditPackFT-Multi", split="train")
	idxs = list(range(len(multi)))
	rng.shuffle(idxs)
	ep_rows: list[dict] = []
	seen_commits: set[str] = set(known_commits)
	skipped_dup = 0
	for i in idxs:
		if len(ep_rows) >= args.editpack_multi_limit:
			break
		obj = dict(multi[i])
		c = str(obj.get("commit") or "")
		if c and c in seen_commits:
			skipped_dup += 1
			continue
		r = convert_editpack_obj(obj, "editpack_multi")
		if not r:
			continue
		if c:
			seen_commits.add(c)
		ep_rows.append(r)

	# kseniasych test split
	try:
		ks = load_dataset("kseniasych/Code-Edits-EditPackFT", split="test")
		ks_ok = 0
		for i in range(len(ks)):
			obj = dict(ks[i])
			c = str(obj.get("commit") or "")
			if c and c in seen_commits:
				skipped_dup += 1
				continue
			r = convert_editpack_obj(obj, "editpack_kseniasych_test")
			if r:
				ep_rows.append(r)
				ks_ok += 1
				if c:
					seen_commits.add(c)
		report["sources"]["kseniasych_test"] = ks_ok
	except Exception as e:
		report.setdefault("errors", []).append(f"kseniasych test: {e}")

	rng.shuffle(ep_rows)
	ep_out = args.out_dir / "editpack_extra.jsonl"
	write_jsonl(ep_out, ep_rows)
	report["sources"]["editpack_extra"] = {
		"converted": len(ep_rows),
		"skipped_dup_commits": skipped_dup,
		"multi_limit": args.editpack_multi_limit,
	}
	report["outs"]["editpack_extra"] = str(ep_out)
	print(f"wrote {len(ep_rows)} {ep_out}")

	# --- commitpack-ft-instruct ---
	print("commitpack-ft-instruct ...")
	cp = load_dataset("chargoddard/commitpack-ft-instruct", split="train")
	cp_idxs = list(range(len(cp)))
	rng.shuffle(cp_idxs)
	cp_rows: list[dict] = []
	cp_skip = 0
	for i in cp_idxs:
		if len(cp_rows) >= args.commitpack_limit:
			break
		r = convert_commitpack_obj(dict(cp[i]), known_commits)
		if not r:
			cp_skip += 1
			continue
		# also skip commits already taken by editpack_extra this run
		c = (r.get("meta") or {}).get("commit")
		if c and c in seen_commits and c in known_commits:
			cp_skip += 1
			continue
		cp_rows.append(r)
	rng.shuffle(cp_rows)
	cp_out = args.out_dir / "commitpack_instruct.jsonl"
	write_jsonl(cp_out, cp_rows)
	report["sources"]["commitpack_instruct"] = {
		"converted": len(cp_rows),
		"skipped": cp_skip,
		"limit": args.commitpack_limit,
	}
	report["outs"]["commitpack_instruct"] = str(cp_out)
	print(f"wrote {len(cp_rows)} {cp_out}")

	# --- Magicoder → codealpaca_more style creates ---
	print("Magicoder-OSS-Instruct ...")
	mag = load_dataset("ise-uiuc/Magicoder-OSS-Instruct-75K", split="train")
	mag_idxs = list(range(len(mag)))
	rng.shuffle(mag_idxs)
	mag_rows: list[dict] = []
	for i in mag_idxs:
		if len(mag_rows) >= args.magicoder_limit:
			break
		r = convert_magicoder_obj(dict(mag[i]), len(mag_rows))
		if r:
			mag_rows.append(r)
	mag_out = args.out_dir / "codealpaca_more.jsonl"
	write_jsonl(mag_out, mag_rows)
	report["sources"]["codealpaca_more_magicoder"] = {
		"converted": len(mag_rows),
		"limit": args.magicoder_limit,
		"raw": len(mag),
	}
	report["outs"]["codealpaca_more"] = str(mag_out)
	print(f"wrote {len(mag_rows)} {mag_out}")

	total = len(ic_rows) + len(ep_rows) + len(cp_rows) + len(mag_rows)
	report["total_new_rows"] = total
	manifest = args.out_dir / "extra_public_edits.manifest.json"
	manifest.write_text(json.dumps(report, indent=2) + "\n")
	print(json.dumps(report, indent=2))


if __name__ == "__main__":
	main()
