# Frame Adapter Management UI

User-facing control of personalization adapters in the Frame AI sidebar.

**This milestone does not:** train LoRAs, download weights, run inference, or call the cloud.

## Purpose

Let users **inspect and control** adapters that will eventually specialize a local base model:

- Language adapters (`LoRA.python`, …)
- Project adapters (`project-python-api`, …)
- User preference adapters (`zain-python-style`, …)

All actions go through `IFrameAdapterManagementService` → `IFrameAdapterService` (local `.frame/adapters/` only).

## UI structure

Frame AI sidebar sections (top → bottom):

```
Welcome
Learning          ← preference candidates
Adapters          ← this milestone
  Import package
  Active adapters
  Available adapters
  Imported adapters
Chat messages
Composer
```

### Adapter card

Each card shows:

| Field | Example |
| --- | --- |
| Name (weight file) | `LoRA.python` |
| Scope label | Language Adapter |
| Language | `python` |
| Version | `1.0` / `0.1.0` |
| Status | `active` / `available` / … |
| Compatible | `YES` / `NO` |
| Imported badge | when tagged `imported` |

### Actions

| Button | Effect |
| --- | --- |
| **Activate** | `setAdapterState(id, Active)` |
| **Deactivate** | `setAdapterState(id, Available)` |
| **Export** | `exportAdapter` → clipboard JSON package |
| **Details** | Expand metadata + compatibility |
| **Remove** | `removeAdapter` (deletes `.frame/adapters/<id>/`) |
| **Validate** | Parse paste package; no write |
| **Import** | Validate → `importAdapter` (tags `imported`) |

### Details view

Expanded card shows:

- Name, base model
- Training example count
- Created / last updated
- Compatibility YES/NO + reasons
- Optional description

## User workflow

```
Open Frame AI sidebar
        │
        ▼
Paste portable package JSON  ──Validate──► system message (ok / errors)
        │
        ▼
Import  → written under .frame/adapters/<id>/
        │   (metadata.json + placeholder LoRA.* only)
        ▼
Activate  → included in IFrameInferenceContext.adapters.active
        │
        ▼
Export  → clipboard (shareable metadata package)
        │
        ▼
Deactivate / Remove as needed
```

Activate is explicit. Import does not auto-activate unless requested by API option (UI imports as available).

## Grouping

| Group | Rule |
| --- | --- |
| **Active** | `state === active` |
| **Available** | not active, not failed |
| **Imported** | tag `imported` (from Import) |

An adapter may appear in more than one group (e.g. active + imported).

## APIs

`IFrameAdapterManagementService` (`adapters/frameAdapterManagement.ts`):

| Method | Role |
| --- | --- |
| `getGroupedAdapters()` | Active / available / imported list items |
| `getDetails(id)` | Metadata + compatibility |
| `activate` / `deactivate` / `remove` | State / delete via adapter service |
| `exportAdapter` | Portable package |
| `validatePackageJson` | Parse + schema checks |
| `importPackageJson` | Validate + import + `imported` tag |
| `refresh` | Re-discover disk registry |

Facade: `IFrameIntelligenceService.adapterManagement`.

## Privacy model

| Guarantee | UI behavior |
| --- | --- |
| Local only | Packages paste/import/export on-device; export uses clipboard |
| No cloud | No upload / download of adapters |
| No training | UI never starts a trainer |
| No model load | Activate only flips metadata state for Context Engine |
| Workspace storage | Artifacts under `.frame/adapters/` |

## Source files

| Path | Role |
| --- | --- |
| `browser/frameAIViewPane.ts` | Adapters section + cards + import UI |
| `browser/media/frameAI.css` | Adapters layout |
| `adapters/frameAdapterManagement.ts` | UI service contract |
| `adapters/frameAdapterManagementService.ts` | Implementation |
| `adapters/frameAdapters.ts` | Underlying registry |
| `FRAME_ADAPTER_ARCHITECTURE.md` | Storage / lifecycle backend |

## Out of scope

- Qwen / any base model
- Real LoRA weight files
- Training UI
- Cloud adapter marketplace
