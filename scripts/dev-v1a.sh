#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESEARCH_PYTHON="$ROOT_DIR/services/research/.venv/bin/python"
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for_any() {
  while true; do
    for pid in "${PIDS[@]}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        if wait "$pid"; then return 0; else return $?; fi
      fi
    done
    sleep 0.2
  done
}

trimmed_value() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

llm_api_key="$(trimmed_value "${LLM_API_KEY:-}")"
kimi_api_key="$(trimmed_value "${KIMI_API_KEY:-}")"
compat_profile="${LLM_COMPAT_PROFILE:-kimi}"

if [[ "$compat_profile" != "kimi" && "$compat_profile" != "openai" ]]; then
  echo "LLM_COMPAT_PROFILE must be kimi or openai." >&2
  exit 1
fi
if [[ "$compat_profile" == "openai" && -z "$llm_api_key" ]]; then
  echo "Set LLM_API_KEY for the openai compatibility profile." >&2
  exit 1
fi
if [[ "$compat_profile" == "kimi" && -z "$llm_api_key" && -z "$kimi_api_key" ]]; then
  echo "Set KIMI_API_KEY for the default Kimi endpoint, or LLM_API_KEY for an override." >&2
  exit 1
fi
if [[ "${1:-}" == "--validate-credentials" ]]; then
  exit 0
fi
if [[ ! -x "$RESEARCH_PYTHON" ]]; then
  echo "Create the research virtual environment before startup: services/research/.venv" >&2
  exit 1
fi

IRA_TEST_MODE=1 "$RESEARCH_PYTHON" -m uvicorn research_service.app:create_app --factory --host 127.0.0.1 --port 8010 --app-dir "$ROOT_DIR/services/research" & PIDS+=("$!")
IRA_RESEARCH_SERVICE_URL=http://127.0.0.1:8010 PORT=8020 pnpm --dir "$ROOT_DIR" --filter @ira/chat-backend dev & PIDS+=("$!")
pnpm --dir "$ROOT_DIR" --filter @ira/web dev --host 127.0.0.1 --port 5173 & PIDS+=("$!")
wait_for_any
