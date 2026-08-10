#!/usr/bin/env bash
# Build a one-click website download: Frame IDE + Efficient 4-bit fused LoRA GGUF.
#
# Usage:
#   ./scripts/package-efficient-release.sh --platform win64
#   ./scripts/package-efficient-release.sh --platform linux64
#   ./scripts/package-efficient-release.sh --platform win64 --build   # also run gulp
#
# Prerequisites:
#   - Fused Q4 GGUF at resources/frame-models/frame-agent-v1-fused-q4_k_m.gguf
#     (or set FRAME_MODEL_GGUF=/path/to.gguf)
#   - Packaged IDE at VSCode-win32-x64/ or VSCode-linux-x64/ (sibling of vscode/)
#     unless --build is passed (must run on that OS / CI)
#
# Output:
#   dist/Frame-Efficient-<platform>.zip (+ .sha256)
#   Layout inside zip:
#     Frame/                          # IDE
#     Frame/resources/frame-models/   # bundled GGUF (auto-detected on first launch)
#     models/                         # same GGUF (sibling fallback)
#     README.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM=""
DO_BUILD=0
MODEL_NAME="frame-agent-v1-fused-q4_k_m.gguf"
MODEL_SRC="${FRAME_MODEL_GGUF:-$ROOT/resources/frame-models/$MODEL_NAME}"

usage() {
  cat <<'EOF'
Usage: package-efficient-release.sh --platform win64|linux64 [--build]

  --platform   Target OS bundle (win64 or linux64)
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
  echo "error: --platform win64|linux64 is required" >&2
  usage >&2
  exit 1
fi

case "$PLATFORM" in
  win64)
    GULP_TASK="vscode-win32-x64"
    IDE_SRC="$ROOT/VSCode-win32-x64"
    BUNDLE_NAME="Frame-Efficient-win64"
    ;;
  linux64)
    GULP_TASK="vscode-linux-x64"
    IDE_SRC="$ROOT/VSCode-linux-x64"
    BUNDLE_NAME="Frame-Efficient-linux64"
    ;;
  *)
    echo "error: unsupported platform '$PLATFORM' (use win64 or linux64)" >&2
    exit 1
    ;;
esac

if [[ ! -f "$MODEL_SRC" ]]; then
  cat >&2 <<EOF
error: missing fused 4-bit model:
  $MODEL_SRC

Install it first, e.g.:
  python tools/frame-lora-train/scripts/install_fused_base_model.py \\
    --src tools/frame-lora-train/adapters/frame-agent-v2-gguf/frame-agent-v2-fused-q4_k_m.gguf
EOF
  exit 1
fi

export PATH="/opt/homebrew/opt/node@24/bin:${PATH:-}"
unset ELECTRON_RUN_AS_NODE

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> Building IDE ($GULP_TASK)…"
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
  cd vscode && npm install && npm run gulp $GULP_TASK

Or re-run with --build on that OS.
EOF
  exit 1
fi

OUT_DIR="$ROOT/dist/$BUNDLE_NAME"
ZIP_PATH="$ROOT/dist/${BUNDLE_NAME}.zip"
SHA_PATH="$ROOT/dist/${BUNDLE_NAME}.zip.sha256"

echo "==> Assembling $BUNDLE_NAME…"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/Frame" "$OUT_DIR/models" "$OUT_DIR/Frame/resources/frame-models"

# IDE
cp -R "$IDE_SRC"/. "$OUT_DIR/Frame/"

# Model — prefer APFS clone / hardlink when possible to save space+time
copy_model() {
  local dest="$1"
  if cp -c "$MODEL_SRC" "$dest" 2>/dev/null; then
    return 0
  fi
  if ln "$MODEL_SRC" "$dest" 2>/dev/null; then
    return 0
  fi
  cp "$MODEL_SRC" "$dest"
}

copy_model "$OUT_DIR/models/$MODEL_NAME"
copy_model "$OUT_DIR/Frame/resources/frame-models/$MODEL_NAME"

cat > "$OUT_DIR/README.txt" <<EOF
Frame Efficient (4-bit) — IDE + Frame agent model

Contents
  Frame/     Frame IDE
  models/    Fused Q4_K_M GGUF (LoRA baked in)

Install
  1. Unzip this archive.
  2. Run Frame from the Frame folder.
  3. On first launch Frame auto-loads:
       Frame/resources/frame-models/$MODEL_NAME
     (or the copy under models/)

No separate model download or path setup is required.

Website download button should point at this zip file.
EOF

echo "==> Zipping (this may take a few minutes for ~4.4GB)…"
mkdir -p "$ROOT/dist"
rm -f "$ZIP_PATH" "$SHA_PATH"
(
  cd "$ROOT/dist"
  if command -v zip >/dev/null 2>&1; then
    zip -r -y "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
  elif command -v 7z >/dev/null 2>&1; then
    7z a -tzip -mx=0 "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
  elif command -v 7za >/dev/null 2>&1; then
    7za a -tzip -mx=0 "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
  elif [[ -x "/c/Program Files/7-Zip/7z.exe" ]]; then
    "/c/Program Files/7-Zip/7z.exe" a -tzip -mx=0 "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
  else
    # Last resort (may produce a .zip via libarchive on some systems)
    tar -a -cf "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
  fi
)

if command -v shasum >/dev/null 2>&1; then
  (cd "$ROOT/dist" && shasum -a 256 "${BUNDLE_NAME}.zip" > "${BUNDLE_NAME}.zip.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$ROOT/dist" && sha256sum "${BUNDLE_NAME}.zip" > "${BUNDLE_NAME}.zip.sha256")
elif command -v powershell.exe >/dev/null 2>&1; then
  (cd "$ROOT/dist" && powershell.exe -NoProfile -Command \
    "(Get-FileHash -Algorithm SHA256 '${BUNDLE_NAME}.zip').Hash.ToLower() + '  ${BUNDLE_NAME}.zip'" \
    > "${BUNDLE_NAME}.zip.sha256")
fi

echo
echo "Done."
echo "  Bundle: $ZIP_PATH"
[[ -f "$SHA_PATH" ]] && echo "  SHA256: $SHA_PATH"
echo
echo "Host the zip on your CDN, then:"
echo "  <a href=\"https://YOUR_CDN/${BUNDLE_NAME}.zip\">Download Frame</a>"
