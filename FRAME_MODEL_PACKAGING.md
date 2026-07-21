# Frame Model Packaging

Developer tooling to **create and validate** offline `.frame-model` packages.

Frame never downloads models, never bundles production weights in this repo, and never loads inference from the packager.

---

## Package format

```
frame-model/
  manifest.json
  checksums.json
  model/
    weights.placeholder    # stub only unless you replace with user-owned files
    source-ref.json        # optional — path + checksum of local source (not copied)
```

Optional sibling JSON envelope: `<id>.frame-model` (metadata pointer for tooling; not a zip).

### `formatVersion`

| Version | Notes |
|---------|--------|
| **1** | Original import manifest (id, edition, architecture, quantization, …) |
| **2** (current) | Adds `modelFamily`, `parameterCount`, `signature` placeholder; prefers `model/` weight paths |

IDE migration: `frameModelMigration.ts` upgrades v1 → v2 in memory during validate/import.

### Manifest fields (v2)

| Field | Purpose |
|-------|---------|
| `id` | Catalog model id (e.g. `qwen-coder-7b-q4`) |
| `modelFamily` | Family label (e.g. `qwen2.5-coder`) |
| `parameterCount` | e.g. `7B` |
| `quantization` / `precision` | e.g. `4-bit` |
| `compatibleRuntimes` | `stub`, `llamacpp`, `mlx` |
| `memoryRequirementGb` | Required memory |
| `packageVersion` | Semver-ish package release |
| `formatVersion` | Schema version |
| `signature` | Placeholder only (see below) |

---

## Developer workflow

### 1. Write metadata

See `tools/frame-model-packager/examples/metadata.*.json`.

### 2. Build a package (offline)

```bash
node tools/frame-model-packager/bin/frame-model-packager.mjs build \
  --metadata tools/frame-model-packager/examples/metadata.efficient.json \
  --out /tmp/frame-efficient-pkg
```

Optional local model path (checksum + source-ref only — **weights are not copied**):

```bash
node tools/frame-model-packager/bin/frame-model-packager.mjs build \
  --metadata tools/frame-model-packager/examples/metadata.efficient.json \
  --model /path/to/your/local/weights.gguf \
  --out /tmp/frame-efficient-pkg
```

### 3. Generate a checksum for a local file

```bash
node tools/frame-model-packager/bin/frame-model-packager.mjs checksum \
  --file /path/to/local/file
```

### 4. Validate

```bash
node tools/frame-model-packager/bin/frame-model-packager.mjs validate \
  --package /tmp/frame-efficient-pkg
```

### 5. Import in Frame IDE

Use **Models → Import Model** and select the `frame-model/` folder (or parent). See [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md).

---

## Checksums

- Algorithm: **SHA-256** (`sha256:<hex>`)
- Scope: local files only (model stubs, `manifest.json`, optional `source-ref.json`)
- No network verification
- Placeholder `sha256:pending-user-weights` is allowed when real weights are absent

---

## Security model

| Rule | Behavior |
|------|----------|
| No network | Packager and IDE import paths do not fetch remote models |
| No execution | Packages are data; Frame does not run package scripts |
| No silent weight bundling | Default build writes stubs, not GGUF/safetensors copies |
| User-owned weights | Replace `model/weights.placeholder` with your files before distribution if you choose |
| Path safety | Import probes reject `..` in weight paths |

---

## Signature (Ed25519)

Offline Ed25519 signing is supported. See **[FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)**.

```bash
# Key pair (private key never shipped by Frame)
node tools/frame-model-packager/bin/frame-model-packager.mjs gen-keypair \
  --key-id my-lab --out /tmp/frame-keys

# Sign package → writes frame-model/signature.json
node tools/frame-model-packager/bin/frame-model-packager.mjs sign \
  --package /tmp/frame-efficient-pkg \
  --private-key /tmp/frame-keys/my-lab.private.pem \
  --key-id my-lab
```

Import `*.public.json` into `.frame/models/keys/` for IDE verification.

Unsigned packages remain valid to import; trust shows **⚠ No signature**.

---

## Related

- [FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)
- [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md)
- [FRAME_MODEL_INSTALLATION.md](./FRAME_MODEL_INSTALLATION.md)
- [FRAME_MODEL_SECURITY.md](./FRAME_MODEL_SECURITY.md)
- Tooling: `tools/frame-model-packager/`
- IDE migration: `vscode/src/vs/workbench/contrib/frameAI/models/frameModelMigration.ts`
