# Frame Preference Review UI

User control over candidate preferences before they become active.

**Hard rule:** Frame never auto-applies preferences. Approve is required.

## User control model

```
Observations / edits
        │
        ▼
PreferenceAnalyzer → CandidatePreference (lifecycle: candidate)
        │
        ▼
Learning panel (Frame AI sidebar)
        │
   ┌────┴────┐
Approve    Reject / dismiss
   │           │
   ▼           ▼
Active      Hidden (rejected / reviewed)
preference  — not shown again
in .frame/memory/preferences.json
   │
   ▼
FrameContextService → IFrameInferenceContext.preferences
```

The user always decides. Candidates are suggestions only.

## Approval lifecycle

| State | Meaning | Shown in Learning? |
| --- | --- | --- |
| Observed | Early signal | No (not yet Candidate) |
| Candidate | Ready for review | **Yes** |
| Confirmed → Active | User approved | No (already active) |
| Rejected | User rejected | No |
| Dismissed via `markReviewed` | Soft hide | No |

### Approve

```
approvePreference(id)
  → ObservationService.approvePreference
  → PersistentMemory.savePreference (tags: active)
  → written to preferences.json
  → Context Engine includes it on next build
```

### Reject

```
rejectPreference(id)
  → lifecycle Rejected
  → stored as negative signal
  → added to preference-review.json dismiss list
  → does not resurface in Learning
```

## UI

Frame AI sidebar section **Learning**:

- Eyebrow: “Frame noticed”
- Preference text
- Language / Observed count / Confidence %
- Buttons: **Approve** · **Reject**

Empty state explains that accepting/editing generations teaches Frame.

## APIs

`IFramePreferenceReviewService`:

| Method | Role |
| --- | --- |
| `getPendingPreferences()` | Candidate prefs not dismissed |
| `approvePreference(id)` | Activate into persistent memory |
| `rejectPreference(id)` | Reject + hide |
| `markReviewed(id)` | Hide without approving |

Facade: `IFrameIntelligenceService.preferenceReview`

## Privacy design

| Guarantee | How |
| --- | --- |
| Local only | Review state under `.frame/memory/preference-review.json` |
| No telemetry | No network from review service / Learning UI |
| Explicit consent | Active prefs require Approve click |
| Reject is sticky | Rejected ids stay dismissed locally |
| Context opt-in | Only **active** prefs enter `IFrameInferenceContext` |

## Source files

| Path | Role |
| --- | --- |
| `preferences/framePreferenceReview.ts` | Contract |
| `preferences/framePreferenceReviewService.ts` | Review + dismiss persistence |
| `browser/frameAIViewPane.ts` | Learning panel |
| `browser/media/frameAI.css` | Learning styles |

## What this does not do

- Auto-apply preferences to the editor
- Train models / create LoRA
- Upload preferences anywhere
