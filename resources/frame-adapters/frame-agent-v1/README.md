# frame-agent-v1 (packaged)

Place `adapters.gguf` here for release builds.

Frame resolves this path at runtime (see `FRAME_BUILTIN_ADAPTER.md`).
Do **not** commit large weight files to git.

```bash
python tools/frame-lora-train/scripts/install_builtin_gguf.py /path/to/adapters.gguf
```
