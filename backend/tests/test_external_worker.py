from dataclasses import replace

import app.main as main_module
import pytest
from fastapi.testclient import TestClient


def test_external_worker_endpoint_is_hidden_when_disabled(client):
    response = client.post(
        "/api/internal/worker/run",
        headers={"Authorization": "Bearer anything"},
    )
    assert response.status_code == 404


def test_external_worker_requires_bearer_token(client, monkeypatch):
    configured = replace(
        main_module.settings,
        external_worker_enabled=True,
        http_worker_enabled=True,
        inline_worker_enabled=False,
        worker_token="test-worker-token",
    )
    monkeypatch.setattr(main_module, "settings", configured)

    missing = client.post("/api/internal/worker/run")
    wrong = client.post(
        "/api/internal/worker/run",
        headers={"Authorization": "Bearer wrong"},
    )
    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_external_worker_drains_a_bounded_batch(client, monkeypatch):
    configured = replace(
        main_module.settings,
        external_worker_enabled=True,
        http_worker_enabled=True,
        inline_worker_enabled=False,
        worker_token="test-worker-token",
    )
    monkeypatch.setattr(main_module, "settings", configured)

    response = client.post(
        "/api/internal/worker/run",
        headers={"Authorization": "Bearer test-worker-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["processed"] == 0
    assert body["queue"] == {
        "pending": 0,
        "retry": 0,
        "processing": 0,
        "dead_letter": 0,
    }
    assert body["run_at"]


def test_production_profile_refuses_demo_database(monkeypatch):
    unsafe = replace(main_module.settings, app_env="production")
    monkeypatch.setattr(main_module, "settings", unsafe)

    with pytest.raises(RuntimeError, match="database_must_be_postgresql"):
        with TestClient(main_module.app):
            pass
