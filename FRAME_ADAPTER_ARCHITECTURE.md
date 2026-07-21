# Frame Adapter Management Architecture

Lifecycle registry for **future** LoRA adapters. Metadata and placeholder weight files only.

**This milestone does not:** train LoRAs, download weights, load models, call the cloud, or integrate Qwen.

**Code:** `vscode/src/vs/workbench/contrib/frameAI/adapters/`  
**Types:** `common/models.ts` (`IFrameAdapterDescriptor`, `IFrameAdapterMetadata`, …)  
**Service:** `IFrameAdapterService` → `FrameAdapterService`

---

## 1. Goals

Manage adapters that will eventually specialize a local base model by:

| Scope | Example id | Purpose |
| --- | --- | --- |
| **Language** | `python` (`LoRA.python`) | Language idioms / APIs |
| **Project** | `project-python-api` | Repo-specific patterns |
| **User** | `zain-python-style` | Personal preferences / style |

The registry is the control plane: register, discover, load metadata, activate/disable, remove, export, import, and compatibility-check — without materializing real weights.

---

## 2. Adapter hierarchy

```
Base local model (FUTURE — not present)
    │
    ├─ Language adapter   (optional, one active per language match)
    ├─ Project adapter    (optional, workspace-scoped)
    └─ User adapter       (optional, preference/style)
```

Selection for inference context (Context Engine):

1. Discover all adapters under `.frame/adapters/`
2. Filter `state === active`
3. Pick by `scope` (and language for language adapters)
4. Expose `available`, `active`, `languageAdapter`, `projectAdapter`, `userAdapter` on `IFrameAdapterContext`

Runtime load order (when a model exists later): base → language → project → user. Today only metadata is selected into `IFrameInferenceContext`.

---

## 3. Storage format

Workspace-local, no cloud:

```
.frame/
  .gitignore          # ignores contents of .frame/
  adapters/
    registry.json     # lightweight index of known adapters
    python/
      metadata.json
      LoRA.python     # placeholder text marker — NOT real weights
    java/
      metadata.json
      LoRA.java
    project-python-api/
      metadata.json
      LoRA.project-python-api
    zain-python-style/
      metadata.json
      LoRA.zain-python-style
```

### `metadata.json`

```json
{
  "id": "python",
  "name": "Python language adapter",
  "language": "python",
  "version": "0.1.0",
  "baseModel": "future-local-base",
  "created": 1710000000000,
  "trainingExamples": 0,
  "lastUpdated": 1710000000000,
  "scope": "language",
  "kind": "lora",
  "state": "available",
  "weightFile": "LoRA.python",
  "tags": ["language", "python", "lang:python"]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Display name |
| `language` | Language id when scoped to a language |
| `version` | Adapter package version (semver-ish) |
| `baseModel` | Target base model id (placeholder until runtime exists) |
| `created` / `lastUpdated` | Epoch ms |
| `trainingExamples` | Count of examples used when training exists (0 today) |
| `scope` | `language` \| `project` \| `user` |

Placeholder weight files are short text markers so the layout is stable before training ships.

---

## 4. `IFrameAdapterService` API

| Method | Role |
| --- | --- |
| `discover()` | Scan `.frame/adapters/*/metadata.json` |
| `listAdapters()` / `getAdapter(id)` | In-memory registry |
| `registerAdapter(input)` | Persist folder + metadata + placeholder LoRA file |
| `loadMetadata(id)` | Read on-disk `metadata.json` |
| `setAdapterState(id, state)` | Activate / disable / etc. |
| `removeAdapter(id)` | Delete folder + drop from registry |
| `checkCompatibility(id, request)` | Language / base model / version gates |
| `exportAdapter(id)` | Portable package (`formatVersion` + metadata) |
| `importAdapter(pkg)` | Validate metadata, then register |

DI: `registerSingleton(IFrameAdapterService, FrameAdapterService, InstantiationType.Delayed)`.

---

## 5. Compatibility checking

Before a future load, callers use `checkCompatibility`:

```ts
adapterService.checkCompatibility(id, {
  language: 'python',
  baseModelId: 'future-local-base',
  minAdapterVersion: '0.1.0',
});
// → { compatible: true|false, reasons: string[] }
```

Checks:

- **Language** — language adapters must match requested language when both are set
- **Base model** — `baseModelId` must match (placeholder `future-local-base` is permissive)
- **Adapter version** — must be ≥ `minAdapterVersion` (loose numeric compare)
- **State** — `failed` / `disabled` → incompatible

Returns `compatible` / `incompatible` via the boolean + human-readable `reasons`.

---

## 6. Import / export

**Export** → `IFrameAdapterExportPackage`:

- `formatVersion` (currently `1`)
- `exportedAt`
- `metadata` (full `IFrameAdapterMetadata`)
- `weightPlaceholder` (empty until real LoRA bytes exist)

**Import**:

1. Reject unknown `formatVersion`
2. Require `name`, `scope`, `baseModel`, `version`
3. Validate `scope` ∈ language | project | user
4. `registerAdapter(...)` (writes placeholder weight file only)

Packages are portable JSON-shaped objects; no network transfer is built in.

---

## 7. Context Engine wiring

`IFrameInferenceContext.adapters` (`IFrameAdapterContext`):

| Field | Contents |
| --- | --- |
| `available` | All discovered/registered adapters |
| `active` | `state === active` |
| `languageAdapter` | Active language-scoped (or tagged) match |
| `projectAdapter` | Active project-scoped match |
| `userAdapter` | Active user/style-scoped match |

Legacy alias: `activeAdapters` → `adapters.active`.

---

## 8. Future LoRA training pipeline (not implemented)

When training is allowed later (explicit product decision):

```
Approved preferences / curated examples
        │
        ▼
IFrameTrainingManager  (job queue — scaffold exists)
        │
        ▼
Local trainer (FUTURE)  ← no cloud; no silent downloads
        │
        ▼
Write real weights into .frame/adapters/<id>/LoRA.*
Update metadata.trainingExamples + version
        │
        ▼
setAdapterState(id, Active)
        │
        ▼
Context Engine selects adapter → local runtime applies LoRA
```

Until then:

- Training jobs may be drafted in the training manager
- Adapter service only stores metadata + placeholders
- Inference runtime remains a stub

---

## 9. Privacy / constraints

- Workspace-local under `.frame/adapters/`
- No model weights downloaded by this service
- No Qwen / llama.cpp / MLX integration here
- No training workers in this milestone
- Compile-only milestone: lifecycle system ready for a future local base model
