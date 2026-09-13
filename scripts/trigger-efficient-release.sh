#!/usr/bin/env bash
# Trigger GitHub Actions Efficient (Win/Linux) packaging from your Mac.
#
# Usage:
#   ./scripts/trigger-efficient-release.sh
#   ./scripts/trigger-efficient-release.sh --platform win64
#   ./scripts/trigger-efficient-release.sh --model-url 'https://cdn.example.com/frame-agent-v1-fused-q4_k_m.gguf'
#
# Requires: gh auth login, and either --model-url or repo secret FRAME_MODEL_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="both"
MODEL_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --model-url)
      MODEL_URL="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "error: install GitHub CLI (brew install gh) and run: gh auth login" >&2
  exit 1
fi

cd "$ROOT"

args=(workflow run package-efficient-release.yml -f "platform=$PLATFORM")
if [[ -n "$MODEL_URL" ]]; then
  args+=(-f "model_url=$MODEL_URL")
fi

echo "==> Triggering package-efficient-release.yml (platform=$PLATFORM)…"
gh "${args[@]}"

echo
echo "Watch progress:"
echo "  gh run watch"
echo
echo "When finished, download zips:"
echo "  gh run download --name Frame-Efficient-win64"
echo "  gh run download --name Frame-Efficient-linux64"
echo
echo "Then host the .zip on your CDN (too large for GitHub Release assets)."
echo "Website Download CTAs should point at GitHub Releases IDE packs:"
echo "  https://github.com/Zainulabdin007/Frame_IDE/releases/latest"
echo "  ./scripts/trigger-ide-release.sh --tag v0.1.0"
