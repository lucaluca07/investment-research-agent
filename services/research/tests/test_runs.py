import threading
import time

import pytest

from research_service.db import Database
from research_service.runs import IllegalTransition, RunStore


@pytest.fixture
def store():
    database = Database(":memory:")
    try:
        yield RunStore(database)
    finally:
        database.close()


def test_waiting_approval_can_resume_or_cancel(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    step = store.start_step(run.id, "save_note", "key-1", "sha256:abc")
    store.request_approval(step.id, {"note": "draft"})
    assert store.get_step(step.id).status == "waiting_approval"
    store.approve(step.id, actor="local-user")
    assert store.get_step(step.id).status == "running"
    approval = store.get_approval(step.id)
    assert approval.status == "approved"


def test_rejection_cancels_waiting_approval(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    step = store.start_step(run.id, "save_note", "key-1", "sha256:abc")
    store.request_approval(step.id, {"note": "draft"})
    store.reject(step.id, actor="local-user", reason="not ready")
    assert store.get_step(step.id).status == "cancelled"
    assert store.get_approval(step.id).status == "rejected"


def test_create_run_returns_persisted_created_at(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    assert run.created_at is not None


def test_succeeded_step_returns_original_result_for_same_idempotency_key(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    first = store.start_step(run.id, "save_note", "stable-key", "sha256:abc")
    store.succeed(first.id, {"note_id": "note-1"})
    replay = store.start_step(run.id, "save_note", "stable-key", "sha256:abc")
    assert replay.id == first.id
    assert replay.result == {"note_id": "note-1"}


def test_same_idempotency_key_with_different_input_is_rejected(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    store.start_step(run.id, "save_note", "stable-key", "sha256:abc")
    with pytest.raises(ValueError, match="input hash"):
        store.start_step(run.id, "save_note", "stable-key", "sha256:def")


def test_illegal_transition_is_rejected(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    step = store.start_step(run.id, "save_note", "key-1", "sha256:abc")
    store.succeed(step.id, {"ok": True})
    with pytest.raises(IllegalTransition):
        store.approve(step.id, actor="local-user")


def test_failed_step_retries_only_when_retryable(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    retryable = store.start_step(run.id, "query", "key-1", "sha256:abc")
    store.fail(retryable.id, {"message": "timeout"}, retryable=True)
    store.retry(retryable.id)
    assert store.get_step(retryable.id).status == "running"

    permanent = store.start_step(run.id, "query", "key-2", "sha256:def")
    store.fail(permanent.id, {"message": "invalid"}, retryable=False)
    with pytest.raises(IllegalTransition):
        store.retry(permanent.id)


def test_transactions_on_one_connection_are_serialized(store):
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def hold_transaction():
        with store.database.transaction():
            entered.set()
            release.wait(timeout=2)

    def create_run():
        store.create_run(chat_id="chat-2", pi_session_id="pi-2", model="test/model")
        finished.set()

    holder = threading.Thread(target=hold_transaction)
    writer = threading.Thread(target=create_run)
    holder.start()
    assert entered.wait(timeout=2)
    writer.start()
    time.sleep(0.05)
    assert not finished.is_set()
    release.set()
    holder.join(timeout=2)
    writer.join(timeout=2)
    assert finished.is_set()


def test_reads_wait_for_a_write_transaction(store):
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def hold_write():
        with store.database.transaction():
            entered.set()
            release.wait(timeout=2)

    def read_connection():
        with store.database.read() as connection:
            connection.execute("SELECT 1").fetchone()
        finished.set()

    writer = threading.Thread(target=hold_write)
    reader = threading.Thread(target=read_connection)
    writer.start()
    assert entered.wait(timeout=2)
    reader.start()
    time.sleep(0.05)
    assert not finished.is_set()
    release.set()
    writer.join(timeout=2)
    reader.join(timeout=2)
    assert finished.is_set()


def test_transaction_rolls_back_failed_write(store):
    with pytest.raises(RuntimeError), store.database.transaction() as connection:
        connection.execute("INSERT INTO chats (id) VALUES ('rollback-chat')")
        raise RuntimeError("abort")
    assert store.database.connection.execute(
        "SELECT COUNT(*) FROM chats WHERE id = 'rollback-chat'"
    ).fetchone()[0] == 0


def test_file_database_persists_runs(tmp_path):
    path = str(tmp_path / "research.duckdb")
    database = Database(path)
    run = RunStore(database).create_run("chat-1", "pi-1", "test/model")
    database.close()

    reopened = Database(path)
    try:
        persisted = reopened.connection.execute(
            "SELECT id, chat_id FROM research_runs WHERE id = ?", [run.id]
        ).fetchone()
        assert persisted == (run.id, "chat-1")
    finally:
        reopened.close()


def test_foreign_keys_reject_orphan_ids(store):
    with pytest.raises(Exception, match="foreign key|violates"), store.database.transaction() as connection:
        connection.execute(
            "INSERT INTO research_runs (id, chat_id, pi_session_id, model) "
            "VALUES ('orphan-run', 'missing-chat', 'pi-1', 'test/model')"
        )

    run = store.create_run("chat-1", "pi-1", "test/model")
    with pytest.raises(Exception, match="foreign key|violates"), store.database.transaction() as connection:
        connection.execute(
            "INSERT INTO research_run_steps "
            "(id, run_id, step_name, status, idempotency_key, input_hash) "
            "VALUES ('orphan-step', 'missing-run', 'query', 'running', 'key', 'hash')"
        )
    assert run.id
