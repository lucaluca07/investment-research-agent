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


def test_rejection_cancels_waiting_approval(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    step = store.start_step(run.id, "save_note", "key-1", "sha256:abc")
    store.request_approval(step.id, {"note": "draft"})
    store.reject(step.id, actor="local-user", reason="not ready")
    assert store.get_step(step.id).status == "cancelled"


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
