# Frame Hardware Compatibility

Local hardware detection and model-tier compatibility for Frame editions.

**Hard rules:** no model downloads, no weight load, no cloud APIs, no inference.

## Purpose

Help users pick a Frame edition that fits their machine before any future local installer runs.

```
Hardware detection
        │
        ▼
IFrameHardwareProfile
        │
        ▼
IFrameModelCompatibilityService
        │
        ▼
compatible | warning | unsupported
        │
        ▼
Models UI + .frame/models/registry.json
```

## Hardware detection

`IFrameHardwareService` (`frameAI/hardware/`)

Detects (best-effort):

| Field | Source |
| --- | --- |
| OS / label | Platform (`Apple Silicon`, macOS, Windows, Linux) |
| Architecture | Native `arch` (`arm64`, `x64`, …) |
| RAM (GB) | Native `getOSStatistics().totalmem` or `navigator.deviceMemory` |
| Free RAM | Native freemem when available |
| GPU | Apple Silicon unified memory · WebGPU adapter name when present |
| GPU memory | Unified = system RAM on Apple Silicon; otherwise unknown |

Example profile:

```json
{
  "ramGB": 64,
  "architecture": "arm64",
  "gpuMemoryGB": 64,
  "osLabel": "Apple Silicon",
  "appleSilicon": true,
  "gpuAvailable": true
}
```

## Model tiers

| Edition | Model id | Precision | RAM floor |
| --- | --- | --- | --- |
| Frame Efficient | `qwen-coder-7b-q4` | 4-bit | ~6 GB |
| Frame Professional | `qwen-coder-7b-q8` | 8-bit | ~10 GB |
| Frame Maximum | `qwen-coder-7b-fp16` | FP16 | ~16 GB |

## Compatibility rules

`IFrameModelCompatibilityService.evaluate(model, hardware)`:

| Status | Meaning |
| --- | --- |
| **compatible** | RAM ≥ requirement + headroom |
| **warning** | RAM meets floor but little headroom, or FP16 without GPU / tight VRAM |
| **unsupported** | RAM &lt; requirement |

Headroom heuristics: Efficient +2 GB · Professional +4 GB · Maximum +8 GB.

FP16 also warns without GPU / Apple Silicon unified memory.

## Registry

`.frame/models/registry.json` (version 2) stores:

- `installed`
- `localPath` (user path only)
- `compatibilityStatus` / `compatibilityMessage`
- `activeModelId`

## Runtime selection by model id

Primary selection is **model id**, not a raw path:

`.frame/config/runtime.json`:

```json
{
  "runtime": "stub",
  "activeModelId": "qwen-coder-7b-q4",
  "modelPath": null,
  "enabled": false
}
```

Effective weights path (when set later) resolves from the selected model’s `localPath`, with legacy `modelPath` as fallback. **Nothing is loaded** in this milestone.

## Models UI

Shows:

```
Hardware
  Apple Silicon
  64 GB Memory

Models
  Frame Efficient
    ✓ Installed
    ✓ Compatible

  Frame Professional
    ✓ Compatible

  Frame Maximum
    ⚠ Requires more memory   (example on low-RAM machines)
```

## Supported hardware (guidance)

| Class | Notes |
| --- | --- |
| Apple Silicon | Preferred for MLX later; unified memory helps Maximum |
| x64 + discrete GPU | llama.cpp later; GPU memory informs warnings |
| Low RAM (&lt; 8 GB) | Efficient only; Professional/Maximum unsupported or warning |

## Future installer flow

1. Detect hardware  
2. Recommend edition (Efficient / Professional / Maximum)  
3. User confirms and supplies / installs **their** weights  
4. Register `localPath` + set `activeModelId`  
5. Enable runtime backend — still no silent download from Frame core  

## Source files

| Path | Role |
| --- | --- |
| `hardware/frameHardware.ts` | `IFrameHardwareService` |
| `hardware/frameHardwareService.ts` | Detection |
| `hardware/frameModelCompatibility.ts` | Compatibility contract |
| `hardware/frameModelCompatibilityService.ts` | Rules |
| `models/frameModelService.ts` | Registry + status persistence |
| `runtime/frameRuntimeService.ts` | `activeModelId` selection |
| `browser/frameAIViewPane.ts` | Hardware + Models UI |
