#!/usr/bin/env bash
# Trigger GitHub Actions IDE-only packaging + GitHub Release publish.
#
# Usage:
#   ./scripts/trigger-ide-release.sh --tag v0.1.0
#   ./scripts/trigger-ide-release.sh --tag v0.1.0 --platform win64
#   ./scripts/trigger-ide-release.sh --tag v0.1.0 --platform win-linux
#   ./scripts/trigger-ide-release.sh --tag v0.1.0-beta.1 --platform all --prerelease false
#
# Requires: gh auth login
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="win-linux"
TAG=""
PRERELEASE="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --prerelease)
      PRERELEASE="${2:-true}"
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

if [[ -z "$TAG" ]]; then
  echo "error: --tag is required (e.g. v0.1.0)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: install GitHub CLI (brew install gh) and run: gh auth login" >&2
  exit 1
fi

cd "$ROOT"

echo "==> Triggering publish-ide-release.yml (platform=$PLATFORM tag=$TAG)…"
gh workflow run publish-ide-release.yml \
  -f "platform=$PLATFORM" \
  -f "tag=$TAG" \
  -f "prerelease=$PRERELEASE"

echo
echo "Watch progress:"
echo "  gh run watch"
echo
echo "When finished, open:"
echo "  https://github.com/Zainulabdin007/Frame_IDE/releases/tag/$TAG"
echo "  https://github.com/Zainulabdin007/Frame_IDE/releases/latest"
