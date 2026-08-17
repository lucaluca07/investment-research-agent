#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUNTIME_DIR="$ROOT_DIR/.ira-runtime"
if [[ "${IRA_RESEARCH_DB_PATH+x}" == "x" ]]; then
  DATABASE_PATH="$IRA_RESEARCH_DB_PATH"
else
  DATABASE_PATH="${IRA_RUNTIME_DIR:-$RUNTIME_DIR}/research.duckdb"
fi

trimmed_path="$(printf '%s' "$DATABASE_PATH" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$trimmed_path" ]]; then
  echo "IRA_RESEARCH_DB_PATH must not be empty." >&2
  exit 1
fi
if [[ "$trimmed_path" != /* ]]; then
  trimmed_path="$ROOT_DIR/$trimmed_path"
fi
if [[ -d "$trimmed_path" ]]; then
  echo "Refusing to reset a directory: $trimmed_path" >&2
  exit 1
fi
if [[ "$(basename "$trimmed_path")" != "research.duckdb" ]]; then
  echo "Refusing to reset a file other than research.duckdb: $trimmed_path" >&2
  exit 1
fi
resolved_database_dir="$(cd "$(dirname "$trimmed_path")" 2>/dev/null && pwd -P)" || {
  echo "Database parent directory does not exist: $(dirname "$trimmed_path")" >&2
  exit 1
}
if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "Development runtime directory does not exist: $RUNTIME_DIR" >&2
  exit 1
fi
resolved_runtime_dir="$(cd "$RUNTIME_DIR" && pwd -P)"
if [[ "$resolved_database_dir" != "$resolved_runtime_dir" ]]; then
  echo "Database must be located under the repository .ira-runtime directory." >&2
  exit 1
fi

database_file="$resolved_runtime_dir/research.duckdb"
if [[ -e "$database_file" ]]; then
  rm -- "$database_file"
  echo "Removed development database: $database_file"
else
  echo "No development database to remove: $database_file"
fi
