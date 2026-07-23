#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@24/bin:${PATH}"
# Cursor injects this and breaks Electron; always clear it.
unset ELECTRON_RUN_AS_NODE
export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export ELECTRON_ENABLE_LOGGING=1
# Frame: do not load GitHub Copilot built-ins (sign-in + cloud models).
export VSCODE_SKIP_BUILTIN_EXTENSIONS="GitHub.copilot,GitHub.copilot-chat,GitHub.copilot-chat-nightly"
# Ensure home fallback config exists (empty-window / no-folder sessions).
mkdir -p "${HOME}/.frame/config"
if [[ ! -f "${HOME}/.frame/config/runtime.json" && -f "${ROOT}/.frame/config/runtime.json" ]]; then
  cp "${ROOT}/.frame/config/runtime.json" "${HOME}/.frame/config/runtime.json"
fi
# Quit stale Frame windows so we don't reuse an empty workspace without the new build.
# Set FRAME_KEEP_RUNNING=1 to skip (e.g. multi-window workflows).
if [[ "${FRAME_KEEP_RUNNING:-}" != "1" ]]; then
  pkill -f "/.build/electron/Frame.app/Contents/MacOS/Frame" 2>/dev/null || true
  pkill -f "/.build/electron/Frame Dev.app/Contents/MacOS/Frame" 2>/dev/null || true
  sleep 1
fi
cd "$ROOT/vscode"
mkdir -p out/vs/workbench/browser/media/fonts
cp -R src/vs/workbench/browser/media/fonts/. out/vs/workbench/browser/media/fonts/ 2>/dev/null || true
cp -f src/vs/workbench/browser/media/style.css out/vs/workbench/browser/media/style.css 2>/dev/null || true
cp -f src/vs/workbench/browser/media/code-icon.svg out/vs/workbench/browser/media/code-icon.svg 2>/dev/null || true
mkdir -p out/vs/workbench/browser/parts/editor/media out/vs/sessions/browser/media
cp -f src/vs/workbench/browser/parts/editor/media/letterpress-*.svg out/vs/workbench/browser/parts/editor/media/ 2>/dev/null || true
cp -f src/vs/sessions/browser/media/sessions-logo-*.svg out/vs/sessions/browser/media/ 2>/dev/null || true
# Fresh window + Frame repo workspace so `.frame/config/runtime.json` is found.
exec ./scripts/code.sh \
  --disable-extension=GitHub.copilot \
  --disable-extension=GitHub.copilot-chat \
  --disable-extension=GitHub.copilot-chat-nightly \
  --new-window \
  "$ROOT" \
  "$@"
