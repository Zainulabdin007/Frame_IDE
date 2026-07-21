# Frame Model Management

Catalog and registry for Frame product editions — **metadata only**.

**Hard rules:** no model files shipped, no downloads, no cloud APIs, no weight load in this layer.

## Three Frame editions

| Edition | Profile id | Precision | Approx. RAM | Approx. disk |
| --- | --- | --- | --- | --- |
| **Frame Efficient** | `frame-efficient-qwen7b` | 4-bit | ~6 GB | ~4 GB |
| **Frame Professional** | `frame-professional-qwen7b` | 8-bit | ~10 GB | ~7 GB |
| **Frame Maximum** | `frame-maximum-qwen7b` | FP16 | ~16 GB | ~14 GB |

All profiles target architecture label `qwen2.5-coder-7b`. That is a **descriptor**, not a bundled or fetched weight file. Users own any future on-disk checkpoints.

## Architecture

```
Frame AI UI (Models)
        │
        ▼
IFrameModelService
        │
        ├─ FRAME_MODEL_PROFILES (built-in catalog)
        └─ .frame/models/registry.json (installed + active)
                │
                ▼
IFrameRuntimeService.getSelectedModelMetadata()
        │
        ▼
generate() logs profile — does NOT load weights
```

## `IFrameModelService`

| Method | Role |
| --- | --- |
| `listProfiles` | Efficient / Professional / Maximum |
| `registerModel` | Mark profile installed in registry (no download) |
| `listInstalledModels` / `listModels` | Registry + catalog flags |
| `selectActiveModel` | Set active profile metadata |
| `setModelLocalPath` | Optional user path string |
| `unregisterModel` | Drop from registry |
| `checkCompatibility` | Runtime kind / memory gates |

## Registry format

Path: `<workspace>/.frame/models/registry.json`

```json
{
  "version": 1,
  "activeModelId": "frame-efficient-qwen7b",
  "updatedAt": 0,
  "models": [
    {
      "id": "frame-efficient-qwen7b",
      "installed": true,
      "localPath": null,
      "registeredAt": 0,
      "updatedAt": 0
    }
  ]
}
```

## Metadata fields

Each profile / descriptor exposes:

- `id`, `name`, `displayName`
- `edition`, `precision`, `quantization`
- `memoryRequirementGb`, `storageSizeGb`
- `architecture`
- `compatibleRuntimes` (`llamacpp`, `mlx`, `stub`)
- `installed`, `active`, `localPath` (descriptor only)

## Runtime integration

`IFrameRuntimeStatus.selectedModel` and `getSelectedModelMetadata()` expose the active profile.

`generate()` receives that metadata for logging / future prompt templates. **It does not mmap or load** the model.

## UI

Frame AI sidebar **Models**:

- Active model summary
- Installed models
- Frame editions catalog
- Per-card: precision, memory/storage requirements, compatibility YES/NO
- Actions: Register · Select · Unregister

## Privacy

| Guarantee | Behavior |
| --- | --- |
| Local only | Registry under `.frame/models/` |
| No download | Register never fetches weights |
| No cloud | No model marketplaces or APIs |
| User ownership | Any future `localPath` is user-supplied |

## Future model loading

When a native runtime is wired:

1. User registers an edition + sets `localPath` to their weights  
2. User enables runtime (`mlx` / `llamacpp`) with matching path  
3. Runtime loads **that** path only  
4. Still no silent download from Frame core  

## Source files

| Path | Role |
| --- | --- |
| `models/frameModels.ts` | `IFrameModelService` |
| `models/frameModelService.ts` | Implementation |
| `models/frameModelProfiles.ts` | Edition catalog |
| `common/models.ts` | Types |
| `browser/frameAIViewPane.ts` | Models section |
| `runtime/frameRuntimeService.ts` | Selected model metadata |
