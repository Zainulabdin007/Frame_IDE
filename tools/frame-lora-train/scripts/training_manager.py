#!/usr/bin/env python3
"""
Frame LoRA training manager — local only.

Detects MLX / Apple Silicon, estimates duration & RAM, starts/pauses/resumes/
cancels/schedules training jobs, and can limit CPU when falling back off-GPU.

Job state lives under tools/frame-lora-train/jobs/<job_id>/
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
JOBS_DIR = ROOT / "jobs"
DEFAULT_MODEL = "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit"
DEFAULT_ADAPTER = ROOT / "adapters" / "frame-agent-v1"
DEFAULT_DATA = ROOT / "data" / "processed"


@dataclass
class BackendProbe:
	apple_silicon: bool
	mlx_importable: bool
	mlx_python: str | None
	backend: str  # "mlx_gpu" | "cpu"
	reason: str


@dataclass
class TrainEstimate:
	backend: str
	iters: int
	train_rows: int
	valid_rows: int
	estimated_duration_hours: float
	estimated_ram_gb: float
	notes: list[str]


def _utc_now() -> str:
	return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: Path) -> dict[str, Any]:
	return json.loads(path.read_text())


def _write_json(path: Path, data: dict[str, Any]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(json.dumps(data, indent=2) + "\n")


def find_mlx_python() -> str | None:
	"""Prefer project venv with mlx-lm; else current interpreter if mlx imports."""
	candidates = [
		ROOT / ".venv-lora" / "bin" / "python",
		ROOT / ".venv-lora" / "bin" / "python3",
		Path(sys.executable),
	]
	for py in candidates:
		if not py.exists():
			continue
		try:
			proc = subprocess.run(
				[str(py), "-c", "import mlx; import mlx_lm; print('ok')"],
				capture_output=True,
				text=True,
				timeout=60,
			)
			if proc.returncode == 0 and "ok" in (proc.stdout or ""):
				return str(py)
		except (OSError, subprocess.TimeoutExpired):
			continue
	return None


def probe_backend() -> BackendProbe:
	apple = platform.system() == "Darwin" and platform.machine().lower() in ("arm64", "aarch64")
	mlx_py = find_mlx_python()
	mlx_ok = mlx_py is not None
	if apple and mlx_ok:
		return BackendProbe(
			apple_silicon=True,
			mlx_importable=True,
			mlx_python=mlx_py,
			backend="mlx_gpu",
			reason="Apple Silicon + MLX available — training will use Metal GPU.",
		)
	if mlx_ok:
		return BackendProbe(
			apple_silicon=apple,
			mlx_importable=True,
			mlx_python=mlx_py,
			backend="mlx_gpu" if apple else "cpu",
			reason="MLX importable; Metal preferred only on Apple Silicon.",
		)
	return BackendProbe(
		apple_silicon=apple,
		mlx_importable=False,
		mlx_python=None,
		backend="cpu",
		reason=(
			"MLX not installed. Create .venv-lora and pip install 'mlx-lm[train]', "
			"or training cannot use the GPU path."
		),
	)


def count_lines(path: Path) -> int:
	if not path.exists():
		return 0
	n = 0
	with path.open("rb") as f:
		for _ in f:
			n += 1
	return n


def estimate(
	*,
	data_dir: Path,
	iters: int,
	backend: str | None = None,
	ram_gb: float | None = None,
) -> TrainEstimate:
	probe = probe_backend()
	be = backend or probe.backend
	train = data_dir / "train.jsonl"
	valid = data_dir / "valid.jsonl"
	if not train.exists():
		train = data_dir / "frame_agent_train.jsonl"
	if not valid.exists():
		valid = data_dir / "frame_agent_valid.jsonl"
	train_rows = count_lines(train)
	valid_rows = count_lines(valid)

	# Empirically ~4–8s/iter for Qwen2.5-Coder-7B-4bit QLoRA on M-series 64GB.
	# CPU-only is much slower (~15–40s/iter) if forced.
	sec_per_iter = 6.0 if be == "mlx_gpu" else 25.0
	hours = (iters * sec_per_iter) / 3600.0

	# 4bit 7B + activations + LoRA + IDE headroom on unified memory.
	est_ram = 18.0 if be == "mlx_gpu" else 22.0
	if ram_gb is not None and ram_gb < est_ram + 8:
		notes_extra = [f"Machine RAM ~{ram_gb:.0f} GB is tight for ~{est_ram:.0f} GB training + OS."]
	else:
		notes_extra = []

	notes = [
		f"Backend: {be}",
		f"Train rows: {train_rows:,} · valid: {valid_rows:,}",
		f"~{sec_per_iter:.0f}s/iter assumed — wall clock varies with thermals/power.",
		"Keep the Mac plugged in. Close heavy apps if memory pressure spikes.",
		*notes_extra,
	]
	if be != "mlx_gpu":
		notes.append("GPU/MLX unavailable — CPU fallback will be slow; install mlx-lm in .venv-lora.")

	return TrainEstimate(
		backend=be,
		iters=iters,
		train_rows=train_rows,
		valid_rows=valid_rows,
		estimated_duration_hours=round(hours, 1),
		estimated_ram_gb=est_ram,
		notes=notes,
	)


def job_dir(job_id: str) -> Path:
	return JOBS_DIR / job_id


def load_job(job_id: str) -> dict[str, Any]:
	path = job_dir(job_id) / "job.json"
	if not path.exists():
		raise SystemExit(f"Unknown job: {job_id}")
	return _read_json(path)


def save_job(job: dict[str, Any]) -> None:
	_write_json(job_dir(job["id"]) / "job.json", job)


def create_job(
	*,
	name: str,
	iters: int,
	data_dir: Path,
	adapter_path: Path,
	model: str,
	cpu_limit: bool,
	schedule_at: str | None,
) -> dict[str, Any]:
	probe = probe_backend()
	est = estimate(data_dir=data_dir, iters=iters, backend=probe.backend)
	job_id = f"job-{int(time.time())}-{os.getpid()}"
	job = {
		"id": job_id,
		"name": name,
		"status": "scheduled" if schedule_at else "draft",
		"createdAt": _utc_now(),
		"updatedAt": _utc_now(),
		"model": model,
		"dataDir": str(data_dir),
		"adapterPath": str(adapter_path),
		"iters": iters,
		"backend": probe.backend,
		"mlxPython": probe.mlx_python,
		"cpuLimit": cpu_limit,
		"scheduleAt": schedule_at,
		"pid": None,
		"progress": 0.0,
		"estimate": asdict(est),
		"probe": asdict(probe),
		"logFile": str(job_dir(job_id) / "train.log"),
		"error": None,
	}
	save_job(job)
	return job


def _ensure_data_links(data_dir: Path) -> None:
	data_dir.mkdir(parents=True, exist_ok=True)
	pairs = [
		("train.jsonl", "frame_agent_train.jsonl"),
		("valid.jsonl", "frame_agent_valid.jsonl"),
	]
	for preferred, alt in pairs:
		pref = data_dir / preferred
		other = data_dir / alt
		if pref.exists():
			continue
		if other.exists():
			try:
				pref.symlink_to(other.name)
			except OSError:
				# Fall back to copy is too expensive for 1GB — require real file.
				raise SystemExit(f"Missing {pref}; create symlink to {other.name}")


def _build_train_cmd(job: dict[str, Any]) -> list[str]:
	py = job.get("mlxPython") or sys.executable
	script = ROOT / "scripts" / "train_mlx_lora.py"
	cmd = [
		py,
		str(script),
		"--data-dir",
		job["dataDir"],
		"--model",
		job["model"],
		"--adapter-path",
		job["adapterPath"],
		"--iters",
		str(job["iters"]),
	]
	return cmd


def start_job(job_id: str, *, force_cpu: bool = False) -> dict[str, Any]:
	job = load_job(job_id)
	if job.get("pid") and _pid_alive(job["pid"]) and job.get("status") in ("running", "paused"):
		raise SystemExit(f"Job already active (pid={job['pid']} status={job['status']})")

	probe = probe_backend()
	if force_cpu:
		job["backend"] = "cpu"
	else:
		job["backend"] = probe.backend
		job["mlxPython"] = probe.mlx_python
		job["probe"] = asdict(probe)

	if job["backend"] == "mlx_gpu" and not probe.mlx_importable:
		job["backend"] = "cpu"
		job["error"] = "MLX missing — falling back to CPU path (not recommended)."

	if job["backend"] == "mlx_gpu" and not probe.mlx_python:
		raise SystemExit("MLX python not found. Run: python3 -m venv .venv-lora && pip install 'mlx-lm[train]'")

	_ensure_data_links(Path(job["dataDir"]))
	adapter = Path(job["adapterPath"])
	adapter.mkdir(parents=True, exist_ok=True)

	log_path = Path(job["logFile"])
	log_path.parent.mkdir(parents=True, exist_ok=True)
	cmd = _build_train_cmd(job)

	env = os.environ.copy()
	env["FRAME_TRAIN_JOB_ID"] = job_id
	env["PYTHONUNBUFFERED"] = "1"
	# MLX uses Metal by default on Apple Silicon; no special flag required.
	if job["backend"] == "cpu":
		env["MLX_FORCE_CPU"] = "1"

	preexec = None
	wrap: list[str] = []
	if job.get("cpuLimit") or job["backend"] == "cpu":
		# Lower scheduling priority so the IDE stays responsive.
		wrap = ["nice", "-n", "15"]
		if sys.platform == "darwin":
			# Prefer App Nap / background QoS when available.
			wrap = ["taskpolicy", "-c", "background", "nice", "-n", "15"]

	full_cmd = wrap + cmd if wrap else cmd
	log_f = log_path.open("a", encoding="utf-8")
	log_f.write(f"\n===== start {_utc_now()} backend={job['backend']} =====\n")
	log_f.write("CMD: " + " ".join(full_cmd) + "\n")
	log_f.flush()

	proc = subprocess.Popen(
		full_cmd,
		cwd=str(ROOT),
		env=env,
		stdout=log_f,
		stderr=subprocess.STDOUT,
		start_new_session=True,
	)
	job["pid"] = proc.pid
	job["status"] = "running"
	job["updatedAt"] = _utc_now()
	job["error"] = None
	job["startedAt"] = _utc_now()
	save_job(job)
	(job_dir(job_id) / "pid").write_text(str(proc.pid) + "\n")
	return job


def _pid_alive(pid: int | None) -> bool:
	if not pid:
		return False
	try:
		os.kill(pid, 0)
		return True
	except OSError:
		return False


def pause_job(job_id: str) -> dict[str, Any]:
	job = load_job(job_id)
	pid = job.get("pid")
	if not _pid_alive(pid):
		job["status"] = "failed"
		job["error"] = "Process not running"
		job["updatedAt"] = _utc_now()
		save_job(job)
		raise SystemExit("Process not running")
	os.kill(pid, signal.SIGSTOP)
	job["status"] = "paused"
	job["updatedAt"] = _utc_now()
	save_job(job)
	return job


def resume_job(job_id: str) -> dict[str, Any]:
	job = load_job(job_id)
	pid = job.get("pid")
	if not _pid_alive(pid):
		raise SystemExit("Process not running")
	os.kill(pid, signal.SIGCONT)
	job["status"] = "running"
	job["updatedAt"] = _utc_now()
	save_job(job)
	return job


def cancel_job(job_id: str) -> dict[str, Any]:
	job = load_job(job_id)
	pid = job.get("pid")
	if _pid_alive(pid):
		try:
			os.kill(pid, signal.SIGCONT)  # in case paused
		except OSError:
			pass
		try:
			os.killpg(pid, signal.SIGTERM)
		except OSError:
			try:
				os.kill(pid, signal.SIGTERM)
			except OSError:
				pass
		time.sleep(1.5)
		if _pid_alive(pid):
			try:
				os.killpg(pid, signal.SIGKILL)
			except OSError:
				try:
					os.kill(pid, signal.SIGKILL)
				except OSError:
					pass
	job["status"] = "cancelled"
	job["updatedAt"] = _utc_now()
	job["pid"] = None
	save_job(job)
	return job


def refresh_status(job_id: str) -> dict[str, Any]:
	job = load_job(job_id)
	pid = job.get("pid")
	if job.get("status") in ("running", "paused") and not _pid_alive(pid):
		# Infer success if adapter artifacts exist.
		adapter = Path(job["adapterPath"])
		has_weights = any(adapter.glob("*.safetensors")) or (adapter / "adapters.safetensors").exists()
		job["status"] = "succeeded" if has_weights else "failed"
		if not has_weights:
			job["error"] = job.get("error") or "Process exited without adapter weights"
		job["pid"] = None
		job["updatedAt"] = _utc_now()
		job["progress"] = 1.0 if has_weights else job.get("progress", 0.0)
		save_job(job)
	elif job.get("status") == "running":
		# Best-effort progress from log "Iter N" lines (avoid false positives).
		log_path = Path(job["logFile"])
		if log_path.exists():
			try:
				import re
				tail = log_path.read_text(errors="ignore")[-12000:]
				iters_done = 0
				for m in re.finditer(r"(?:Iter(?:ation)?|it)\s*[:=]?\s*(\d+)", tail, re.I):
					val = int(m.group(1))
					if 0 < val <= int(job.get("iters") or 0):
						iters_done = max(iters_done, val)
				if job.get("iters") and iters_done:
					job["progress"] = round(min(0.99, iters_done / float(job["iters"])), 3)
					job["updatedAt"] = _utc_now()
					save_job(job)
			except OSError:
				pass
	return job


def schedule_job(job_id: str, when: str) -> dict[str, Any]:
	"""
	Schedule start at an ISO time or relative like +8h / overnight.
	Uses a background sleeper process (no root required).
	"""
	job = load_job(job_id)
	delay_s = _parse_schedule_delay(when)
	job["status"] = "scheduled"
	job["scheduleAt"] = when
	job["scheduleDelaySeconds"] = delay_s
	job["updatedAt"] = _utc_now()
	save_job(job)

	py = sys.executable
	script = Path(__file__).resolve()
	log_path = job_dir(job_id) / "scheduler.log"
	cmd = [py, str(script), "scheduler-wait", "--job-id", job_id, "--delay", str(delay_s)]
	log_f = log_path.open("a", encoding="utf-8")
	proc = subprocess.Popen(
		cmd,
		cwd=str(ROOT),
		stdout=log_f,
		stderr=subprocess.STDOUT,
		start_new_session=True,
	)
	job["schedulerPid"] = proc.pid
	save_job(job)
	return job


def _parse_schedule_delay(when: str) -> int:
	w = when.strip().lower()
	if w in ("overnight", "tonight", "night"):
		# Default: start in 8 hours (evening → overnight).
		return 8 * 3600
	if w.startswith("+") and w.endswith("h"):
		return int(float(w[1:-1]) * 3600)
	if w.startswith("+") and w.endswith("m"):
		return int(float(w[1:-1]) * 60)
	# ISO timestamp
	try:
		target = datetime.fromisoformat(when.replace("Z", "+00:00"))
		now = datetime.now(timezone.utc)
		if target.tzinfo is None:
			target = target.replace(tzinfo=timezone.utc)
		delay = int((target - now).total_seconds())
		return max(0, delay)
	except ValueError as e:
		raise SystemExit(f"Bad schedule time {when!r}: {e}") from e


def scheduler_wait(job_id: str, delay: int) -> None:
	time.sleep(max(0, delay))
	job = load_job(job_id)
	if job.get("status") == "cancelled":
		return
	start_job(job_id)


def list_jobs() -> list[dict[str, Any]]:
	JOBS_DIR.mkdir(parents=True, exist_ok=True)
	out: list[dict[str, Any]] = []
	for p in sorted(JOBS_DIR.glob("job-*/job.json")):
		try:
			job = _read_json(p)
			out.append(refresh_status(job["id"]))
		except Exception:
			continue
	return out


def cmd_probe(_: argparse.Namespace) -> None:
	print(json.dumps(asdict(probe_backend()), indent=2))


def cmd_estimate(args: argparse.Namespace) -> None:
	est = estimate(data_dir=args.data_dir, iters=args.iters, backend=args.backend)
	print(json.dumps(asdict(est), indent=2))


def cmd_create(args: argparse.Namespace) -> None:
	job = create_job(
		name=args.name,
		iters=args.iters,
		data_dir=args.data_dir,
		adapter_path=args.adapter_path,
		model=args.model,
		cpu_limit=args.cpu_limit,
		schedule_at=args.schedule,
	)
	print(json.dumps(job, indent=2))


def cmd_start(args: argparse.Namespace) -> None:
	job = start_job(args.job_id, force_cpu=args.force_cpu)
	print(json.dumps(job, indent=2))


def cmd_pause(args: argparse.Namespace) -> None:
	print(json.dumps(pause_job(args.job_id), indent=2))


def cmd_resume(args: argparse.Namespace) -> None:
	print(json.dumps(resume_job(args.job_id), indent=2))


def cmd_cancel(args: argparse.Namespace) -> None:
	print(json.dumps(cancel_job(args.job_id), indent=2))


def cmd_status(args: argparse.Namespace) -> None:
	if args.job_id:
		print(json.dumps(refresh_status(args.job_id), indent=2))
	else:
		print(json.dumps(list_jobs(), indent=2))


def cmd_schedule(args: argparse.Namespace) -> None:
	print(json.dumps(schedule_job(args.job_id, args.when), indent=2))


def cmd_run_now(args: argparse.Namespace) -> None:
	"""Create + start in one shot (default Frame-agent overnight recipe)."""
	job = create_job(
		name=args.name,
		iters=args.iters,
		data_dir=args.data_dir,
		adapter_path=args.adapter_path,
		model=args.model,
		cpu_limit=args.cpu_limit,
		schedule_at=None,
	)
	if args.schedule:
		job = schedule_job(job["id"], args.schedule)
		print(json.dumps(job, indent=2))
		return
	job = start_job(job["id"], force_cpu=args.force_cpu)
	print(json.dumps(job, indent=2))


def main() -> None:
	parser = argparse.ArgumentParser(description="Frame LoRA training manager")
	sub = parser.add_subparsers(dest="cmd", required=True)

	p = sub.add_parser("probe", help="Detect MLX / Apple Silicon")
	p.set_defaults(func=cmd_probe)

	p = sub.add_parser("estimate", help="Estimate duration and RAM")
	p.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
	p.add_argument("--iters", type=int, default=1200)
	p.add_argument("--backend", choices=["mlx_gpu", "cpu"], default=None)
	p.set_defaults(func=cmd_estimate)

	p = sub.add_parser("create", help="Create a draft/scheduled job")
	p.add_argument("--name", default="Frame agent LoRA v1")
	p.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
	p.add_argument("--adapter-path", type=Path, default=DEFAULT_ADAPTER)
	p.add_argument("--model", default=DEFAULT_MODEL)
	p.add_argument("--iters", type=int, default=1200)
	p.add_argument("--cpu-limit", action="store_true")
	p.add_argument("--schedule", default=None, help="overnight | +8h | ISO time")
	p.set_defaults(func=cmd_create)

	p = sub.add_parser("start", help="Start a job now")
	p.add_argument("--job-id", required=True)
	p.add_argument("--force-cpu", action="store_true")
	p.set_defaults(func=cmd_start)

	p = sub.add_parser("pause", help="Pause (SIGSTOP)")
	p.add_argument("--job-id", required=True)
	p.set_defaults(func=cmd_pause)

	p = sub.add_parser("resume", help="Resume (SIGCONT)")
	p.add_argument("--job-id", required=True)
	p.set_defaults(func=cmd_resume)

	p = sub.add_parser("cancel", help="Cancel job")
	p.add_argument("--job-id", required=True)
	p.set_defaults(func=cmd_cancel)

	p = sub.add_parser("status", help="Job status")
	p.add_argument("--job-id", default=None)
	p.set_defaults(func=cmd_status)

	p = sub.add_parser("schedule", help="Schedule start")
	p.add_argument("--job-id", required=True)
	p.add_argument("--when", required=True)
	p.set_defaults(func=cmd_schedule)

	p = sub.add_parser("run-now", help="Create and start (or schedule) in one step")
	p.add_argument("--name", default="Frame agent LoRA v1")
	p.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
	p.add_argument("--adapter-path", type=Path, default=DEFAULT_ADAPTER)
	p.add_argument("--model", default=DEFAULT_MODEL)
	p.add_argument("--iters", type=int, default=1200)
	p.add_argument("--cpu-limit", action="store_true")
	p.add_argument("--force-cpu", action="store_true")
	p.add_argument("--schedule", default=None)
	p.set_defaults(func=cmd_run_now)

	p = sub.add_parser("scheduler-wait", help=argparse.SUPPRESS)
	p.add_argument("--job-id", required=True)
	p.add_argument("--delay", type=int, required=True)
	p.set_defaults(func=lambda a: scheduler_wait(a.job_id, a.delay))

	args = parser.parse_args()
	args.func(args)


if __name__ == "__main__":
	main()
