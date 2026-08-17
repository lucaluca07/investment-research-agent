from fastapi.testclient import TestClient

from research_service.app import create_app


def create_open_interrupts(client: TestClient) -> None:
    client.post("/v1/threads", json={"id": "t"}).raise_for_status()
    run = client.post("/v1/threads/t/runs", json={"idempotency_key": "run", "input": {"messages": []}}).json()["run"]
    for suffix in ("1", "2"):
        response = client.post("/v1/internal/interrupts", json={
            "thread_id": "t", "interrupt_id": f"i-{suffix}", "run_id": run["id"],
            "nonce": f"n-{suffix}", "tool_name": "note", "input": {"suffix": suffix},
        })
        response.raise_for_status()


def test_resolve_set_route_is_typed_and_replays_exact_request(tmp_path):
    with TestClient(create_app(str(tmp_path / "db.duckdb"), test_mode=True)) as client:
        create_open_interrupts(client)
        body = {"decisions": [
            {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}},
            {"interrupt_id": "i-2", "nonce": "n-2", "status": "cancelled", "payload": {"approved": False}},
        ]}
        first = client.post("/v1/internal/interrupts/t/resolve-set", json=body)
        assert first.status_code == 200
        assert first.json()["replayed"] is False
        replay = client.post("/v1/internal/interrupts/t/resolve-set", json=body)
        assert replay.status_code == 200
        assert replay.json()["replayed"] is True
        assert replay.json()["receipts"] == first.json()["receipts"]
        subset = client.post("/v1/internal/interrupts/t/resolve-set", json={"decisions": [body["decisions"][0]]})
        assert subset.status_code == 409


def test_resolve_set_route_rejects_schema_duplicates_and_set_mismatch(tmp_path):
    with TestClient(create_app(str(tmp_path / "db.duckdb"), test_mode=True)) as client:
        create_open_interrupts(client)
        valid = {"interrupt_id": "i-1", "nonce": "n-1", "status": "resolved", "payload": {"approved": True}}
        cases = [
            {},
            {"decisions": []},
            {"decisions": [valid, valid]},
            {"decisions": [{**valid, "payload": {"approved": "yes"}}]},
            {"decisions": [{**valid, "unexpected": True}]},
            {"decisions": [valid]},
        ]
        for body in cases:
            assert client.post("/v1/internal/interrupts/t/resolve-set", json=body).status_code == 422


def test_resolve_set_route_reports_identity_and_replay_conflicts_as_409(tmp_path):
    with TestClient(create_app(str(tmp_path / "db.duckdb"), test_mode=True)) as client:
        create_open_interrupts(client)
        bad_nonce = {"decisions": [
            {"interrupt_id": "i-1", "nonce": "wrong", "status": "resolved", "payload": {"approved": True}},
            {"interrupt_id": "i-2", "nonce": "n-2", "status": "resolved", "payload": {"approved": True}},
        ]}
        assert client.post("/v1/internal/interrupts/t/resolve-set", json=bad_nonce).status_code == 409
        assert len(client.get("/v1/internal/interrupts/t").json()) == 2
