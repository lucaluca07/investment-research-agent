import pytest

from research_service.agui_store import AguiStore
from research_service.db import Database
from research_service.interrupts import InterruptConflict, InterruptStore, InterruptError


def setup_store():
    db = Database(":memory:")
    agui = AguiStore(db)
    agui.create_thread("t")
    run = agui.create_run("t", "k", {"messages": []})["run"]
    return db, run["id"]


def test_request_and_resolve_is_idempotent():
    db, run_id = setup_store(); store = InterruptStore(db)
    first = store.request_interrupt("t", "i", run_id=run_id, nonce="n", tool_name="note", input_value={"x": 1})
    assert first["status"] == "waiting_approval"
    result = store.resolve_interrupt("t", "i", "n", "resolved", {"approved": True})
    replay = store.resolve_interrupt("t", "i", "n", "resolved", {"approved": True})
    assert result["receipt_id"] == replay["receipt_id"]


def test_conflicting_decision_is_409():
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i", run_id=run_id, nonce="n")
    store.resolve_interrupt("t", "i", "n", "resolved", {"approved": True})
    with pytest.raises(InterruptConflict):
        store.resolve_interrupt("t", "i", "n", "resolved", {"approved": False})


def test_bad_nonce_and_payload_are_422():
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i", run_id=run_id, nonce="n")
    with pytest.raises(InterruptError): store.resolve_interrupt("t", "i", "bad", "resolved", {"approved": True})
    with pytest.raises(InterruptError): store.resolve_interrupt("t", "i", "n", "resolved", {"approved": "yes"})


def test_future_checkpoint_sequence_is_rejected():
    db, run_id = setup_store(); store = InterruptStore(db)
    with pytest.raises(InterruptError):
        store.request_interrupt("t", "i", run_id=run_id, nonce="n", last_event_seq=999)
