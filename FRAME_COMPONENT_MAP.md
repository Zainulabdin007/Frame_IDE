# Frame Component Map

Where each VS Code subsystem Frame will eventually interact with lives in the `vscode/` tree.

**Codebase:** Code - OSS 1.131.0 under `vscode/`  
**Companion docs:** `FRAME_ARCHITECTURE.md` (startup, process model, build), `FRAME_REBRAND.md` (branding changes)

Paths below are relative to `vscode/` unless noted.

---

## Layering (mental model)

| Layer | Path | Frame relevance |
|-------|------|-----------------|
| **base** | `src/vs/base/` | Utilities only — rarely touch |
| **platform** | `src/vs/platform/` | Service contracts (commands, config, storage, workspace, files) |
| **editor** | `src/vs/editor/` | Monaco core — models, widgets, language features |
| **workbench** | `src/vs/workbench/` | IDE shell Frame extends (parts, contribs, services, API bridges) |
| **code** | `src/vs/code/` | Electron entry / window lifecycle |
| **server** | `src/vs/server/` | Remote; low priority for local-first Frame |
| **sessions** | `src/vs/sessions/` | Parallel agent-sessions surface (fork-adjacent); not the main IDE shell |
| **extensions** | `extensions/` | Built-in git, LSP clients, languages |
| **API typings** | `src/vscode-dts/` | Public `vscode` API for extensions |

Workbench layout parts are created in `src/vs/workbench/browser/workbench.ts` (`Workbench` extends `Layout`): TITLEBAR, BANNER, ACTIVITYBAR, SIDEBAR, EDITOR, PANEL, AUXILIARYBAR, STATUSBAR.

---

## Subsystem index

| # | Subsystem | Canonical home | Primary symbols |
|---|-----------|----------------|-----------------|
| 1 | [Editor creation](#1-editor-creation) | `workbench/browser/parts/editor`, `workbench/services/editor` | `IEditorService`, `EditorPart`, `EditorInput` |
| 2 | [Text models](#2-text-models) | `editor/common/model*`, `editor/common/services` | `ITextModel`, `IModelService` |
| 3 | [Command registration](#3-command-registration) | `platform/commands`, `platform/keybinding`, `platform/actions` | `CommandsRegistry`, `ICommandService`, `Action2` |
| 4 | [Side panels](#4-side-panels) | `workbench/browser/parts/{sidebar,panel,auxiliarybar}` | `SidebarPart`, `PanelPart`, `AuxiliaryBarPart` |
| 5 | [Activity bar](#5-activity-bar) | `workbench/browser/parts/activitybar` | `ActivitybarPart`, `IActivityService` |
| — | **Frame AI UI** | `workbench/contrib/frameAI/browser` | `FRAME_AI_VIEW_CONTAINER_ID`, `FrameAIViewPane` |
| — | **Frame Intelligence** | `workbench/contrib/frameAI/{orchestrator,memory,rag,adapters,training,services,common}` | `IFrameIntelligenceService`, orchestrator / memory / RAG / adapters / training |

| 6 | [Explorer](#6-explorer) | `workbench/contrib/files` | `ExplorerView`, `IExplorerService` |
| 7 | [Terminal](#7-terminal) | `workbench/contrib/terminal` | `ITerminalService`, `ITerminalInstance` |
| 8 | [Git integration](#8-git-integration) | `extensions/git` + `workbench/contrib/scm` | `ISCMService`, git `Model` / `Repository` |
| 9 | [Language servers](#9-language-servers--lsp) | `editor` language features + `extensions/*-language-features` | `ILanguageFeaturesService` |
| 10 | [Extension API](#10-extension-api) | `src/vscode-dts`, `workbench/api` | `vscode.d.ts`, extHost / mainThread |
| 11 | [Monaco integration](#11-monaco-editor-integration) | `src/vs/editor` + workbench text editors | `CodeEditorWidget`, `editor.all.ts` |
| 12 | [Settings storage](#12-settings-storage) | `platform/configuration`, `platform/storage` | `IConfigurationService`, `IStorageService` |
| 13 | [Workspace management](#13-workspace-management) | `platform/workspace`, `workbench/services/workspaces` | `IWorkspaceContextService` |

---

## 1. Editor creation

**Role:** Open/close editors, manage groups/tabs, map `EditorInput` → editor panes.

**Primary folders**
- `src/vs/workbench/browser/parts/editor/`
- `src/vs/workbench/services/editor/`
- `src/vs/workbench/common/editor/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/workbench/services/editor/common/editorService.ts` | `IEditorService` contract |
| `src/vs/workbench/services/editor/browser/editorService.ts` | Implementation |
| `src/vs/workbench/browser/parts/editor/editorPart.ts` | `EditorPart` — main editor area |
| `src/vs/workbench/browser/parts/editor/editorParts.ts` | `EditorParts` / groups service |
| `src/vs/workbench/browser/parts/editor/editorGroupView.ts` | Single group UI |
| `src/vs/workbench/common/editor/editorInput.ts` | `EditorInput` base |
| `src/vs/workbench/browser/editor.ts` / `editor.contribution.ts` | Registration / commands |

**Also:** `IEditorGroupsService`, `IEditorResolverService`, `FileEditorInput`, `TextFileEditor`

**Frame touchpoints:** Opening AI diffs, custom editor panes, multi-file edit previews.

---

## 2. Text models

**Role:** In-memory text buffers editors and language features operate on.

**Primary folders**
- `src/vs/editor/common/` (model API + impl)
- `src/vs/editor/common/services/`
- `src/vs/workbench/services/textfile/`, `textmodelResolver/`, `model/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/editor/common/model.ts` | `ITextModel` |
| `src/vs/editor/common/model/textModel.ts` | `TextModel` |
| `src/vs/editor/common/services/model.ts` | `IModelService` |
| `src/vs/editor/common/services/modelService.ts` | `ModelService` |
| `src/vs/workbench/services/model/common/modelService.ts` | Workbench registration |

**Also:** `ITextModelService`, `ITextFileService`, `TextFileEditorModel`, `UntitledTextEditorModel`

**Frame touchpoints:** Applying agent edits, streaming patches, virtual/unsaved buffers.

---

## 3. Command registration

**Role:** Global command registry, execution, keybindings, and menus.

**Primary folders**
- `src/vs/platform/commands/`
- `src/vs/platform/keybinding/`
- `src/vs/platform/actions/`
- `src/vs/workbench/services/commands/`, `keybinding/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/platform/commands/common/commands.ts` | `CommandsRegistry`, `ICommandService` |
| `src/vs/workbench/services/commands/common/commandService.ts` | Workbench `CommandService` |
| `src/vs/platform/keybinding/common/keybindingsRegistry.ts` | `KeybindingsRegistry` |
| `src/vs/workbench/services/keybinding/browser/keybindingService.ts` | Keybinding impl |
| `src/vs/platform/actions/common/actions.ts` | `Action2`, `registerAction2`, `MenuRegistry`, `MenuId` |

**Frame touchpoints:** AI actions, chat commands, custom keybindings — prefer `registerAction2` / contribution points over ad-hoc hooks.

---

## 4. Side panels

**Role:** Host view containers in primary sidebar, bottom panel, and secondary (auxiliary) sidebar.

**Primary folders**
- `src/vs/workbench/browser/parts/sidebar/`
- `src/vs/workbench/browser/parts/panel/`
- `src/vs/workbench/browser/parts/auxiliarybar/`
- `src/vs/workbench/browser/parts/views/`
- `src/vs/workbench/services/views/`
- `src/vs/workbench/common/views.ts`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/workbench/browser/parts/sidebar/sidebarPart.ts` | Primary sidebar |
| `src/vs/workbench/browser/parts/panel/panelPart.ts` | Bottom panel |
| `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` | Secondary sidebar |
| `src/vs/workbench/common/views.ts` | View registries + `IViewDescriptorService` |
| `src/vs/workbench/services/views/browser/viewDescriptorService.ts` | View descriptor impl |
| `src/vs/workbench/browser/layout.ts` | Part visibility / sizing |

**Also:** `IViewsService`, `ViewContainerLocation`, `ViewPane`, `ViewPaneContainer`, `AbstractPaneCompositePart`

**Frame touchpoints:** Chat / agent / context panels as view containers (sidebar or auxiliary bar).

---

## 5. Activity bar

**Role:** Icon strip that switches view containers and shows activity badges.

**Primary folders**
- `src/vs/workbench/browser/parts/activitybar/`
- `src/vs/workbench/services/activity/`
- Shared chrome: `compositeBar.ts`, `paneCompositeBar.ts`, `globalCompositeBar.ts`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/workbench/browser/parts/activitybar/activitybarPart.ts` | `ActivitybarPart` |
| `src/vs/workbench/services/activity/common/activity.ts` | `IActivityService` |
| `src/vs/workbench/services/activity/browser/activityService.ts` | Impl |
| `src/vs/workbench/browser/layout.ts` | `Parts.ACTIVITYBAR_PART`, position (Frame defaults top) |

**Frame touchpoints:** Activity entries for Frame AI surfaces; badge counts for agent status.

---

## 6. Explorer

**Role:** Workspace file tree and open-file actions into the editor.

**Primary folders**
- `src/vs/workbench/contrib/files/` (especially `browser/`, `browser/views/`, `browser/editors/`)

**Key files**
| File | Notes |
|------|-------|
| `src/vs/workbench/contrib/files/browser/files.contribution.ts` | Contribution entry |
| `src/vs/workbench/contrib/files/browser/explorerViewlet.ts` | `ExplorerViewPaneContainer` |
| `src/vs/workbench/contrib/files/browser/views/explorerView.ts` | `ExplorerView` |
| `src/vs/workbench/contrib/files/browser/explorerService.ts` | `ExplorerService` |
| `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts` | Tree rendering |
| `src/vs/workbench/contrib/files/browser/fileActions.ts` / `fileCommands.ts` | Actions |

**Also:** `FileEditorInput`, `TextFileEditor`, `IFileService` (`platform/files`)

**Frame touchpoints:** Reveal agent-created files, multi-file edit trees, ignore/exclude UX.

---

## 7. Terminal

**Role:** Integrated terminal instances, groups, profiles; hosted in panel or as editors.

**Primary folders**
- `src/vs/workbench/contrib/terminal/`
- `src/vs/workbench/contrib/terminalContrib/`
- `src/vs/platform/terminal/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/workbench/contrib/terminal/browser/terminal.ts` | `ITerminalService`, `ITerminalInstance` |
| `src/vs/workbench/contrib/terminal/browser/terminalService.ts` | Service impl |
| `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts` | Instance |
| `src/vs/workbench/contrib/terminal/browser/terminal.contribution.ts` | Registration |
| `src/vs/workbench/contrib/terminal/browser/terminalView.ts` | Panel view |

**Also:** `ITerminalGroupService`, `ITerminalEditorService`, `ITerminalProfileService`, `TerminalViewPane`

**Frame touchpoints:** Agent-run commands, tool stdout capture, dedicated agent terminals.

---

## 8. Git integration

**Role:** Git logic lives in a **built-in extension**; workbench SCM contrib renders Source Control UI.

**Primary folders**
- Implementation: `extensions/git/`, `extensions/git-base/`
- UI / services: `src/vs/workbench/contrib/scm/`
- Bridges: `workbench/api/**/mainThreadSCM.ts`, `extHostSCM.ts`
- Helpers: `src/vs/platform/git/`

**Key files**
| File | Notes |
|------|-------|
| `extensions/git/src/main.ts` | Extension activate |
| `extensions/git/src/model.ts`, `git.ts`, `repository.ts` | Repo model |
| `extensions/git/src/commands.ts` | Git commands |
| `src/vs/workbench/contrib/scm/browser/scm.contribution.ts` | SCM UI contrib |
| `src/vs/workbench/contrib/scm/common/scm.ts` | `ISCMService`, `ISCMViewService` |

**Also:** `ISCMProvider`, `ISCMRepository`, `mainThreadSCM` / `ExtHostSCM`, `extensions/github/`

**Frame touchpoints:** Agent commits/PRs, diff review, SCM decorations for AI-touched files — prefer SCM API / git extension surfaces over forking git CLI wrappers.

---

## 9. Language servers / LSP

**Role:** Two layers — core language-feature bus in-product, and built-in extensions that speak LSP (or tsserver).

### A. Core language-feature bus

| File | Notes |
|------|-------|
| `src/vs/editor/common/services/languageFeatures.ts` | `ILanguageFeaturesService` |
| `src/vs/editor/common/services/languageFeaturesService.ts` | Impl |
| `src/vs/workbench/api/common/extHostLanguageFeatures.ts` | Extension host side |
| `src/vs/workbench/api/browser/mainThreadLanguageFeatures.ts` | Renderer bridge |
| `src/vs/editor/common/languages.ts` | Provider types |

### B. Built-in language clients

| Extension | Notes |
|-----------|-------|
| `extensions/typescript-language-features/` | tsserver (not classic LSP) |
| `extensions/css-language-features/{client,server}/` | LSP |
| `extensions/html-language-features/{client,server}/` | LSP |
| `extensions/json-language-features/{client,server}/` | LSP |
| `extensions/markdown-language-features/` | Client under `src/client/` |
| `extensions/php-language-features/` | Legacy-style |

**Frame touchpoints:** Diagnostics for agent edits, custom providers via Extension API, optional Frame-owned language tools.

---

## 10. Extension API

**Role:** Public `vscode` API + RPC between Extension Host and workbench.

**Primary folders**
- `src/vscode-dts/` — typings
- `src/vs/workbench/api/` — `common/` (extHost), `browser/` (mainThread), `node/` / `worker/`
- `src/vs/workbench/services/extensions/`

**Key files**
| File | Notes |
|------|-------|
| `src/vscode-dts/vscode.d.ts` | Public API surface |
| `src/vs/workbench/api/common/extHost.api.impl.ts` | Builds `vscode` namespace for extensions |
| `src/vs/workbench/api/common/extHost.protocol.ts` | RPC shapes |
| `src/vs/workbench/api/browser/extensionHost.contribution.ts` | Loads mainThread participants |
| `src/vs/workbench/api/common/extHostExtensionService.ts` | Ext host extension service |
| `src/vs/workbench/api/browser/mainThreadExtensionService.ts` | Main-thread side |

**Also:** `IExtensionService`, `IExtHostRpcService`, native `electron-browser/nativeExtensionService.ts`

**Frame touchpoints:** Preferred integration path for AI features that should be extension-shaped; use protocol + API carefully for first-party Frame features that need privileged access.

---

## 11. Monaco editor integration

**Role:** Monaco **is** `src/vs/editor` in-tree (not a separate npm package). Workbench text editors instantiate `CodeEditorWidget`.

**Primary folders**
- `src/vs/editor/` (core)
- `src/vs/editor/browser/widget/codeEditor/`
- `src/vs/editor/standalone/browser/` (embeddable / exported API)
- Glue: `workbench/browser/parts/editor/`, `workbench/contrib/codeEditor/`, `workbench/services/editor/browser/codeEditorService.ts`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/editor/editor.all.ts` | Imports all editor contributions (pulled by workbench main) |
| `src/vs/editor/editor.api.ts` | Standalone Monaco API assembly |
| `src/vs/editor/standalone/browser/standaloneEditor.ts` | `createMonacoEditorAPI` |
| `src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts` | `CodeEditorWidget` |
| `src/vs/workbench/browser/parts/editor/textCodeEditor.ts` | Workbench creates widgets via DI |
| `src/vs/monaco.d.ts` | Monaco typings |

**Also:** `ICodeEditor`, `ICodeEditorService`, `AbstractTextCodeEditor`, `DiffEditorWidget`

**Frame touchpoints:** Inline decorations, ghost text / completions UI, diff editors for agent changes — extend workbench editor path, not standalone `monaco.editor.create`, unless embedding outside the workbench.

---

## 12. Settings storage

**Role:** Settings resolution (default / user / workspace / folder) and persistent key-value UI state.

**Primary folders**
- Config: `src/vs/platform/configuration/`, `src/vs/workbench/services/configuration/`
- Storage: `src/vs/platform/storage/`, `src/vs/workbench/services/storage/`
- Preferences UI: `src/vs/workbench/services/preferences/`, `contrib/preferences/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/platform/configuration/common/configuration.ts` | `IConfigurationService` |
| `src/vs/platform/configuration/common/configurationRegistry.ts` | Setting schema registry |
| `src/vs/workbench/services/configuration/browser/configurationService.ts` | `WorkspaceService` (config **and** workspace context) |
| `src/vs/platform/storage/common/storage.ts` | `IStorageService` |
| `src/vs/workbench/services/storage/browser/storageService.ts` | Browser storage |
| `src/vs/workbench/services/storage/electron-browser/storageService.ts` | Desktop storage |

**Also:** `IWorkbenchConfigurationService`, `IConfigurationEditingService`, Frame product defaults in `product.json` / theme / chrome defaults

**Frame touchpoints:** Frame-specific settings, local-first AI prefs, telemetry off, update mode none (already rebranded defaults).

---

## 13. Workspace management

**Role:** Single- and multi-root workspace identity, folder add/remove, trust, workspace files.

**Primary folders**
- `src/vs/platform/workspace/`
- `src/vs/workbench/services/workspaces/`
- `src/vs/workbench/services/configuration/` (context service impl)
- `src/vs/workbench/contrib/workspace/`

**Key files**
| File | Notes |
|------|-------|
| `src/vs/platform/workspace/common/workspace.ts` | `IWorkspaceContextService`, folder types |
| `src/vs/workbench/services/configuration/browser/configurationService.ts` | `WorkspaceService` implements context |
| `src/vs/workbench/services/workspaces/common/workspaceEditing.ts` | Editing contracts |
| `src/vs/workbench/services/workspaces/browser/workspaceEditingService.ts` | Impl |
| `src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts` | UI contrib |
| `src/vs/platform/workspace/common/workspaceTrust.ts` | Trust types |

**Also:** `IWorkspace`, `IWorkspaceFolder`, `IWorkspaceEditingService`, `IWorkspacesService`, trust management services

**Frame touchpoints:** Project-scoped agent context, workspace trust for local tools, multi-root awareness.

---

## Quick symbol → home

| Search for | Look here |
|------------|-----------|
| `IEditorService` / `EditorPart` / `EditorInput` | `workbench/services/editor`, `workbench/browser/parts/editor`, `workbench/common/editor` |
| `IModelService` / `ITextModel` | `editor/common/services`, `editor/common/model*` |
| `CommandsRegistry` / `ICommandService` | `platform/commands`, `workbench/services/commands` |
| `KeybindingsRegistry` / `Action2` | `platform/keybinding`, `platform/actions` |
| `SidebarPart` / `PanelPart` / `AuxiliaryBarPart` | `workbench/browser/parts/{sidebar,panel,auxiliarybar}` |
| `ActivitybarPart` | `workbench/browser/parts/activitybar` |
| `IViewDescriptorService` | `workbench/common/views.ts`, `workbench/services/views` |
| `ExplorerView` | `workbench/contrib/files` |
| `ITerminalService` | `workbench/contrib/terminal` |
| Git / SCM | `extensions/git`, `workbench/contrib/scm` |
| `ILanguageFeaturesService` | `editor/common/services` + `workbench/api` language bridges |
| `vscode.d.ts` / extHost / mainThread | `src/vscode-dts`, `workbench/api` |
| `CodeEditorWidget` / Monaco | `editor/` + `workbench/.../textCodeEditor.ts` |
| `IConfigurationService` / `IStorageService` | `platform/configuration`, `platform/storage`, workbench services |
| `IWorkspaceContextService` | `platform/workspace` + `WorkspaceService` |

---

## Frame interaction priority (suggested)

When adding AI / local-first features, prefer this order:

1. **Extension API** (`workbench/api` + `vscode.d.ts`) for sandboxed capabilities  
2. **Commands / Actions** (`Action2`, menus) for user-invoked Frame features  
3. **Views** (sidebar / auxiliary bar / panel) for persistent Frame UI  
4. **Editor + text models** for applying and previewing code changes  
5. **Terminal + SCM** for agent tools and VCS workflows  
6. **Configuration / storage / workspace** for Frame product settings and project scope  

Avoid rewriting `base/` or forking Monaco unless necessary — extend via workbench DI, contributions, and the extension host.

---

## Related docs

- `FRAME_ARCHITECTURE.md` — process model, startup, contributions overview  
- `FRAME_REBRAND.md` — product identity / chrome changes already applied  
- `scripts/launch-frame.sh` — local Frame launch  
