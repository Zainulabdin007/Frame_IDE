# Frame Model Installation Architecture

Lifecycle and package management for Frame editions (**Efficient**, **Professional**, **Maximum**). This layer tracks install state and registry metadata only.

**Frame never downloads model weights, never loads inference, and never calls cloud APIs from this path.**

---

## Scope

| In scope | Out of scope |
|----------|--------------|
| Package metadata catalog | Real weight downloads |
| Simulated install lifecycle | Hosting / CDN |
| Registry updates (`.frame/models/`) | llama.cpp / MLX load |
| Hardware-based edition recommendation | External APIs |
| Marker files (`PACKAGE.frame`) | Checksum of real GGUF/safetensors |

---

## Package catalog

Defined in `vscode/src/vs/workbench/contrib/frameAI/models/frameModelPackage.ts`, backed by `FRAME_MODEL_PROFILES`.

| Edition | Model id | Quantization | ~Storage | ~RAM |
|---------|----------|--------------|----------|------|
| Frame Efficient | `qwen-coder-7b-q4` | 4-bit | 4 GB | 6 GB |
| Frame Professional | `qwen-coder-7b-q8` | 8-bit | 7 GB | 10 GB |
| Frame Maximum | `qwen-coder-7b-fp16` | FP16 | 14 GB | 16 GB |

Each `IFrameModelPackage` includes:

- `id`, `edition`, `modelName`, `quantization`
- `storageSizeGb`, `memoryRequirementGb`
- `status`, `localPath`, `checksumPlaceholder`

Checksum is always a placeholder (`sha256:pending-user-weights`) until a future offline installer verifies real files.

---

## Package lifecycle

```
available → downloading → installed → verified → active
                ↘ failed
```

| State | Meaning |
|-------|---------|
| **available** | Catalog entry; not registered |
| **downloading** | Simulated progress only (timers) — no network |
| **installed** | Marker written + registry entry |
| **verified** | Marker + registry confirmed; checksum placeholder accepted |
| **active** | Selected as `activeModelId` in runtime config |
| **failed** | Simulation or write error |

Service: `IFrameModelInstallerService` (`frameModelInstallerService.ts`).

### Operations

- **installPackage(id)** — advances simulated states, writes `.frame/models/packages/<id>/PACKAGE.frame`, registers via `IFrameModelService`
- **removePackage(id)** — deletes marker dir, unregisters
- **verifyInstallation(id)** — checks marker + registry (not weight hashes)
- **activatePackage(id)** — verify then set runtime `activeModelId`

---

## Recommendation

`recommendBestEdition()` uses:

1. Detected hardware (RAM, GPU memory, architecture) via `IFrameHardwareService`
2. Compatibility verdicts via `IFrameModelCompatibilityService`

Prefer the highest edition with status `compatible`, else highest with `warning`, else **Efficient**.

Returns `IFrameEditionRecommendation`: edition, model id, display name, reason, hardware summary.

---

## Future download flow (not implemented)

When Frame ships an offline installer, the intended flow is:

1. User chooses an edition (or accepts recommendation).
2. Installer resolves a **user-supplied** or **Frame-bundled offline** package path — never a silent cloud pull from the IDE.
3. Copy/extract into a workspace- or user-scoped models directory.
4. Compute real checksum; replace `checksumPlaceholder`.
5. Transition `installed` → `verified` only if checksum and layout match the package manifest.
6. Runtime backends (MLX / llama.cpp) may then **optionally** load the verified path — still local-only.

Until then, Install only creates a JSON marker stating that no weights were fetched.

---

## Verification

Current verification checks:

- Package marker file exists under `.frame/models/packages/<id>/`
- Model is registered in `.frame/models/registry.json`
- Active flag when `activeModelId` matches

It does **not** open weight files or validate tensor layouts.

---

## Security considerations

- **No network** in the installer path — prevents supply-chain fetch from IDE sessions.
- **Markers are not credentials**; they must never be mistaken for signed weight attestations.
- Future real installs should: verify checksums, reject path traversal, refuse remote URLs unless explicitly opted into a separate offline import tool.
- Registry and markers live under the workspace `.frame/` tree — treat as local config, not secrets, but do not sync weight paths to cloud telemetry.
- Activation updates config only; it must never execute downloaded binaries.

---

## UI

Frame AI → **Models** shows:

1. Hardware
2. Recommended Edition
3. Available Models (packages)
4. Install / Activate / Remove
5. Status (lifecycle state + compatibility)

---

## Related docs

- [FRAME_MODEL_MANAGEMENT.md](./FRAME_MODEL_MANAGEMENT.md)
- [FRAME_HARDWARE_COMPATIBILITY.md](./FRAME_HARDWARE_COMPATIBILITY.md)
- [FRAME_LOCAL_RUNTIME_ARCHITECTURE.md](./FRAME_LOCAL_RUNTIME_ARCHITECTURE.md)
