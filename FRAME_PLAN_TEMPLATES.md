# Frame Plan Templates

Reusable, deterministic planning templates for Frame Intelligence.

**Hard rules:** no models, no weights, no inference, no cloud APIs.  
**Execution pipeline unchanged:** Prompt → Match → Generate Plan → Review → Execute.

---

## Hierarchy

```
Builtin (code)
  ↑ overridden by
Global  ~/.frame/templates/*.frameplan
  ↑ overridden by
Workspace  .frame/plans/templates/*.frameplan
```

Same `id` or `name`: workspace wins, then global, then builtin.

---

## Matching

`FramePlanMatcher` scores templates with keyword / language / project / favorite / usage heuristics.

High confidence (≥ 40): planner may **materialize** the template as the initial plan and attach:

- `suggestedTemplateId`
- `suggestedTemplateName`
- `suggestedTemplateScore`

User can ignore and keep editing, or press **Use Template** in the Templates panel.

Example: `"refactor authentication"` → **Refactor Backend**.

---

## Components

| Piece | Path |
|-------|------|
| Library types + builtins | `planning/framePlanTemplates.ts` |
| Matcher | `planning/framePlanMatcher.ts` |
| Manager | `planning/framePlanTemplateService.ts` |
| Planner hook | `frameTaskPlanner.ts` (optional template input) |
| UI | Frame AI → **Templates** (above Review) |

### Template manager APIs

`saveTemplate` · `deleteTemplate` · `renameTemplate` · `duplicateTemplate` · `favoriteTemplate` · `recentTemplates` · `importTemplate` · `exportTemplate`

---

## `.frameplan` format

```json
{
  "format": "frameplan",
  "formatVersion": 1,
  "template": {
    "id": "…",
    "name": "Backend",
    "description": "…",
    "category": "backend",
    "supportedLanguages": ["typescript"],
    "triggerPatterns": ["api", "service"],
    "defaultSteps": [ … ],
    "examplePrompts": [ … ],
    "lastUsed": null,
    "usageCount": 0,
    "editable": true,
    "source": "workspace"
  }
}
```

Import validates schema — no execution.

---

## Preference / style metadata

Review mutations record counters under:

`.frame/plans/template-style-stats.json`

Events: rename · disable · reorder · duplicate · apply  

Favorites / usage under `.frame/plans/template-meta.json`.

No model training — metadata only for future planner learning.

---

## Next step

Add an Import Template control in the Templates panel (paste `.frameplan` JSON).
