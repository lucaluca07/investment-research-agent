from pathlib import Path

import duckdb
import pytest

from research_service.db import Database


@pytest.fixture
def database():
    instance = Database(":memory:")
    try:
        yield instance
    finally:
        instance.close()


def test_agui_schema_includes_durable_tables(database):
    tables = {
        row[0]
        for row in database.connection.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main'"
        ).fetchall()
    }

    assert {
        "threads",
        "runs",
        "agui_events",
        "message_snapshots",
        "tool_calls",
        "tool_operations",
        "agent_checkpoints",
        "resume_receipts",
    } <= tables


def test_agui_events_are_unique_per_thread_sequence(database):
    with database.transaction() as connection:
        connection.execute("INSERT INTO threads (id) VALUES ('thread-1')")
        connection.execute(
            "INSERT INTO agui_events (thread_id, sequence, event_type, payload_json) "
            "VALUES ('thread-1', 1, 'RUN_STARTED', '{}')"
        )
        with pytest.raises(Exception, match="PRIMARY KEY|Duplicate key|Constraint"):
            connection.execute(
                "INSERT INTO agui_events (thread_id, sequence, event_type, payload_json) "
                "VALUES ('thread-1', 1, 'RUN_STARTED', '{}')"
            )


def test_agui_status_constraints_reject_invalid_values(database):
    connection = database.connection
    connection.execute("INSERT INTO threads (id) VALUES ('thread-1')")

    with pytest.raises(Exception, match="CHECK|Constraint"):
        connection.execute(
            "INSERT INTO runs (id, thread_id, idempotency_key, status) "
            "VALUES ('run-invalid', 'thread-1', 'run-key-invalid', 'succeeded')"
        )

    connection.execute(
        "INSERT INTO runs (id, thread_id, idempotency_key, status) "
        "VALUES ('run-1', 'thread-1', 'run-key-1', 'pending')"
    )
    with pytest.raises(Exception, match="CHECK|Constraint"):
        connection.execute(
            "INSERT INTO tool_calls (id, thread_id, run_id, step_status) "
            "VALUES ('call-invalid', 'thread-1', 'run-1', 'completed')"
        )
    with pytest.raises(Exception, match="CHECK|Constraint"):
        connection.execute(
            "INSERT INTO tool_operations (id, thread_id, run_id, idempotency_key, status) "
            "VALUES ('operation-invalid', 'thread-1', 'run-1', 'operation-key-invalid', 'pending')"
        )


def test_agui_idempotency_constraints(database):
    connection = database.connection
    connection.execute("INSERT INTO threads (id) VALUES ('thread-1')")
    connection.execute("INSERT INTO threads (id) VALUES ('thread-2')")
    connection.execute(
        "INSERT INTO runs (id, thread_id, idempotency_key, status) "
        "VALUES ('run-1', 'thread-1', 'run-key', 'pending')"
    )
    with pytest.raises(Exception, match="UNIQUE|Duplicate key|Constraint"):
        connection.execute(
            "INSERT INTO runs (id, thread_id, idempotency_key, status) "
            "VALUES ('run-2', 'thread-1', 'run-key', 'pending')"
        )
    connection.execute(
        "INSERT INTO resume_receipts "
        "(id, thread_id, interrupt_id, status, payload_hash, payload_json) "
        "VALUES ('receipt-1', 'thread-1', 'interrupt-1', 'resolved', 'hash-1', '{}')"
    )
    with pytest.raises(Exception, match="UNIQUE|Duplicate key|Constraint"):
        connection.execute(
            "INSERT INTO resume_receipts "
            "(id, thread_id, interrupt_id, status, payload_hash, payload_json) "
            "VALUES ('receipt-2', 'thread-1', 'interrupt-1', 'resolved', 'hash-1', '{}')"
        )
    connection.execute(
        "INSERT INTO tool_operations (id, thread_id, run_id, idempotency_key, status) "
        "VALUES ('operation-1', 'thread-1', 'run-1', 'operation-key', 'proposed')"
    )
    with pytest.raises(Exception, match="UNIQUE|Duplicate key|Constraint"):
        connection.execute(
            "INSERT INTO tool_operations (id, thread_id, run_id, idempotency_key, status) "
            "VALUES ('operation-2', 'thread-1', 'run-1', 'operation-key', 'proposed')"
        )


def test_existing_incompatible_database_requires_explicit_development_reset(tmp_path):
    path = tmp_path / "research.duckdb"
    legacy_connection = duckdb.connect(str(path))
    legacy_connection.execute("CREATE TABLE chats (id VARCHAR PRIMARY KEY)")
    legacy_connection.close()

    with pytest.raises(RuntimeError, match="pnpm db:reset:dev"):
        Database(str(path))


def test_agui_relationships_reject_cross_thread_references(database):
    connection = database.connection
    connection.execute("INSERT INTO threads (id) VALUES ('thread-1')")
    connection.execute("INSERT INTO threads (id) VALUES ('thread-2')")
    connection.execute(
        "INSERT INTO runs (id, thread_id, idempotency_key, status) "
        "VALUES ('run-1', 'thread-1', 'run-key-1', 'pending')"
    )
    connection.execute(
        "INSERT INTO runs (id, thread_id, idempotency_key, status) "
        "VALUES ('run-2', 'thread-2', 'run-key-2', 'pending')"
    )

    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO runs (id, thread_id, idempotency_key, status, resumed_from_run_id) "
            "VALUES ('run-cross-thread', 'thread-2', 'run-key-cross', 'pending', 'run-1')"
        )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO agui_events (thread_id, sequence, run_id, event_type, payload_json) "
            "VALUES ('thread-2', 1, 'run-1', 'RUN_STARTED', '{}')"
        )
    connection.execute(
        "INSERT INTO agui_events (thread_id, sequence, run_id, event_type, payload_json) "
        "VALUES ('thread-1', 1, 'run-1', 'RUN_STARTED', '{}')"
    )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO message_snapshots "
            "(id, thread_id, last_event_seq, messages_json, agent_state_json, schema_version) "
            "VALUES ('snapshot-cross-thread', 'thread-2', 1, '[]', '{}', 1)"
        )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO tool_calls (id, thread_id, run_id, step_status) "
            "VALUES ('tool-call-cross-thread', 'thread-2', 'run-1', 'pending')"
        )

    connection.execute(
        "INSERT INTO tool_operations (id, thread_id, idempotency_key, run_id, status) "
        "VALUES ('operation-1', 'thread-1', 'operation-key-1', 'run-1', 'proposed')"
    )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO tool_operations (id, thread_id, idempotency_key, run_id, status) "
            "VALUES ('operation-cross-thread', 'thread-2', 'operation-key-cross', 'run-1', 'proposed')"
        )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO agent_checkpoints "
            "(id, thread_id, run_id, interrupt_id, last_event_seq) "
            "VALUES ('checkpoint-cross-thread', 'thread-2', 'run-1', 'interrupt-1', 1)"
        )

    connection.execute(
        "INSERT INTO agent_checkpoints "
        "(id, thread_id, run_id, interrupt_id, last_event_seq) "
        "VALUES ('checkpoint-1', 'thread-1', 'run-1', 'interrupt-1', 1)"
    )
    with pytest.raises(Exception, match="FOREIGN KEY|Constraint"):
        connection.execute(
            "INSERT INTO resume_receipts "
            "(id, thread_id, interrupt_id, status, payload_hash, payload_json, "
            "tool_operation_id, checkpoint_id) "
            "VALUES ('receipt-cross-thread', 'thread-2', 'interrupt-1', 'resolved', 'hash-1', "
            "'{}', 'operation-1', 'checkpoint-1')"
        )


def test_tool_operations_require_thread_and_run(database):
    connection = database.connection
    connection.execute("INSERT INTO threads (id) VALUES ('thread-1')")
    connection.execute(
        "INSERT INTO runs (id, thread_id, idempotency_key, status) "
        "VALUES ('run-1', 'thread-1', 'run-key-1', 'pending')"
    )

    with pytest.raises(Exception, match="NOT NULL|Constraint"):
        connection.execute(
            "INSERT INTO tool_operations (id, run_id, idempotency_key, status) "
            "VALUES ('operation-no-thread', 'run-1', 'operation-key-1', 'proposed')"
        )
    with pytest.raises(Exception, match="NOT NULL|Constraint"):
        connection.execute(
            "INSERT INTO tool_operations (id, thread_id, idempotency_key, status) "
            "VALUES ('operation-no-run', 'thread-1', 'operation-key-2', 'proposed')"
        )


def test_previous_nullable_tool_operations_schema_requires_explicit_reset(tmp_path):
    path = tmp_path / "research.duckdb"
    schema = (Path(__file__).parents[1] / "research_service" / "schema.sql").read_text()
    previous_schema = (
        schema.replace(
            "VALUES (1, 3, 'agui-persistence-v3')",
            "VALUES (1, 1, 'agui-persistence-v1')",
        )
        .replace("thread_id VARCHAR NOT NULL,\n  run_id VARCHAR NOT NULL", "thread_id VARCHAR,\n  run_id VARCHAR")
    )
    connection = duckdb.connect(str(path))
    connection.execute(previous_schema)
    connection.close()

    with pytest.raises(RuntimeError, match="Incompatible research database schema"):
        Database(str(path))


def test_same_named_partial_agui_schema_requires_explicit_development_reset(tmp_path):
    path = tmp_path / "research.duckdb"
    connection = duckdb.connect(str(path))
    for table_name in (
        "threads",
        "runs",
        "agui_events",
        "message_snapshots",
        "tool_calls",
        "tool_operations",
        "agent_checkpoints",
        "resume_receipts",
    ):
        connection.execute(f"CREATE TABLE {table_name} (id VARCHAR PRIMARY KEY)")
    connection.close()

    with pytest.raises(RuntimeError, match="Incompatible research database schema"):
        Database(str(path))
