# Frame Rebrand + Visual Redesign

Rebrand of Microsoft VS Code (Code - OSS) → **Frame**, with a Cursor-inspired
minimal chrome redesign. Completed July 20, 2026.

## Design direction

Inspired by Cursor’s visual language (near-black canvas, hairline dividers,
single chromatic accent reserved for intelligence/actions), applied with
**Frame** identity:

| Principle | Implementation |
|-----------|----------------|
| One near-black canvas | Title / side / panel / status share `#0A0A0B`; editor sits at `#111112` |
| Hairlines, not walls | Borders are `rgba(255,255,255,0.05)` — panels feel flush |
| Single accent | Violet `#AF50FF` only on focus, selection, badges, primary buttons |
| Secondary signal | Sunset orange `#E8874A` for git modified / find matches |
| Minimal chrome | Activity bar **top** by default, **compact tabs**, **no panel shadows** |
| Typography | Bundled **Inter** (UI) + **JetBrains Mono** (editor/terminal) |

Verified in a live Frame Dev window: onboarding shows **Frame Dark** selected
with violet Continue CTA; empty workbench shows thin title bar, quiet status
bar, and violet Sign In — no chunky side activity strip.

---

## How to launch

```bash
./scripts/launch-frame.sh
```

Or manually:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
cd vscode && ./scripts/code.sh
```

Binary: `.build/electron/Frame.app/Contents/MacOS/Frame`  
Dev title: **Frame Dev** (standard `VSCODE_DEV` suffix)

---

## Product / telemetry / updates

| Setting | Value |
|---------|-------|
| `nameShort` / `nameLong` | Frame |
| `applicationName` | frame |
| `dataFolderName` | `.frame` |
| `darwinBundleIdentifier` | `com.frame.ide` |
| `enableTelemetry` | `false` |
| `telemetry.telemetryLevel` default | `off` |
| `updateUrl` | omitted |
| `update.mode` default | `none` |

Log confirmation: `update#setState disabled` / `updates are disabled as there is no update URL`.

---

## Layout defaults (still user-overridable)

- `workbench.activityBar.location`: **top**
- `workbench.activityBar.autoHide`: **true**
- `workbench.activityBar.compact`: **true**
- `window.density.editorTabHeight`: **compact**
- `workbench.shadows`: **false**
- Default color theme: **Frame Dark**

---

## Modified files inside `vscode/`

### Product & packaging
1. `product.json`
2. `build/lib/electron.ts`
3. `build/next/index.ts` *(font asset copy for builds)*
4. `src/vs/platform/product/common/product.ts`
5. `resources/linux/code.desktop`

### Icons & logos
6. `resources/darwin/code.icns`
7. `resources/linux/code.png`
8. `resources/win32/code.ico`
9. `resources/win32/code_70x70.png`
10. `resources/win32/code_150x150.png`
11. `resources/server/favicon.ico`
12. `src/vs/workbench/browser/media/code-icon.svg`
13. `src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg`
14. `src/vs/workbench/browser/parts/editor/media/letterpress-light.svg`
15. `src/vs/workbench/browser/parts/editor/media/letterpress-hcDark.svg`
16. `src/vs/workbench/browser/parts/editor/media/letterpress-hcLight.svg`
17. `src/vs/sessions/browser/media/sessions-logo-dark.svg`
18. `src/vs/sessions/browser/media/sessions-logo-light.svg`

### Chrome redesign (CSS + fonts + defaults)
19. `src/vs/workbench/browser/media/style.css`
20. `src/vs/workbench/browser/media/fonts/` *(new — Inter + JetBrains Mono woff2)*
21. `src/vs/editor/common/config/fontInfo.ts`
22. `src/vs/workbench/browser/workbench.contribution.ts`

### About
23. `src/vs/platform/dialogs/electron-browser/dialog.ts`
24. `src/vs/workbench/browser/parts/dialogs/dialog.ts`

### Telemetry & updates
25. `src/vs/platform/telemetry/common/telemetryService.ts`
26. `src/vs/platform/update/common/update.config.contribution.ts`

### Themes
27. `extensions/theme-defaults/package.json`
28. `extensions/theme-defaults/themes/frame-dark.json` *(new)*
29. `extensions/theme-defaults/themes/frame-light.json` *(new)*
30. `src/vs/workbench/services/themes/common/workbenchThemeService.ts`
31. `src/vs/workbench/services/themes/browser/workbenchThemeService.ts`

### User-visible string rebrand (VS Code → Frame)
32. `src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts`
33. `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts`
34. `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`
35. `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts`
36. `src/vs/workbench/contrib/update/browser/update.ts`
37. `src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts`
38. `src/vs/workbench/contrib/terminal/browser/terminalView.ts`
39. `src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts`
40. `src/vs/workbench/contrib/webview/browser/webviewFindAccessibilityHelp.ts`
41. `src/vs/workbench/electron-browser/desktop.contribution.ts`
42. `src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts`
43. `src/vs/workbench/services/userDataProfile/browser/userDataProfileManagement.ts`

**Total in `vscode/`: 43 paths** (41 modified + theme JSON + fonts directory)

---

## New files outside `vscode/`

| Path | Purpose |
|------|---------|
| `FRAME_ARCHITECTURE.md` | Architecture reference |
| `FRAME_REBRAND.md` | This document |
| `scripts/launch-frame.sh` | Dev launcher (Node 24 + clears `ELECTRON_RUN_AS_NODE`) |
| `resources/branding/frame-app-icon.png` | App icon master (3D knot on black) — **OS icon only** |
| `resources/branding/frame-icon-1024.png` | Square logo master |
| `resources/branding/frame-logo-alpha.png` | Transparent dark chrome (archive; not used in UI) |
| `resources/branding/frame-logo-white.png` | White/silver archive (not used in UI) |
| `resources/branding/frame-tokens.css` | Website design tokens |
| `resources/branding/frame-tokens.json` | Tokens + IDE mapping |
| `resources/branding/shot-frame-*.png` | Design verification screenshots |

---

## Notes

- Functionality preserved: only product metadata, assets, themes, CSS, defaults, and user-facing copy changed.
- Internal `vscode.*` extension IDs / command IDs left intact for compatibility.
- File-type document icons (`.ts`, `.js`, …) remain stock; only the **application** icon is Frame.
- Some residual “VS Code” strings may remain in deep setting schemas / extension READMEs.
- `package.json` npm name stays `code-oss-dev` (build tooling); product name is Frame.
