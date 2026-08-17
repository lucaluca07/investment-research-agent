from fastapi.testclient import TestClient

from research_service.app import create_app


def test_operation_routes_validate_payload_and_return_conflicts_not_500():
    with TestClient(create_app(database_path=":memory:")) as client:
        assert client.post("/v1/internal/operations/status", json={"thread_id": "t"}).status_code == 422
        assert client.post("/v1/internal/operations/status", json={"thread_id": "t", "operation_id": "missing"}).status_code == 404
        response = client.post("/v1/internal/operations/begin", json={"thread_id": "t", "operation_id": "missing"})
        assert response.status_code == 404


def test_checkpoint_route_returns_only_service_recorded_resume_context():
    with TestClient(create_app(database_path=":memory:")) as client:
        assert client.post("/v1/threads", json={"id": "t"}).status_code == 201
        run = client.post("/v1/threads/t/runs", json={"idempotency_key": "k", "input": {}}).json()["run"]
        events = client.post("/v1/threads/t/events:batch", json={"run_id": run["id"], "events": [{"type": "TOOL_CALL_END", "data": {}}]}).json()
        created = client.post("/v1/internal/interrupts", json={
            "thread_id": "t", "interrupt_id": "i", "run_id": run["id"], "nonce": "n",
            "tool_name": "save", "input": {"x": 1}, "last_event_seq": events["events"][0]["sequence"],
            "pi_session_id": "session", "pi_session_revision": 3, "pi_session_storage_ref": "sessions/key/session",
        })
        assert created.status_code == 200
        checkpoint = client.get("/v1/internal/interrupts/t/i/checkpoint")
        assert checkpoint.status_code == 200
        assert checkpoint.json()["session"] == {"session_id": "session", "revision": 3, "storage_ref": "sessions/key/session"}
        assert checkpoint.json()["input"] == {"x": 1}
        response = client.post("/v1/internal/operations/complete", json={"thread_id": "t", "operation_id": "missing", "result": {}})
        assert response.status_code == 404
