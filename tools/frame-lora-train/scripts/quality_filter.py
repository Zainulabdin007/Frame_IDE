#!/usr/bin/env python3
"""Validate Frame JSONL: edit-plan/tool JSON must parse; drop broken rows."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ALLOWED_TOOLS = {
	"readFile", "listFiles", "globFiles", "grepWorkspace", "codebaseSearch",
	"findSymbol", "findReferences", "findDependencies", "findCallers",
	"findImplementations", "readLints", "gitStatus", "gitDiff",
}
TOOL_REQUIRED_ARGS = {
	"readFile": ("path",),
	"listFiles": (),
	"globFiles": ("pattern",),
	"grepWorkspace": ("pattern",),
	"codebaseSearch": ("query",),
	"findSymbol": ("name",),
	"findReferences": ("name",),
	"findDependencies": ("path",),
	"findCallers": ("name",),
	"findImplementations": ("name",),
	"readLints": (),
	"gitStatus": (),
	"gitDiff": ("path",),
}
EDIT_KINDS = {"modify", "create", "append", "prepend", "insert", "delete", "rename"}


def fenced_json(text: str, label: str) -> dict | None:
	"""Decode the first JSON object after a control fence, including nested ``` content."""
	marker = f"```{label}"
	start = text.lower().find(marker.lower())
	if start < 0:
		return None
	brace = text.find("{", start + len(marker))
	if brace < 0:
		return None
	try:
		value, _ = json.JSONDecoder().raw_decode(text[brace:])
	except json.JSONDecodeError:
		return None
	return value if isinstance(value, dict) else None


def safe_path(value: object) -> bool:
	if not isinstance(value, str) or not value.strip():
		return False
	path = value.strip().replace("\\", "/")
	return not path.startswith("/") and ".." not in path.split("/") and "\x00" not in path


def validate_row(row: dict) -> list[str]:
	issues: list[str] = []
	msgs = row.get("messages")
	if not isinstance(msgs, list) or len(msgs) < 2:
		return ["messages.invalid"]
	if msgs[0].get("role") != "system":
		issues.append("messages.missing_system")
	if not any(m.get("role") == "assistant" for m in msgs):
		issues.append("messages.no_assistant")
		return issues

	last_user = ""
	seen_tools: set[str] = set()
	for message in msgs:
		role = message.get("role")
		text = message.get("content", "")
		if role not in {"system", "user", "assistant"} or not isinstance(text, str):
			issues.append("messages.invalid_entry")
			continue
		if role == "user":
			last_user = text.lower()
			continue
		if role != "assistant":
			continue
		if not text.strip():
			issues.append("assistant.empty")
			continue
		if len(text) > 16_000:
			issues.append("assistant.too_long")
		if "…[truncated" in text.lower() or "[truncated " in text.lower():
			issues.append("assistant.truncated")
		lower = text.lower()
		has_edit = "```frame-edit-plan" in lower
		has_tool = "```frame-tool" in lower
		if has_edit and has_tool:
			issues.append("control.mixed")
			continue
		if lower.count("```frame-edit-plan") > 1 or lower.count("```frame-tool") > 1:
			issues.append("control.multiple")
		if has_edit:
			payload = fenced_json(text, "frame-edit-plan")
			if payload is None:
				issues.append("edit.invalid_json")
				continue
			if not isinstance(payload.get("summary"), str) or not payload["summary"].strip():
				issues.append("edit.missing_summary")
			ops = payload.get("operations")
			if not isinstance(ops, list) or not ops:
				issues.append("edit.operations")
				continue
			paths: set[str] = set()
			add_end = any(phrase in last_user for phrase in ("at the end", "to the end", "end of the file", "at the bottom", "bottom of the file"))
			add_first = any(phrase in last_user for phrase in ("first line", "1st line", "top of the file"))
			add_numbered = (
				any(phrase in last_user for phrase in ("second line", "2nd line", "third line", "3rd line", "on line "))
				or ("on line" in last_user and any(ch.isdigit() for ch in last_user))
			)
			for op in ops:
				if not isinstance(op, dict) or op.get("kind") not in EDIT_KINDS:
					issues.append("edit.kind")
					continue
				kind = op["kind"]
				path_fields = ("fromPath", "toPath") if kind == "rename" else ("path",)
				if not all(safe_path(op.get(field)) for field in path_fields):
					issues.append("edit.path")
				path_key = "|".join(str(op.get(field)) for field in path_fields)
				if path_key in paths:
					issues.append("edit.duplicate_path")
				paths.add(path_key)
				if kind == "modify" and not isinstance(op.get("newContent"), str):
					issues.append("edit.modify_content")
				if kind in {"create", "append", "prepend"} and not isinstance(op.get("content"), str):
					issues.append("edit.content")
				if kind == "insert" and (not isinstance(op.get("content"), str) or not isinstance(op.get("line"), int) or op["line"] < 1):
					issues.append("edit.insert")
				if add_end and kind == "modify":
					issues.append("behavior.end_requires_append")
				if add_first and kind == "modify":
					issues.append("behavior.first_requires_prepend")
				if add_numbered and kind != "insert":
					issues.append("behavior.line_requires_insert")
			continue
		if has_tool:
			tool = fenced_json(text, "frame-tool")
			if tool is None:
				issues.append("tool.invalid_json")
				continue
			name = tool.get("name")
			args = tool.get("arguments")
			if name not in ALLOWED_TOOLS:
				issues.append("tool.unsupported")
				continue
			if not isinstance(args, dict):
				issues.append("tool.arguments")
				continue
			if not all(isinstance(args.get(key), str) and args[key].strip() for key in TOOL_REQUIRED_ARGS[name]):
				issues.append("tool.required_args")
			key = json.dumps([name, args], sort_keys=True)
			if key in seen_tools:
				issues.append("tool.repeated")
			seen_tools.add(key)
			continue
		if len(text) >= 2_000:
			issues.append("plain.too_long")
		if any(phrase in lower for phrase in ("i don't have access to", "i cannot access the file", "i can't access the file")):
			issues.append("plain.false_tool_refusal")
	return sorted(set(issues))


def ok_row(row: dict) -> bool:
	return not validate_row(row)


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("inputs", nargs="+", type=Path)
	parser.add_argument("--out", type=Path, required=True)
	args = parser.parse_args()
	kept = dropped = 0
	args.out.parent.mkdir(parents=True, exist_ok=True)
	with args.out.open("w", encoding="utf-8") as out:
		for path in args.inputs:
			if not path.exists():
				continue
			if path.name.startswith("filtered_"):
				continue
			try:
				fh = path.open("r", encoding="utf-8", errors="replace")
			except OSError:
				continue
			with fh:
				for line in fh:
					if not line.strip():
						continue
					try:
						row = json.loads(line)
					except json.JSONDecodeError:
						dropped += 1
						continue
					if ok_row(row):
						out.write(json.dumps({"messages": row["messages"]}, ensure_ascii=False) + "\n")
						kept += 1
					else:
						dropped += 1
	print(json.dumps({"kept": kept, "dropped": dropped, "out": str(args.out)}, indent=2))


if __name__ == "__main__":
	main()
