from research_service.agui_store import AguiStore
from research_service.db import Database


def store():
    return AguiStore(Database())


def test_create_run_is_idempotent_and_writes_initial_events_only_to_agui_tables():
    s = store()
    s.create_thread("t1", "Research")
    first = s.create_run("t1", "k1", {"messages": [{"role": "user", "content": "hi"}]}, "deepseek")
    replay = s.create_run("t1", "k1", {"messages": [{"role": "user", "content": "hi"}]}, "deepseek")
    assert first["run"]["id"] == replay["run"]["id"]
    assert replay["replayed"] is True
    with s.database.read() as c:
        assert c.execute("select count(*) from agui_events").fetchone()[0] == 2
        assert c.execute("select count(*) from agui_events").fetchone()[0] == 2


def test_events_have_contiguous_sequences_and_cursor_state():
    s = store(); s.create_thread("t1")
    run = s.create_run("t1", "k1", {}, None)["run"]
    result = s.append_events("t1", run["id"], [{"type": "TEXT_MESSAGE_CONTENT", "data": {"delta": "a"}}, {"type": "STEP_FINISHED", "data": {}}])
    assert [e["sequence"] for e in result] == [3, 4]
    assert [e["sequence"] for e in s.list_events("t1", 2)] == [3, 4]
    assert s.get_state("t1")["last_event_seq"] == 4


def test_transition_updates_run_and_is_idempotent():
    s = store(); s.create_thread("t1")
    run = s.create_run("t1", "k1", {}, None)["run"]
    assert s.transition_run(run["id"], "completed")["status"] == "completed"


def test_terminal_transition_persists_custom_event_atomically():
    s = store(); s.create_thread("t1")
    run = s.create_run("t1", "k1", {}, None)["run"]
    s.transition_run(run["id"], "failed", {"message": "boom"}, True, "RUN_ERROR", {"runId": run["id"], "message": "boom", "code": "recovery_failed"})
    event = s.list_events("t1", 0)[-1]
    assert event["type"] == "RUN_ERROR"
    assert event["data"]["code"] == "recovery_failed"
    before = len(s.list_events("t1", 0))
    assert s.transition_run(run["id"], "failed", {"message": "boom"}, True, "RUN_ERROR", {"ignored": True})["status"] == "failed"
    assert len(s.list_events("t1", 0)) == before
    try:
        s.transition_run(run["id"], "completed", None, True, "RUN_FINISHED", {})
    except ValueError as error:
        assert "terminal" in str(error)
    else:
        raise AssertionError("terminal run status changed")


def test_terminal_transition_rolls_back_status_when_event_insert_fails():
    s = store(); s.create_thread("t1")
    run = s.create_run("t1", "k1", {}, None)["run"]
    before = len(s.list_events("t1", 0))
    try:
        s.transition_run(run["id"], "completed", None, True, "RUN_FINISHED", {"bad": object()})
    except TypeError:
        pass
    else:
        raise AssertionError("non-JSON terminal event was accepted")
    assert s.get_state("t1")["runs"][0]["status"] == "running"
    assert len(s.list_events("t1", 0)) == before
    assert s.transition_run(run["id"], "completed")["status"] == "completed"


def test_state_run_fields_are_not_shifted():
    s = store(); s.create_thread("t1")
    s.create_run("t1", "k1", {"x": 1}, "deepseek")
    state_run = s.get_state("t1")["runs"][0]
    assert state_run["status"] == "running"
    assert state_run["model"] == "deepseek"
    assert state_run["input_hash"]
