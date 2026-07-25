#!/usr/bin/env bash
# Start LocalPointer (Code-OSS fork) with the local AI daemon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export LOCALPOINTER_DAEMON_URL="${LOCALPOINTER_DAEMON_URL:-http://127.0.0.1:9477}"

# Ensure daemon binary exists
if [[ ! -x "$ROOT/daemon/localpointer-daemon" ]]; then
  echo "Building daemon..."
  (cd "$ROOT/daemon" && go build -o localpointer-daemon .)
fi
ln -sfn "$ROOT/daemon/localpointer-daemon" "$ROOT/code-oss/extensions/localpointer-ai/bin/localpointer-daemon"

# Start daemon if not already up
if ! curl -sf "$LOCALPOINTER_DAEMON_URL/api/health" >/dev/null 2>&1; then
  echo "Starting LocalPointer daemon on $LOCALPOINTER_DAEMON_URL ..."
  HOST=127.0.0.1 PORT=9477 OLLAMA_BASE_URL="$OLLAMA_BASE_URL" \
    "$ROOT/daemon/localpointer-daemon" \
    >"$ROOT/daemon/daemon.log" 2>&1 &
  echo $! >"$ROOT/daemon/daemon.pid"
  for i in $(seq 1 30); do
    if curl -sf "$LOCALPOINTER_DAEMON_URL/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

echo "Ollama:  $OLLAMA_BASE_URL"
echo "Daemon:  $LOCALPOINTER_DAEMON_URL"
curl -sf "$LOCALPOINTER_DAEMON_URL/api/health" | head -c 200 || true
echo

cd "$ROOT/code-oss"
if [[ ! -f out/main.js ]]; then
  echo "Code-OSS is not compiled yet. Run: ./scripts/build.sh --ide"
  echo "This takes a while on first build."
  exit 1
fi

# Launch Electron app (scripts/code.sh)
exec ./scripts/code.sh "$@"
