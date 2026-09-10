def test_readiness_reports_database_and_agent_state(client):
    response = client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["app_env"] == "development"
    assert body["database"] == "ok"
    assert body["database_dialect"] == "sqlite"
    assert body["production_ready"] is False
    assert "database_must_be_postgresql" in body["production_blockers"]
    assert body["schema_strategy"] == "auto_create"
    assert isinstance(body["agent_configured"], bool)
    assert isinstance(body["proactive_enabled"], bool)
    assert isinstance(body["worker_enabled"], bool)
    assert isinstance(body["worker_running"], bool)
    assert body["worker_last_error"] is None
    assert body["worker_strategy"] == "disabled"
    assert body["http_worker_enabled"] is False
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-request-id"]


def test_request_id_accepts_safe_value_and_replaces_unsafe_value(client):
    safe = client.get("/health", headers={"X-Request-ID": "demo-request_01"})
    assert safe.headers["x-request-id"] == "demo-request_01"

    unsafe = client.get("/health", headers={"X-Request-ID": "bad/request"})
    assert unsafe.headers["x-request-id"] != "bad/request"
