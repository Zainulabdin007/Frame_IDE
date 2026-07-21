# Frame Model Security & Trust

Offline integrity for user-owned model packages. Frame verifies **local files only** — it never downloads weights, never loads inference, and never executes package contents.

---

## Offline trust model

```
User-owned weights (local disk)
        │
        ▼
  .frame-model package
        │
        ├─ Read Manifest
        ├─ Verify Checksums (SHA-256 recompute)
        ├─ Verify Signature metadata
        ├─ Install (copy into .frame/models/imported/)
        ├─ Register (registry.json + trustStatus)
        └─ Activate (config only — no weight load)
```

| Principle | Behavior |
|-----------|----------|
| **User ownership** | You supply and keep model weights |
| **No network** | Import / verify / register never call cloud APIs |
| **No execution** | Packages are data; Frame does not run scripts or load backends |
| **Integrity first** | Checksums are recomputed from files on disk |

---

## Why Frame does not download weights

1. **Privacy** — code and models stay on the machine.
2. **Supply chain** — silent CDN pulls are a trust risk Frame refuses by design.
3. **Licensing** — users decide which weights they are allowed to use.
4. **Determinism** — installs are reproducible from a local package the user controls.

Packaging and import tools only manage metadata, stubs, and copies of files you already have. See [FRAME_MODEL_PACKAGING.md](./FRAME_MODEL_PACKAGING.md) and [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md).

---

## Checksum verification

`IFrameModelVerifierService.verifyChecksums`:

1. Reads each path listed in `checksums.json` under the package root.
2. Recomputes **SHA-256** via Web Crypto (local).
3. Compares to the expected digest (`sha256:<hex>`).
4. Reports **match**, **mismatch**, **missing**, or **placeholder**.

Placeholders such as `sha256:pending-user-weights` are allowed for stub packages and yield trust status **UNVERIFIED** (not INVALID).

Mismatches or missing real-hash files → **INVALID**.

After install, Frame re-runs checksum verification on the copy under `.frame/models/imported/<id>/`.

---

## Signature verification (Ed25519)

`verifyPackageSignature()` verifies `signature.json` (or manifest signature metadata) offline using a locally imported public key under `.frame/models/keys/`.

| Status | Meaning |
|--------|---------|
| **UNSIGNED** | No signature / algorithm `none` |
| **VERIFIED** | Ed25519 signature matches manifest + checksums |
| **INVALID** | Bad signature or malformed crypto material |
| **UNKNOWN_KEY** | `keyId` not present in local key store |
| **UNSUPPORTED** | Non-Ed25519 algorithm (e.g. rsa-pss-sha256) |

Full design: **[FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)**.

---

## Trust status (registry)

Stored on each model in `.frame/models/registry.json`:

| `trustStatus` | UI |
|---------------|-----|
| `UNVERIFIED` | ⚠ No signature (or key unavailable) |
| `CHECKSUM_VALID` | ✓ Checksum verified |
| `SIGNATURE_VALID` | ✓ Ed25519 verified |
| `INVALID` | ✗ Integrity failed |

Example:

```json
{
  "id": "qwen-coder-7b-q4",
  "installed": true,
  "localPath": ".frame/models/imported/qwen-coder-7b-q4",
  "checksum": "sha256:…",
  "trustStatus": "SIGNATURE_VALID",
  "signature": {
    "algorithm": "ed25519",
    "keyId": "frame-official-dev",
    "verifyStatus": "VERIFIED"
  }
}
```

---

## Import flow

```
Import
  → Read Manifest
  → Verify Checksums
  → Verify Signature (Ed25519 + local keys)
  → Install
  → Register
  → Activate
```

Activate updates runtime config (`activeModelId`) only. It does **not** load llama.cpp, MLX, or any model runtime.

---

## Related

- [FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)
- [FRAME_MODEL_PACKAGING.md](./FRAME_MODEL_PACKAGING.md)
- [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md)
- [FRAME_MODEL_INSTALLATION.md](./FRAME_MODEL_INSTALLATION.md)
- Code: `frameModelKeyStore.ts`, `frameModelEd25519Verifier.ts`, `frameModelSignatureService.ts`
