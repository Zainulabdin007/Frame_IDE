# Frame Model Security & Trust

Offline integrity for user-owned model packages. Frame verifies **local files only** — it never downloads weights and never executes package scripts. Runtime loading of a user-selected GGUF happens only through the isolated model worker after config/trust checks.

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
        ├─ Verify Signature (Ed25519 + local keys)
        ├─ Install (copy into .frame/models/imported/)
        ├─ Register (registry.json + trustStatus)
        └─ Activate (writes runtime config; may eager-load when enabled + modelPath)
```

| Principle | Behavior |
|-----------|----------|
| **User ownership** | You supply and keep model weights |
| **No network** | Import / verify / register never call cloud APIs |
| **No package execution** | Packages are data; Frame does not run scripts from the package |
| **Integrity first** | Checksums are recomputed from files on disk |
| **Trust gate** | `INVALID` never loads; `UNVERIFIED` requires `allowUnverifiedModels: true` |

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
| **UNSUPPORTED** | Non-Ed25519 algorithm, or sync `verify()` (metadata-only — not crypto proof) |

Full design: **[FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)**.

> Sync `signatureService.verify()` must **not** be treated as cryptographic proof. Only `verifyPackageSignature()` verifies digests.

---

## Trust status (registry)

Stored on each model in `.frame/models/registry.json`:

| `trustStatus` | Load behavior |
|---------------|---------------|
| `UNVERIFIED` | Blocked **when package checksum/signature metadata exists**, unless `allowUnverifiedModels: true`. Plain catalog + `modelPath` entries are allowed. |
| `CHECKSUM_VALID` | Allowed |
| `SIGNATURE_VALID` | Allowed |
| `INVALID` | **Always blocked** |

Raw `modelPath` / `FRAME_MODEL_PATH` without package trust metadata is allowed (explicit local file ownership).

Example runtime override:

```json
{
  "allowUnverifiedModels": true
}
```

---

## Adapter & path safety

- Adapter `weightFile` is **basename-only** under `.frame/adapters/<id>/` — `../` escapes are rejected.
- Workspace tools reject absolute paths and `..`; reads are size-capped.
- Model worker refuses non-absolute weight paths and non-`.gguf` / `.safetensors` adapters.

---

## Local data at rest

Frame AI does **not** send prompts to the cloud. It **does** write truncated chat turns and redacted tool/generation diagnostics under `.frame/`. That tree is covered by `.frame/.gitignore` (`*`) so it is not committed by default.

---

## Import flow

```
Import
  → Read Manifest
  → Verify Checksums
  → Verify Signature (Ed25519 + local keys)
  → Install
  → Register
  → Activate (config; eager load when enabled + trusted path)
```

---

## Related

- [FRAME_MODEL_SIGNATURES.md](./FRAME_MODEL_SIGNATURES.md)
- [FRAME_MODEL_PACKAGING.md](./FRAME_MODEL_PACKAGING.md)
- [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md)
- [FRAME_MODEL_INSTALLATION.md](./FRAME_MODEL_INSTALLATION.md)
- Code: `frameModelKeyStore.ts`, `frameModelEd25519Verifier.ts`, `frameModelSignatureService.ts`, `frameRuntimeService.ts`
