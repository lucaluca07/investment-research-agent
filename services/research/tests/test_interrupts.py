import pytest
from duckdb import ConstraintException

import research_service.interrupts as interrupts_module
from research_service.agui_store import AguiStore
from research_service.db import Database
from research_service.interrupts import InterruptConflict, InterruptError, InterruptStore


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


def test_checkpoint_is_durable_and_includes_server_recorded_pi_metadata():
    db, run_id = setup_store(); store = InterruptStore(db)
    checkpoint = store.request_interrupt(
        "t", "i", run_id=run_id, nonce="n", tool_name="save_note", input_value={"title": "x"},
        pi_session_id="pi-session", pi_session_revision=7,
        pi_session_storage_ref="sessions/abc/session",
    )
    loaded = store.get_checkpoint("t", "i")
    assert loaded["checkpoint_id"] == checkpoint["checkpoint_id"]
    assert loaded["run_id"] == run_id
    assert loaded["last_event_seq"] >= 1
    assert loaded["last_event"]["type"]
    assert loaded["tool_name"] == "save_note"
    assert loaded["session"] == {
        "session_id": "pi-session", "revision": 7, "storage_ref": "sessions/abc/session",
    }
    assert loaded["messages"] == []
    assert loaded["evidence"] == []


def test_checkpoint_rejects_client_controlled_or_escaping_storage_refs():
    db, run_id = setup_store(); store = InterruptStore(db)
    with pytest.raises(InterruptError):
        store.request_interrupt("t", "i", run_id=run_id, nonce="n", pi_session_storage_ref="/tmp/session")
    with pytest.raises(InterruptError):
        store.request_interrupt("t", "i", run_id=run_id, nonce="n", pi_session_storage_ref="sessions/../secret")


def test_open_interrupts_are_durable_across_store_instances():
    db, run_id = setup_store()
    InterruptStore(db).request_interrupt("t", "i", run_id=run_id, nonce="n")
    opened = InterruptStore(db).open_interrupts("t")
    assert len(opened) == 1
    assert opened[0]["interrupt_id"] == "i"
    assert opened[0]["run_id"] == run_id
    assert opened[0]["operation_id"]


def test_resolve_set_atomically_resolves_every_open_interrupt_in_creation_order():
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i-1", run_id=run_id, nonce="n-1", tool_name="one")
    store.request_interrupt("t", "i-2", run_id=run_id, nonce="n-2", tool_name="two")

    result = store.resolve_interrupt_set("t", [
        {"interrupt_id": "i-2", "nonce": "n-2", "status": "cancelled", "payload": {"approved": False}},
        {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
    ])

    assert result["thread_id"] == "t"
    assert [item["interrupt_id"] for item in result["receipts"]] == ["i-1", "i-2"]
    assert [item["interrupt_id"] for item in result["checkpoints"]] == ["i-1", "i-2"]
    assert result["replayed"] is False
    assert store.open_interrupts("t") == []


def test_resolve_set_requires_exact_open_set_and_rolls_back_all_decisions():
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i-1", run_id=run_id, nonce="n-1")
    store.request_interrupt("t", "i-2", run_id=run_id, nonce="n-2")

    with pytest.raises(InterruptError, match="exactly every open interrupt"):
        store.resolve_interrupt_set("t", [
            {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
        ])
    assert {item["interrupt_id"] for item in store.open_interrupts("t")} == {"i-1", "i-2"}

    with pytest.raises(InterruptConflict, match="nonce mismatch"):
        store.resolve_interrupt_set("t", [
            {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
            {"interrupt_id": "i-2", "nonce": "wrong", "status": "resolved", "payload": {"approved": True}},
        ])
    assert {item["interrupt_id"] for item in store.open_interrupts("t")} == {"i-1", "i-2"}


def test_resolve_set_exact_replay_returns_original_receipts_without_mutation():
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i-1", run_id=run_id, nonce="n-1")
    store.request_interrupt("t", "i-2", run_id=run_id, nonce="n-2")
    decisions = [
        {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
        {"interrupt_id": "i-2", "nonce": "n-2", "status": "resolved", "payload": {"approved": False}},
    ]
    first = store.resolve_interrupt_set("t", decisions)
    replay = store.resolve_interrupt_set("t", list(reversed(decisions)))

    assert replay["replayed"] is True
    assert [item["receipt_id"] for item in replay["receipts"]] == [item["receipt_id"] for item in first["receipts"]]

    conflicting = [dict(decisions[0]), {**decisions[1], "payload": {"approved": True}}]
    with pytest.raises(InterruptConflict):
        store.resolve_interrupt_set("t", conflicting)


def test_resolve_set_rolls_back_updates_and_receipts_when_second_insert_fails(monkeypatch):
    db, run_id = setup_store(); store = InterruptStore(db)
    store.request_interrupt("t", "i-1", run_id=run_id, nonce="n-1")
    store.request_interrupt("t", "i-2", run_id=run_id, nonce="n-2")
    monkeypatch.setattr(interrupts_module, "uuid4", lambda: "duplicate-receipt-id")

    with pytest.raises(ConstraintException):
        store.resolve_interrupt_set("t", [
            {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
            {"interrupt_id": "i-2", "nonce": "n-2", "status": "resolved", "payload": {"approved": True}},
        ])

    assert {item["interrupt_id"] for item in store.open_interrupts("t")} == {"i-1", "i-2"}
    assert db.connection.execute("SELECT COUNT(*) FROM resume_receipts").fetchone()[0] == 0
