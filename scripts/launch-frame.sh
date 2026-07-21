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
cd "$ROOT/vscode"
mkdir -p out/vs/workbench/browser/media/fonts
cp -R src/vs/workbench/browser/media/fonts/. out/vs/workbench/browser/media/fonts/ 2>/dev/null || true
cp -f src/vs/workbench/browser/media/style.css out/vs/workbench/browser/media/style.css 2>/dev/null || true
cp -f src/vs/workbench/browser/media/code-icon.svg out/vs/workbench/browser/media/code-icon.svg 2>/dev/null || true
mkdir -p out/vs/workbench/browser/parts/editor/media out/vs/sessions/browser/media
cp -f src/vs/workbench/browser/parts/editor/media/letterpress-*.svg out/vs/workbench/browser/parts/editor/media/ 2>/dev/null || true
cp -f src/vs/sessions/browser/media/sessions-logo-*.svg out/vs/sessions/browser/media/ 2>/dev/null || true
exec ./scripts/code.sh "$@"
