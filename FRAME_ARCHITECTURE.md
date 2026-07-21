# Frame Architecture — VS Code Codebase Reference

This document describes the architecture of Microsoft's VS Code (Code - OSS) repository, cloned into `vscode/` as the foundation for **Frame**, a local-first AI coding IDE. This milestone covers build verification and codebase orientation only — no AI features, branding changes, or architectural modifications have been made.

**Repository:** https://github.com/microsoft/vscode  
**Cloned version:** 1.131.0 (Code - OSS)  
**Build date:** July 20, 2026

---

## Table of Contents

1. [Overall Architecture](#overall-architecture)
2. [Major Folders](#major-folders)
3. [Application Startup Flow](#application-startup-flow)
4. [Process Model](#process-model)
5. [Important Modules](#important-modules)
6. [UI Components](#where-ui-components-live)
7. [Command Registration](#how-commands-are-registered)
8. [Editor Creation](#how-editors-are-created)
9. [Side Panels](#how-side-panels-work)
10. [Contributions](#how-contributions-are-loaded)
11. [Extension Communication](#how-extensions-communicate)
12. [Workbench Initialization](#how-the-workbench-initializes)
13. [Subsystems Reference](#subsystems-reference)
14. [Build & Launch](#build--launch)

---

## Overall Architecture

VS Code is an **Electron application** with a multi-process architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                        │
│  src/main.ts → src/vs/code/electron-main/main.ts                │
│  Window management, IPC, file system, extension host spawning    │
└────────────┬───────────────────────────────┬────────────────────┘
             │ IPC                           │ IPC
┌────────────▼────────────┐    ┌────────────▼────────────────────┐
│   Renderer (Workbench)   │    │   Extension Host Process(es)   │
│   Browser/Electron UI    │    │   src/vs/workbench/api/node/   │
│   src/vs/workbench/      │◄──►│   extensionHostProcess.ts      │
└────────────┬────────────┘    └────────────────────────────────┘
             │
┌────────────▼────────────┐
│   Shared Process         │
│   Background services    │
└─────────────────────────┘
```

The codebase is organized in layers under `src/vs/`:

| Layer | Path | Purpose |
|-------|------|---------|
| **base** | `src/vs/base/` | Cross-platform utilities (DOM, events, async, IPC primitives) |
| **platform** | `src/vs/platform/` | Service abstractions and dependency injection |
| **editor** | `src/vs/editor/` | Monaco text editor (standalone, reusable) |
| **workbench** | `src/vs/workbench/` | Full IDE shell (panels, services, contributions) |
| **code** | `src/vs/code/` | Application entry points (electron-main, electron-browser) |
| **server** | `src/vs/server/` | Remote/server-side components |

Core design patterns:
- **Dependency Injection** via `IInstantiationService` and `ServiceCollection`
- **Registry pattern** for extensible contributions (`Registry.as<T>(id)`)
- **Side-effect imports** for module registration (`.contribution.ts` files)
- **IPC/RPC** between processes using `ProxyChannel` and `RPCProtocol`

---

## Major Folders

```
vscode/
├── src/                    # Core TypeScript source
│   ├── main.ts             # Electron bootstrap entry (package.json "main")
│   ├── bootstrap-*.ts      # ESM/Node/fork bootstrapping helpers
│   └── vs/                 # All VS Code modules (see layer table above)
├── extensions/             # Built-in extensions (~100+ folders)
├── build/                  # Build scripts, gulp tasks, npm helpers
├── scripts/                # Dev launch scripts (code.sh, code.bat, etc.)
├── resources/              # Icons, Linux desktop files, Windows manifests
├── remote/                 # Remote development (REH) packages
├── cli/                    # Standalone `code` CLI (Rust)
├── test/                   # Integration, smoke, and unit tests
├── product.json            # Product metadata (names, URLs, built-in extensions)
└── out/                    # Compiled JavaScript output (after `npm run compile`)
```

### `src/vs/workbench/` breakdown

| Subfolder | Purpose |
|-----------|---------|
| `browser/` | Workbench UI parts (layout, editor area, notifications, side bar) |
| `electron-browser/` | Desktop-specific workbench entry and services |
| `common/` | Shared workbench types, editor abstractions, contributions registry |
| `contrib/` | Feature modules (files/explorer, terminal, debug, search, settings, etc.) |
| `services/` | Workbench-level services (editor, extensions, configuration, views) |
| `api/` | Extension host API implementation (ExtHost*) |

### `src/vs/platform/` breakdown

Platform services used across workbench and extensions: `configuration`, `commands`, `actions`, `files`, `storage`, `keybinding`, `theme`, `extensions`, `log`, `telemetry`, etc. Each typically has subfolders for `common/`, `browser/`, `node/`, and `electron-main/`.

---

## Application Startup Flow

### 1. Electron bootstrap (`src/main.ts`)

The compiled entry point (`out/main.js`, referenced by `package.json` `"main"`) performs:

1. Parse CLI args and `argv.json` configuration
2. Configure sandbox, user data path, crash reporter
3. Register custom URL schemes (`vscode-webview`, `vscode-file`, etc.)
4. On `app.once('ready')`:
   - Resolve NLS (localization) configuration
   - Call `bootstrapESM()` to set up ESM module loading
   - Dynamic import: `./vs/code/electron-main/main.js`

### 2. Main process (`src/vs/code/electron-main/main.ts`)

Creates the service container and starts `CodeApplication`:

- Registers platform services (file, configuration, lifecycle, protocol, etc.)
- Sets up IPC channels for renderer and shared process communication
- Creates browser windows via `WindowsMainService`
- Manages extension host process lifecycle

### 3. Renderer bootstrap (`src/vs/code/electron-browser/workbench/workbench.ts`)

Each window loads `workbench.html`, which runs an async IIFE that:

1. Shows splash screen from cached layout data
2. Loads NLS messages
3. Imports `workbench.desktop.main.js` (the full workbench bundle)
4. Creates `DesktopMain` and calls `open()`

### 4. Workbench startup (`src/vs/workbench/electron-browser/desktop.main.ts`)

`DesktopMain`:

1. Builds `ServiceCollection` with desktop-specific services
2. Instantiates `Workbench` class
3. Calls `workbench.startup()` which renders UI and restores state

### 5. Launch script (`scripts/code.sh`)

For development, `./scripts/code.sh`:

1. Runs `build/lib/preLaunch.ts` (downloads Electron, compiles if needed, fetches built-in extensions)
2. Sets `NODE_ENV=development`, `VSCODE_DEV=1`
3. Execs `.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS` with the repo as workspace

---

## Process Model

### Electron Main Process

- **Entry:** `src/main.ts` → `src/vs/code/electron-main/main.ts`
- **Role:** App lifecycle, native OS integration, window creation, spawns child processes
- **Key class:** `CodeApplication` in `src/vs/code/electron-main/app.ts`

### Renderer Process

- **Entry:** `src/vs/code/electron-browser/workbench/workbench.ts`
- **Bundle:** `src/vs/workbench/workbench.desktop.main.ts` (side-effect imports entire workbench)
- **Role:** All visible UI — editor, side bar, panels, command palette, settings UI
- Runs in Chromium renderer with sandbox enabled

### Extension Host

- **Entry:** `src/vs/workbench/api/node/extensionHostProcess.ts`
- **Starter:** `src/vs/workbench/services/extensions/electron-browser/extensionHostStarter.ts`
- **Role:** Runs extension code in isolated Node.js process
- **Kinds:** LocalProcess, LocalWebWorker, Remote (see `extensionHostKind.ts`)
- Communicates with workbench via `RPCProtocol` over sockets/message ports

### Shared Process

- Utility process for background tasks (extension management, search indexing, etc.)
- Started by main process, accessed via IPC from renderer

---

## Important Modules

| Module | Path | Description |
|--------|------|-------------|
| Workbench | `src/vs/workbench/browser/workbench.ts` | Central UI orchestrator; extends `Layout` |
| Layout | `src/vs/workbench/browser/layout.ts` | Grid layout for title bar, activity bar, side bar, editor, panel, status bar |
| Editor (Monaco) | `src/vs/editor/` | Text editing engine; also published as standalone Monaco |
| Commands | `src/vs/platform/commands/common/commands.ts` | `CommandsRegistry`, `ICommandService` |
| Actions/Menus | `src/vs/platform/actions/common/actions.ts` | `registerAction2`, `MenuRegistry`, `MenuId` |
| Configuration | `src/vs/platform/configuration/common/configurationRegistry.ts` | Settings schema registration |
| Extensions | `src/vs/workbench/services/extensions/common/extensions.ts` | Extension scanning, activation, host management |
| RPC Protocol | `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | Bidirectional RPC between workbench and extension host |
| Registry | `src/vs/platform/registry/common/platform.ts` | Global contribution registry |
| Instantiation | `src/vs/platform/instantiation/common/instantiationService.ts` | DI container |
| Views | `src/vs/workbench/common/views.ts` | View container and view descriptor types |
| Product | `product.json` | Branding, extension gallery, built-in extension list |

---

## Where UI Components Live

| UI Area | Primary Location |
|---------|-----------------|
| Workbench shell / layout | `src/vs/workbench/browser/layout.ts`, `parts/` |
| Activity bar | `src/vs/workbench/browser/parts/activitybar/` |
| Side bar | `src/vs/workbench/browser/parts/sidebar/` |
| Editor area | `src/vs/workbench/browser/parts/editor/` |
| Panel (bottom) | `src/vs/workbench/browser/parts/panel/` |
| Status bar | `src/vs/workbench/browser/parts/statusbar/` |
| Title bar | `src/vs/workbench/browser/parts/titlebar/` |
| Notifications | `src/vs/workbench/browser/parts/notifications/` |
| Explorer | `src/vs/workbench/contrib/files/browser/views/explorerView.ts` |
| Terminal | `src/vs/workbench/contrib/terminal/browser/` |
| Settings UI | `src/vs/workbench/contrib/preferences/browser/` |
| Command palette | `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts` |
| Base UI widgets | `src/vs/base/browser/ui/` (lists, buttons, inputs, trees) |
| Editor widgets | `src/vs/editor/browser/` |

Contributions follow the pattern `src/vs/workbench/contrib/<feature>/browser/` with a `*.contribution.ts` file that registers views, commands, and configuration on import.

---

## How Commands Are Registered

Commands use a two-layer system:

### 1. Low-level command registry

```typescript
// src/vs/platform/commands/common/commands.ts
CommandsRegistry.registerCommand('myCommandId', (accessor, ...args) => { ... });
```

`ICommandService.executeCommand(id, ...args)` dispatches to registered handlers.

### 2. Actions (commands + keybindings + menus)

```typescript
// src/vs/platform/actions/common/actions.ts
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'myCommandId',
      title: localize2('myCommand', 'My Command'),
      category: Categories.File,
      f1: true,  // show in Command Palette
      menu: [{ id: MenuId.EditorContext, group: 'navigation' }]
    });
  }
  run(accessor: ServicesAccessor, ...args) { ... }
});
```

- **`f1: true`** — exposes command in Command Palette
- **`MenuRegistry.appendMenuItem()`** — adds items to context menus, menu bar, etc.
- **`MenuId`** enum defines menu targets (EditorContext, ViewTitle, MenubarFileMenu, etc.)

Extensions register commands via `vscode.commands.registerCommand()` in the extension host, which proxies back to the workbench command service.

---

## How Editors Are Created

### Registration

1. **Editor input** — subclass of `EditorInput` (e.g. `FileEditorInput` in `contrib/files/browser/editors/`)
2. **Editor pane** — subclass of `EditorPane` registered via `EditorPaneDescriptor`:

```typescript
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
  .registerEditorPane(EditorPaneDescriptor.create(TextFileEditor, ...), [FileEditorInput]);
```

3. **Editor factory** — serializes/deserializes editor state for persistence

### Opening an editor

`IEditorService.openEditor()` (in `services/editor/browser/editorService.ts`):

1. Resolves input URI/type via `IEditorResolverService`
2. Finds or creates target editor group via `IEditorGroupsService`
3. Creates `EditorInput` instance through `IEditorFactoryRegistry`
4. Opens pane in group; pane creates Monaco `ICodeEditor` widget

### Monaco editor

The underlying text editor lives in `src/vs/editor/`. Workbench wraps it in `src/vs/workbench/browser/codeeditor.ts` and `src/vs/workbench/contrib/codeEditor/browser/`.

---

## How Side Panels Work

Side panels use the **View Container / View** abstraction:

### Registration (in `*.contribution.ts` files)

```typescript
const VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry)
  .registerViewContainer({ id: 'workbench.view.explorer', title: ..., ctorDescriptor: ... }, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry)
  .registerViews([{ id: 'workbench.explorer.fileView', name: ..., ctorDescriptor: ... }], VIEW_CONTAINER);
```

### Runtime services

- **`IViewDescriptorService`** — manages view container registration and location (Sidebar, Panel, AuxiliaryBar)
- **`IViewsService`** — opens/closes/focuses views (`src/vs/workbench/services/views/browser/viewsService.ts`)
- **`ViewPaneContainer`** — UI container hosting multiple `ViewPane` instances
- **`IWorkbenchLayoutService`** — positions parts; enum `Parts.Sidebar`, `Parts.Panel`, etc.

Panel locations:
- **Sidebar** (left/right) — Explorer, Search, SCM, Extensions
- **Panel** (bottom) — Terminal, Problems, Output, Debug Console
- **AuxiliaryBar** — Secondary side bar

---

## How Contributions Are Loaded

Contributions load via **side-effect ES module imports** — no central plugin manifest scanner for core features.

### Workbench entry chain

```
workbench.desktop.main.ts
  → workbench.common.main.ts   (imports all core contributions)
  → electron-browser/desktop.main.ts
  → electron-browser/desktop.contribution.ts
```

`workbench.common.main.ts` imports hundreds of `*.contribution.ts` files. Each file registers with global registries on import:

| Registry | Extension ID | Purpose |
|----------|-------------|---------|
| Workbench contributions | `workbench.contributions.kind` | Lifecycle hooks via `registerWorkbenchContribution2()` |
| Configuration | `base.contributions.configuration` | Settings schema |
| Views | `workbench.contributions.views` | Side bar / panel views |
| Editor panes | `workbench.contributions.editorPane` | Editor types |
| JSON schemas | `base.contributions.jsonschemas` | Settings/JSON validation |

### Workbench contribution phases

```typescript
registerWorkbenchContribution2(MyContribution.ID, MyContribution, WorkbenchPhase.AfterRestored);
```

Phases (`LifecyclePhase`): `Starting` → `Ready` → `Restored` → `Eventually`

### Built-in extensions

Separate npm packages in `extensions/` folder. Each has `package.json` with `contributes` block. Loaded by `ExtensionService` at runtime, not via workbench import chain.

---

## How Extensions Communicate

### Architecture

```
Renderer (MainThread*)  ←── RPCProtocol ──→  Extension Host (ExtHost*)
```

### Protocol

- **`rpcProtocol.ts`** — JSON-RPC-like protocol over socket/message port
- **`proxyIdentifier.ts`** — Defines `MainContext` and `ExtHostContext` proxy identifiers
- **`extensionHostProtocol.ts`** — Init data, message types, extension description deltas

### Main thread actors

Located in `src/vs/workbench/api/browser/`:
- `MainThreadCommands`, `MainThreadDocuments`, `MainThreadLanguageFeatures`, etc.
- Each implements the workbench-side of an API namespace

### Extension host actors

Located in `src/vs/workbench/api/common/`:
- `ExtHostCommands`, `ExtHostDocuments`, `ExtHostLanguageFeatures`, etc.

### Extension activation

1. `ExtensionService` scans installed extensions
2. On trigger event (e.g. `onLanguage:typescript`), spawns/activates extension host
3. Sends `IExtensionHostInitData` with extension descriptions
4. Extension host loads extension entry point (`main` from `package.json`)
5. Extension calls `activate()`; API calls proxy to main thread

### Built-in vs marketplace extensions

- **Built-in:** `extensions/` folder, compiled with gulp
- **Downloaded built-in:** listed in `product.json` → `builtInExtensions`, fetched at build/launch
- **User extensions:** `~/.vscode-oss/extensions/` (or `product.json` `dataFolderName`)

---

## How the Workbench Initializes

`Workbench.startup()` in `src/vs/workbench/browser/workbench.ts`:

```
1. initServices(serviceCollection)
   └── Create InstantiationService, register singleton services

2. invokeFunction(accessor => {
     a. initLayout(accessor)           — create DOM container
     b. Registry.start()               — activate workbench & editor factory registries
     c. WorkbenchContextKeysHandler    — set context keys for when-clauses
     d. registerListeners()            — lifecycle, storage, config events
     e. renderWorkbench()              — create Notifications, ARIA container
     f. createWorkbenchLayout()        — instantiate Parts (titlebar, sidebar, editor, panel, statusbar)
     g. layout()                       — compute and apply grid layout
     h. restore(lifecycleService)      — restore previous session (editors, views, panel size)
   })

3. Lifecycle phases fire: Starting → Ready → Restored → Eventually
```

`DesktopMain.open()` (electron-browser) runs before `Workbench.startup()`:
- Configures file service (local disk + remote providers)
- Connects to shared process and main process IPC channels
- Sets up configuration service with workspace settings
- Passes `ServiceCollection` to `Workbench` constructor

---

## Subsystems Reference

### Settings System

| Component | Path |
|-----------|------|
| Configuration registry | `src/vs/platform/configuration/common/configurationRegistry.ts` |
| Configuration service | `src/vs/platform/configuration/common/configurationService.ts` |
| Workspace configuration | `src/vs/workbench/services/configuration/browser/configurationService.ts` |
| Settings editor UI | `src/vs/workbench/contrib/preferences/browser/settingsEditor2/` |
| Settings JSON editor | `src/vs/workbench/services/preferences/common/preferencesEditorInput.ts` |
| Default settings | `src/vs/platform/configuration/common/configurationDefaults.ts` |

Settings layers (precedence low → high): defaults → user → remote → workspace → workspace folder → memory.

### Command Palette

| Component | Path |
|-----------|------|
| Quick access framework | `src/vs/platform/quickinput/` |
| Commands provider | `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts` |
| Registration | `src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts` |
| Trigger action | `workbench.action.showCommands` (registered via `registerAction2`) |

Collects all commands with `f1: true` from `CommandsRegistry` and extension-contributed commands.

### Menus

| Component | Path |
|-----------|------|
| Menu registry | `src/vs/platform/actions/common/actions.ts` → `MenuRegistry` |
| Menu bar (desktop) | `src/vs/workbench/services/menubar/electron-browser/menubarService.ts` |
| Context menus | `src/vs/platform/contextview/browser/contextMenuService.ts` |
| Title bar menus | `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` |

Menus are declarative: contributions specify `MenuId`, `group`, `order`, and `when` clauses (context keys).

### Terminal

| Component | Path |
|-----------|------|
| Terminal contrib | `src/vs/workbench/contrib/terminal/` |
| Terminal service | `src/vs/workbench/contrib/terminal/browser/terminalService.ts` |
| PTY host | `src/vs/platform/terminal/node/ptyHostMain.ts` |
| Process management | Spawns shell processes via pseudoterminal in separate process |

### Explorer

| Component | Path |
|-----------|------|
| Files contribution | `src/vs/workbench/contrib/files/browser/files.contribution.ts` |
| Explorer view | `src/vs/workbench/contrib/files/browser/views/explorerView.ts` |
| Explorer service | `src/vs/workbench/contrib/files/browser/explorerService.ts` |
| Viewlet registration | `src/vs/workbench/contrib/files/browser/explorerViewlet.ts` |

---

## Build & Launch

### Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | **24.18.0** (exact major; see `.nvmrc`) |
| npm | < 12.0.0 |
| Python | 3.x (for native modules) |
| macOS | Xcode Command Line Tools |

Install Node 24 on macOS:
```bash
brew install node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

### Build commands

```bash
cd vscode

# Install dependencies
npm install

# Compile TypeScript → out/
npm run compile
```

### Launch (development)

```bash
cd vscode

# IMPORTANT: Unset ELECTRON_RUN_AS_NODE if set by parent environment (e.g. Cursor)
unset ELECTRON_RUN_AS_NODE

./scripts/code.sh
```

Or directly:
```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1

./.build/electron/Code\ -\ OSS.app/Contents/MacOS/Code\ -\ OSS . \
  --disable-extension=vscode.vscode-api-tests
```

### Build artifacts

| Path | Contents |
|------|----------|
| `out/` | Compiled JavaScript |
| `.build/electron/` | Electron binary (downloaded by `npm run electron`) |
| `.build/builtInExtensions/` | Downloaded built-in marketplace extensions |

---

## Frame Development Notes

For future Frame milestones:

1. **Product customization** starts in `product.json` (names, icons, update URLs)
2. **Core modifications** go in `src/vs/workbench/` and `src/vs/platform/`
3. **New features** should follow the `contrib/` pattern with `*.contribution.ts` side-effect imports
4. **Extensions** for AI features should live in `extensions/` as a built-in extension
5. **Do not modify** `extensions/copilot/` until AI milestone — it compiles with the main build but is Microsoft's Copilot integration

This document reflects the codebase state at initial clone and successful build. Update as Frame development progresses.
