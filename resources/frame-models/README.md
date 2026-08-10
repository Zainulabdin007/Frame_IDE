# Frame default fused model (release)

Place `frame-agent-v1-fused-q4_k_m.gguf` here for packaged builds.

```bash
python tools/frame-lora-train/scripts/install_fused_base_model.py
```

One-click website zip (IDE + this GGUF for Windows/Linux):

```bash
./scripts/package-efficient-release.sh --platform win64
./scripts/package-efficient-release.sh --platform linux64
```

Frame auto-loads `resources/frame-models/frame-agent-v1-fused-q4_k_m.gguf` on first launch when no `modelPath` is set.

Do not commit the GGUF to git (~4.4 GB).
