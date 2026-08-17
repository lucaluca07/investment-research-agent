from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

import duckdb

_SCHEMA_VERSION = 2
_SCHEMA_FINGERPRINT = "agui-persistence-v2"
_REQUIRED_SCHEMA_COLUMNS = {
    "agui_schema_metadata": {"id", "schema_version", "schema_fingerprint", "created_at"},
    "threads": {"id", "title", "title_source", "title_locked", "created_at"},
    "runs": {
        "id", "thread_id", "idempotency_key", "model", "input_json", "input_hash", "status",
        "resumed_from_run_id", "resumed_from_step_id", "error_json", "created_at", "started_at",
        "completed_at",
    },
    "agui_events": {"thread_id", "sequence", "run_id", "event_type", "payload_json", "created_at"},
    "message_snapshots": {
        "id", "thread_id", "last_event_seq", "messages_json", "agent_state_json", "schema_version",
        "created_at",
    },
    "tool_calls": {
        "id", "thread_id", "run_id", "tool_operation_id", "tool_name", "arguments_json",
        "result_json", "step_status", "created_at",
    },
    "tool_operations": {
        "id", "idempotency_key", "thread_id", "run_id", "tool_name", "input_json", "input_hash",
        "status", "approval_id", "result_json", "error_json", "created_at",
    },
    "agent_checkpoints": {
        "id", "thread_id", "run_id", "tool_call_id", "interrupt_id", "pi_session_id",
        "pi_message_id", "last_event_seq", "agent_state_json", "created_at",
    },
    "resume_receipts": {
        "id", "thread_id", "interrupt_id", "status", "payload_hash", "payload_json",
        "tool_operation_id", "checkpoint_id", "created_at",
    },
}


class Database:
    """Owns one DuckDB connection for the lifetime of a service process."""

    def __init__(self, path: str = ":memory:") -> None:
        self.connection = duckdb.connect(path)
        self._transaction_lock = RLock()
        self._reject_incompatible_schema(path)
        schema = Path(__file__).with_name("schema.sql").read_text()
        self.connection.execute(schema)

    def _reject_incompatible_schema(self, path: str) -> None:
        """Require an explicit reset when opening a persisted pre-AG-UI database."""
        if path == ":memory:":
            return

        tables = {
            row[0]
            for row in self.connection.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main'"
            ).fetchall()
        }
        if not tables:
            return

        missing_tables = set(_REQUIRED_SCHEMA_COLUMNS) - tables
        if missing_tables:
            self._raise_incompatible_schema()

        columns_by_table = {
            table_name: {
                row[0]
                for row in self.connection.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'main' AND table_name = ?",
                    [table_name],
                ).fetchall()
            }
            for table_name in _REQUIRED_SCHEMA_COLUMNS
        }
        if any(
            required_columns - columns_by_table[table_name]
            for table_name, required_columns in _REQUIRED_SCHEMA_COLUMNS.items()
        ):
            self._raise_incompatible_schema()

        metadata = self.connection.execute(
            "SELECT schema_version, schema_fingerprint FROM agui_schema_metadata WHERE id = 1"
        ).fetchone()
        if metadata != (_SCHEMA_VERSION, _SCHEMA_FINGERPRINT):
            self._raise_incompatible_schema()

    def _raise_incompatible_schema(self) -> None:
        self.connection.close()
        raise RuntimeError(
            "Incompatible research database schema. Reset the development database "
            "explicitly with `pnpm db:reset:dev`."
        )

    @contextmanager
    def transaction(self) -> Iterator[duckdb.DuckDBPyConnection]:
        with self._transaction_lock:
            self.connection.execute("BEGIN TRANSACTION")
            try:
                yield self.connection
            except Exception:
                self.connection.execute("ROLLBACK")
                raise
            else:
                self.connection.execute("COMMIT")

    @contextmanager
    def read(self) -> Iterator[duckdb.DuckDBPyConnection]:
        with self._transaction_lock:
            yield self.connection

    def close(self) -> None:
        self.connection.close()
