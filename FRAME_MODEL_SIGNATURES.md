# Frame Model Signatures (Ed25519)

Offline package authenticity for Frame model packages.

Frame verifies **local files only**. It never downloads keys, models, or trust metadata from the network.

---

## Philosophy

| Principle | Meaning |
|-----------|---------|
| Users own weights | Model bytes stay under user control |
| Users own keys | Public keys are imported locally; private keys never ship with Frame |
| Offline verification | Signing and verifying use disk + crypto APIs only |
| No remote trust | Frame does not fetch CRLs, key servers, or “official” key bundles |

---

## What gets signed

Ed25519 signatures cover the **integrity of the package metadata pair**:

1. `manifest.json` (on-disk bytes)
2. `checksums.json` (on-disk bytes)

Canonical payload (UTF-8):

```text
frame-model-sig-v1
sha256:<hex of manifest.json>
sha256:<hex of checksums.json>
```

The signature is stored in **`signature.json`** next to those files so signing does **not** mutate `manifest.json` or `checksums.json` after checksums were computed.

```
frame-model/
  manifest.json
  checksums.json
  signature.json      ← Ed25519 signatureValue + keyId
  model/
    …
```

---

## Checksum vs signature

| | Checksum | Signature |
|---|----------|-----------|
| Purpose | Detect accidental corruption / wrong files | Prove a known key signed this metadata |
| Algorithm | SHA-256 of listed package files | Ed25519 over the payload above |
| Trust | “Bytes match what the package claimed” | “Someone holding `keyId` attested those claims” |
| Without the other | Signature alone does not hash weight files; checksums alone do not prove authorship |

Frame trust status:

- `CHECKSUM_VALID` — local file hashes match; package may still be unsigned
- `SIGNATURE_VALID` — Ed25519 verified with a **locally imported** public key
- `UNVERIFIED` — unsigned, or signer key not present locally
- `INVALID` — checksum mismatch or bad signature

---

## Public key storage

Keys live under the workspace:

```text
.frame/models/keys/<keyId>.json
```

Example:

```json
{
  "keyId": "frame-official-dev",
  "algorithm": "ed25519",
  "owner": "local",
  "publicKey": "<base64 SPKI DER>",
  "createdAt": 1710000000000
}
```

IDE APIs (`IFrameModelKeyStore`):

- `importKey()` / `removeKey()` / `listKeys()` / `getKey(keyId)`

**Never store private keys here.** Frame only persists public keys.

---

## Verification flow

```text
Read manifest + signature.json
        ↓
Locate keyId in .frame/models/keys/
        ↓
Rebuild payload from on-disk manifest + checksums
        ↓
Ed25519 verify(signatureValue, publicKey)
        ↓
VERIFIED | INVALID | UNKNOWN_KEY | UNSIGNED
```

Crypto:

- **Packager** (`frame-model-packager sign`): Node.js `crypto` (Ed25519)
- **IDE** (`frameModelEd25519Verifier.ts`): Web Crypto Ed25519 (same SPKI public keys)

No cloud APIs. No key download. No model execution.

---

## Packager: generate keys and sign

```bash
# Generate a local key pair (private key stays on your machine)
node tools/frame-model-packager/bin/frame-model-packager.mjs gen-keypair \
  --key-id my-lab \
  --out /tmp/frame-keys

# Sign an existing package (writes signature.json)
node tools/frame-model-packager/bin/frame-model-packager.mjs sign \
  --package /tmp/my-pkg \
  --private-key /tmp/frame-keys/my-lab.private.pem \
  --key-id my-lab \
  --signer "My Lab"
```

Import `my-lab.public.json` into `.frame/models/keys/` (copy the file, or use the key store API). Keep `*.private.pem` out of git.

---

## Registry fields

```json
{
  "id": "qwen-coder-7b-q4",
  "trustStatus": "SIGNATURE_VALID",
  "signature": {
    "algorithm": "ed25519",
    "keyId": "frame-official-dev",
    "verifyStatus": "VERIFIED"
  }
}
```

---

## Models panel labels

| State | Label |
|-------|--------|
| Unsigned package | ⚠ No signature |
| Unknown signer (key not imported) | ⚠ Key unavailable |
| Verified package | ✓ Ed25519 verified |

---

## Why Frame never downloads trust information

Remote trust would mean Frame decides whose keys are “official.” That conflicts with local-first ownership: you choose which public keys to import, and you choose which signed packages to accept. Offline verification keeps the trust boundary on the user’s disk.

---

## Related

- [FRAME_MODEL_SECURITY.md](./FRAME_MODEL_SECURITY.md) — checksums and trust layer
- [FRAME_MODEL_PACKAGING.md](./FRAME_MODEL_PACKAGING.md) — package format and CLI
- [FRAME_MODEL_IMPORT.md](./FRAME_MODEL_IMPORT.md) — offline import
- IDE: `vscode/src/vs/workbench/contrib/frameAI/models/frameModelKeyStore.ts`
- IDE: `vscode/src/vs/workbench/contrib/frameAI/models/frameModelEd25519Verifier.ts`
- CLI: `tools/frame-model-packager/lib/sign.mjs`
