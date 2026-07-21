# Frame Model Offline Import

Users own their model weights. Frame only manages **local** package files — it never downloads models, never calls network APIs, and never loads inference from this path.

---

## Package format (`.frame-model`)

An offline Frame model package is a folder (or an unpacked archive) with this layout:

```
frame-model/
  manifest.json
  checksums.json
  model/
    weights.placeholder   # or real user-owned weight files
```

You may also select the parent folder that contains `frame-model/`.

Packages are typically created with `tools/frame-model-packager/` — see [FRAME_MODEL_PACKAGING.md](./FRAME_MODEL_PACKAGING.md).

### `manifest.json`

```json
{
  "format": "frame-model",
  "formatVersion": 1,
  "id": "qwen-coder-7b-q4",
  "edition": "efficient",
  "modelName": "Frame Efficient",
  "architecture": "qwen2.5-coder-7b",
  "precision": "4-bit",
  "quantization": "4-bit",
  "packageVersion": "1.0.0",
  "storageSizeGb": 4,
  "memoryRequirementGb": 6,
  "weightFiles": ["weights.placeholder"],
  "description": "User-owned Efficient package"
}
```

`id` must match a Frame catalog profile (`qwen-coder-7b-q4` / `qwen-coder-7b-q8` / `qwen-coder-7b-fp16`).

### `checksums.json`

```json
{
  "version": 1,
  "files": {
    "weights.placeholder": "sha256:pending-user-weights",
    "manifest.json": "sha256:pending-user-weights"
  }
}
```

Placeholder checksums are allowed. Real hashing of weight tensors is deferred until Frame verifies user-provided files offline.

### JSON envelope (optional)

A `.frame-model` **file** may be a JSON envelope (for tooling / tests):

```json
{
  "format": "frame-model",
  "manifest": { "...": "..." },
  "checksums": { "version": 1, "files": {} },
  "packageRoot": "/absolute/path/to/extracted/frame-model"
}
```

Compressed binary `.frame-model` zips are **not** auto-extracted. Unpack offline, then import the folder.

---

## Offline installation flow

```
Import → Validate → Install → Activate
```

| Step | Behavior |
|------|----------|
| **Import** | User picks a local folder or `.frame-model` JSON envelope |
| **Validate** | `IFrameModelVerifierService` checks manifest, architecture, checksums, disk estimate |
| **Install** | Copy into `.frame/models/imported/<id>/frame-model/` and update registry |
| **Activate** | Set `activeModelId` in runtime config — **does not load weights** |

Service: `IFrameModelImportService`  
Reader: `FrameModelPackageReader`  
Verifier: `IFrameModelVerifierService`

---

## Registry

After a successful import, `.frame/models/registry.json` includes:

```json
{
  "id": "qwen-coder-7b-q4",
  "installed": true,
  "localPath": ".frame/models/imported/qwen-coder-7b-q4",
  "packageVersion": "1.0.0",
  "checksum": "sha256:pending-user-weights"
}
```

---

## Adapter compatibility

When activating a model, Frame checks registered adapters. If an adapter’s precision (from metadata or inferred from `baseModelId`) differs from the model precision, the Models UI shows a warning. Activation still proceeds — this is advisory only.

---

## Security

- **No network** on the import path.
- Packages are treated as **data**, not executables — Frame does not run scripts from packages.
- Path traversal (`..`) in weight file lists is rejected during probe.
- Checksums must eventually be real hashes for production weight trust; placeholders are explicitly labeled.
- Imported files stay under the workspace `.frame/` tree (local-only).

---

## Future website downloads

A future Frame website may offer **manual** package downloads. The IDE will still:

1. Require the user to obtain the file outside the IDE (or via an explicit offline import).
2. Import only through this local package path.
3. Never silently fetch weights from the cloud inside the workbench.

---

## Related

- [FRAME_MODEL_INSTALLATION.md](./FRAME_MODEL_INSTALLATION.md) — simulated lifecycle
- [FRAME_MODEL_MANAGEMENT.md](./FRAME_MODEL_MANAGEMENT.md) — catalog / registry
- [FRAME_HARDWARE_COMPATIBILITY.md](./FRAME_HARDWARE_COMPATIBILITY.md)
