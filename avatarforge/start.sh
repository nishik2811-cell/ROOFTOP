#!/usr/bin/env bash
# One-command demo: builds the editor and serves it with the copilot server on http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d web/node_modules ]; then (cd web && npm install); fi
(cd web && npm run build)

if [ ! -d server/.venv ]; then
  python3 -m venv server/.venv
  server/.venv/bin/pip install -r server/requirements.txt
fi

echo
echo "AvatarForge: http://localhost:8000"
[ -z "${NVIDIA_API_KEY:-}" ] && echo "(No NVIDIA_API_KEY set: the copilot runs in offline mode.)"
cd server && exec .venv/bin/uvicorn app:app --port 8000
