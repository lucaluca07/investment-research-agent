import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from research_service.app import create_app

FIXTURE = Path(__file__).parent / "fixtures/shenghong_snapshot.json"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("IRA_TEST_MODE", raising=False)
    with TestClient(create_app(database_path=":memory:")) as test_client:
        yield test_client


def _run(client):
    chat = client.post("/v1/chats", json={"chat_id": "chat-1"})
    assert chat.status_code == 201
    response = client.post(
        "/v1/research-runs",
        json={"chat_id": "chat-1", "pi_session_id": "pi-1", "model": "test/model"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_company_snapshot_returns_dated_citations(client):
    response = client.post("/v1/tools/query-company-snapshot", json={"ticker": "300476.SZ"})
    assert response.status_code == 200
    assert response.json() == json.loads(FIXTURE.read_text())
    assert response.json()["citations"][0].keys() == {
        "document_id", "title", "published_at", "locator"
    }


def test_unknown_ticker_returns_422(client):
    response = client.post("/v1/tools/query-company-snapshot", json={"ticker": "000001.SZ"})
    assert response.status_code == 422


def test_save_note_replays_original_result(client):
    run_id = _run(client)
    request = {
        "run_id": run_id,
        "idempotency_key": "run-1:save-note:sha256-abc",
        "title": "PCB exposure",
        "body": "Evidence-backed draft",
        "citation_ids": ["fixture:300476:2026-08-14"],
    }
    first = client.post("/v1/tools/save-research-note", json=request)
    second = client.post("/v1/tools/save-research-note", json=request)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()


def test_save_note_input_mismatch_returns_conflict(client):
    run_id = _run(client)
    request = {
        "run_id": run_id,
        "idempotency_key": "stable-key",
        "title": "First",
        "body": "Body",
        "citation_ids": ["fixture:300476:2026-08-14"],
    }
    assert client.post("/v1/tools/save-research-note", json=request).status_code == 200
    request["body"] = "Changed"
    assert client.post("/v1/tools/save-research-note", json=request).status_code == 409


def test_save_note_fault_rolls_back_and_retry_replays_original_result(client, monkeypatch):
    request = {
        "run_id": "placeholder",
        "idempotency_key": "fault-key",
        "title": "Atomic note",
        "body": "Retry me",
        "citation_ids": ["fixture:300476:2026-08-14"],
    }
    monkeypatch.setenv("IRA_TEST_MODE", "1")
    with TestClient(create_app(database_path=":memory:", test_mode=True)) as test_client:
        run_id = _run(test_client)
        failed = test_client.post(
            "/v1/tools/save-research-note",
            json={**request, "run_id": run_id},
            headers={"X-IRA-Test-Fail-After-Note": "1"},
        )
        assert failed.status_code == 500
        assert failed.json()["detail"] == "internal server error"
        retried = test_client.post("/v1/tools/save-research-note", json={**request, "run_id": run_id})
        assert retried.status_code == 200
        counts = test_client.get("/v1/test/counts").json()
    assert counts["research_notes"] == 1
    assert counts["research_run_steps"] == 1
    assert retried.json()["citation_ids"] == request["citation_ids"]


def test_save_note_rejects_invalid_citation(client):
    run_id = _run(client)
    response = client.post(
        "/v1/tools/save-research-note",
        json={
            "run_id": run_id,
            "idempotency_key": "key",
            "title": "Title",
            "body": "Body",
            "citation_ids": ["missing"],
        },
    )
    assert response.status_code == 422


def test_save_note_rejects_unknown_run(client):
    response = client.post(
        "/v1/tools/save-research-note",
        json={
            "run_id": "missing-run",
            "idempotency_key": "key",
            "title": "Title",
            "body": "Body",
            "citation_ids": ["fixture:300476:2026-08-14"],
        },
    )
    assert response.status_code == 404


def test_create_run_rejects_unknown_chat(client):
    response = client.post(
        "/v1/research-runs",
        json={"chat_id": "missing-chat", "pi_session_id": "pi-1", "model": "test/model"},
    )
    assert response.status_code == 404


def test_save_note_rejects_duplicate_citations(client):
    run_id = _run(client)
    response = client.post(
        "/v1/tools/save-research-note",
        json={
            "run_id": run_id,
            "idempotency_key": "key",
            "title": "Title",
            "body": "Body",
            "citation_ids": ["fixture:300476:2026-08-14"] * 2,
        },
    )
    assert response.status_code == 422


def test_application_state_endpoints_do_not_expose_database_path(client):
    created = client.post("/v1/chats", json={"chat_id": "chat-state"})
    assert created.status_code == 201
    assert "database_path" not in created.json()
    updated = client.patch(
        "/v1/chats/chat-state/pi-session", json={"pi_session_id": "pi-state"}
    )
    assert updated.status_code == 200
    assert updated.json()["pi_session_id"] == "pi-state"
    appended = client.post(
        "/v1/chats/chat-state/messages",
        json={"role": "user", "content": "Research PCB exposure"},
    )
    assert appended.status_code == 201
    assert client.get("/v1/chats/chat-state/messages").json() == {
        "messages": [appended.json()]
    }


def test_unknown_pi_session_target_returns_404(client):
    response = client.patch(
        "/v1/chats/missing/pi-session", json={"pi_session_id": "pi-state"}
    )
    assert response.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [{"role": "system", "content": "x"}, {"role": "user", "content": ""}, {"role": "user", "content": "   "}],
)
def test_message_validates_role_and_content(client, payload):
    client.post("/v1/chats", json={"chat_id": "validation-chat"})
    assert client.post("/v1/chats/validation-chat/messages", json=payload).status_code == 422


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("/v1/chats", {"chat_id": "   "}),
        ("/v1/chats/chat-id/pi-session", {"pi_session_id": "   "}),
        ("/v1/research-runs", {"chat_id": "chat-id", "pi_session_id": "pi", "model": "   "}),
        ("/v1/tools/query-company-snapshot", {"ticker": "   "}),
    ],
)
def test_api_rejects_whitespace_identifiers(client, endpoint, payload):
    if endpoint == "/v1/chats/chat-id/pi-session" or endpoint == "/v1/research-runs":
        client.post("/v1/chats", json={"chat_id": "chat-id"})
    method = client.patch if endpoint.endswith("pi-session") else client.post
    assert method(endpoint, json=payload).status_code == 422


def test_production_fault_hook_is_unavailable_even_with_environment(client, monkeypatch):
    monkeypatch.setenv("IRA_TEST_MODE", "1")
    run_id = _run(client)
    response = client.post(
        "/v1/tools/save-research-note",
        json={
            "run_id": run_id,
            "idempotency_key": "production-key",
            "title": "Title",
            "body": "Body",
            "citation_ids": ["fixture:300476:2026-08-14"],
        },
        headers={"X-IRA-Test-Fail-After-Note": "1"},
    )
    assert response.status_code == 200


def test_unknown_chat_messages_returns_404(client):
    assert client.get("/v1/chats/missing/messages").status_code == 404


def test_count_endpoint_requires_test_mode(client, monkeypatch):
    monkeypatch.setenv("IRA_TEST_MODE", "0")
    assert client.get("/v1/test/counts").status_code == 404


def test_count_endpoint_is_available_only_in_test_mode(monkeypatch):
    monkeypatch.setenv("IRA_TEST_MODE", "1")
    with TestClient(create_app(database_path=":memory:", test_mode=True)) as test_client:
        assert test_client.get("/v1/test/counts").status_code == 200
        assert "research_notes" in test_client.get("/v1/test/counts").json()


def test_count_endpoint_is_not_exposed_by_environment_alone(monkeypatch):
    monkeypatch.setenv("IRA_TEST_MODE", "1")
    with TestClient(create_app(database_path=":memory:")) as test_client:
        assert test_client.get("/v1/test/counts").status_code == 404
