#!/usr/bin/env bash
# Package Frame IDE only (no GGUF) for GitHub Releases (<2GB asset limit).
#
# Usage:
#   ./scripts/package-ide-release.sh --platform win64
#   ./scripts/package-ide-release.sh --platform linux64
#   ./scripts/package-ide-release.sh --platform darwin-arm64
#   ./scripts/package-ide-release.sh --platform win64 --build
#
# Prerequisites:
#   Packaged IDE at VSCode-win32-x64/ | VSCode-linux-x64/ | VSCode-darwin-arm64/
#   (sibling of vscode/) unless --build is passed on a matching OS/CI runner.
#
# Output under dist/:
#   Frame-IDE-win64.zip (+ .sha256)
#   Frame-IDE-linux64.tar.gz (+ .sha256)
#   Frame-macOS-arm64.dmg (+ .sha256)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM=""
DO_BUILD=0

usage() {
  cat <<'EOF'
Usage: package-ide-release.sh --platform win64|linux64|darwin-arm64 [--build]

  --platform   Target OS bundle
  --build      Run gulp package for that platform first (needs matching OS/CI)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --build)
      DO_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PLATFORM" ]]; then
  echo "error: --platform win64|linux64|darwin-arm64 is required" >&2
  usage >&2
  exit 1
fi

case "$PLATFORM" in
  win64)
    GULP_TASK="vscode-win32-x64"
    IDE_SRC="$ROOT/VSCode-win32-x64"
    BUNDLE_NAME="Frame-IDE-win64"
    ARTIFACT_EXT="zip"
    ;;
  linux64)
    GULP_TASK="vscode-linux-x64"
    IDE_SRC="$ROOT/VSCode-linux-x64"
    BUNDLE_NAME="Frame-IDE-linux64"
    ARTIFACT_EXT="tar.gz"
    ;;
  darwin-arm64)
    GULP_TASK="vscode-darwin-arm64"
    IDE_SRC="$ROOT/VSCode-darwin-arm64"
    BUNDLE_NAME="Frame-macOS-arm64"
    ARTIFACT_EXT="dmg"
    ;;
  *)
    echo "error: unsupported platform '$PLATFORM' (use win64, linux64, or darwin-arm64)" >&2
    exit 1
    ;;
esac

export PATH="/opt/homebrew/opt/node@24/bin:${PATH:-}"
unset ELECTRON_RUN_AS_NODE

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> Building IDE (${GULP_TASK})..."
  (
    cd "$ROOT/vscode"
    npm run gulp "$GULP_TASK"
  )
fi

if [[ ! -d "$IDE_SRC" ]]; then
  cat >&2 <<EOF
error: IDE build not found at:
  $IDE_SRC

Build on a $PLATFORM machine / CI:
  cd vscode && npm ci && npm run gulp $GULP_TASK

Or re-run with --build on that OS.
EOF
  exit 1
fi

mkdir -p "$ROOT/dist"
OUT_DIR="$ROOT/dist/$BUNDLE_NAME"
rm -rf "$OUT_DIR"

write_readme() {
  local dest="$1"
  cat > "$dest" <<EOF
Frame IDE (no model bundled)

This archive is the Frame editor only. The on-device Efficient GGUF is
installed after launch from the Models sidebar (or a CDN URL you configure).

Why split?
  GitHub Release assets are limited to 2GB. The fused Efficient model alone
  is ~4GB, so it cannot ship inside this installer.

Install
  1. Unpack / open this package for your OS.
  2. Launch Frame.
  3. Open the Frame sidebar -> Models -> install Efficient (4-bit).

Releases: https://github.com/Zainulabdin007/Frame_IDE/releases/latest
EOF
}

sha_file() {
  local file="$1"
  local base
  base="$(basename "$file")"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$(dirname "$file")" && shasum -a 256 "$base" > "${base}.sha256")
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$file")" && sha256sum "$base" > "${base}.sha256")
  fi
}

echo "==> Assembling IDE-only ${BUNDLE_NAME}..."

case "$PLATFORM" in
  win64)
    mkdir -p "$OUT_DIR"
    cp -R "$IDE_SRC"/. "$OUT_DIR/"
    write_readme "$OUT_DIR/README.txt"
    ARTIFACT="$ROOT/dist/${BUNDLE_NAME}.zip"
    rm -f "$ARTIFACT" "${ARTIFACT}.sha256"
    (
      cd "$ROOT/dist"
      if command -v zip >/dev/null 2>&1; then
        zip -r -y "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
      elif command -v 7z >/dev/null 2>&1; then
        7z a -tzip -mx=0 "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
      else
        tar -a -cf "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
      fi
    )
    sha_file "$ARTIFACT"
    ;;
  linux64)
    mkdir -p "$OUT_DIR"
    cp -R "$IDE_SRC"/. "$OUT_DIR/"
    write_readme "$OUT_DIR/README.txt"
    ARTIFACT="$ROOT/dist/${BUNDLE_NAME}.tar.gz"
    rm -f "$ARTIFACT" "${ARTIFACT}.sha256"
    (
      cd "$ROOT/dist"
      tar -czf "${BUNDLE_NAME}.tar.gz" "$BUNDLE_NAME"
    )
    sha_file "$ARTIFACT"
    ;;
  darwin-arm64)
    # Prefer .app inside the packaged folder; fall back to the folder itself.
    APP_SRC=""
    if [[ -d "$IDE_SRC/Frame.app" ]]; then
      APP_SRC="$IDE_SRC/Frame.app"
    else
      # Some builds place Frame.app as the only child
      for cand in "$IDE_SRC"/*.app; do
        if [[ -d "$cand" ]]; then
          APP_SRC="$cand"
          break
        fi
      done
    fi
    if [[ -z "$APP_SRC" ]]; then
      echo "error: no Frame.app found under $IDE_SRC" >&2
      ls -la "$IDE_SRC" >&2 || true
      exit 1
    fi

    STAGE="$ROOT/dist/.dmg-stage-$BUNDLE_NAME"
    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    cp -R "$APP_SRC" "$STAGE/Frame.app"
    write_readme "$STAGE/README.txt"
    ln -sf /Applications "$STAGE/Applications"

    ARTIFACT="$ROOT/dist/${BUNDLE_NAME}.dmg"
    rm -f "$ARTIFACT" "${ARTIFACT}.sha256"
    # Unsigned beta DMG - Gatekeeper will warn until notarized.
    hdiutil create \
      -volname "Frame" \
      -srcfolder "$STAGE" \
      -ov \
      -format UDZO \
      "$ARTIFACT"
    rm -rf "$STAGE"
    sha_file "$ARTIFACT"
    ;;
esac

echo
echo "Done (IDE only - no GGUF)."
echo "  Artifact: $ARTIFACT"
[[ -f "${ARTIFACT}.sha256" ]] && echo "  SHA256:   ${ARTIFACT}.sha256"
echo
echo "Publish to GitHub Releases (assets stay under 2GB):"
echo "  gh release upload <tag> \"$ARTIFACT\" \"${ARTIFACT}.sha256\" --clobber"
echo
echo "After install, users pull Efficient from the Models sidebar / CDN."
