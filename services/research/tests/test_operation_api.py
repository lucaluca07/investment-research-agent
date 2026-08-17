from fastapi.testclient import TestClient

from research_service.app import create_app


def test_operation_routes_validate_payload_and_return_conflicts_not_500():
    with TestClient(create_app(database_path=":memory:")) as client:
        assert client.post("/v1/internal/operations/status", json={"thread_id": "t"}).status_code == 422
        assert client.post("/v1/internal/operations/status", json={"thread_id": "t", "operation_id": "missing"}).status_code == 404
        response = client.post("/v1/internal/operations/begin", json={"thread_id": "t", "operation_id": "missing"})
        assert response.status_code == 404
        response = client.post("/v1/internal/operations/complete", json={"thread_id": "t", "operation_id": "missing", "result": {}})
        assert response.status_code == 404
