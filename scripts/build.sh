#!/usr/bin/env bash
# Build LocalPointer daemon + (optionally) compile Code-OSS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building localpointer-daemon"
cd "$ROOT/daemon"
go build -o localpointer-daemon .
ln -sfn "$ROOT/daemon/localpointer-daemon" "$ROOT/code-oss/extensions/localpointer-ai/bin/localpointer-daemon"
echo "    OK: $ROOT/daemon/localpointer-daemon"

if [[ "${1:-}" == "--ide" || "${1:-}" == "all" ]]; then
  echo "==> Compiling Code-OSS (LocalPointer)"
  cd "$ROOT/code-oss"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  npm run gulp -- compile
  npm run gulp -- compile-extension:localpointer-ai
  echo "    OK: run ./scripts/start-localpointer.sh"
fi

echo "Done."
