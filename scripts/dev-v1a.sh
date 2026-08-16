#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

IRA_TEST_MODE=1 uvicorn research_service.app:create_app --factory --host 127.0.0.1 --port 8010 --app-dir "$ROOT_DIR/services/research" & PIDS+=("$!")
IRA_RESEARCH_SERVICE_URL=http://127.0.0.1:8010 pnpm --dir "$ROOT_DIR" --filter @ira/chat-backend dev -- --host 127.0.0.1 --port 8020 & PIDS+=("$!")
pnpm --dir "$ROOT_DIR" --filter @ira/web dev -- --host 127.0.0.1 --port 5173 & PIDS+=("$!")
wait -n "${PIDS[@]}"
