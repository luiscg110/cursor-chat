#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CURSOR_AGENT_CWD="${CURSOR_AGENT_CWD:-/Users/luiscastro/Projects/acciones-ia}"
echo "[acciones] cwd=$CURSOR_AGENT_CWD"
echo "Abre Cursor Chat → pulsa Arrancar 24h (el foco ya es inversión paper+IA)."
open -n "$ROOT/apps/CursorChat.app"
