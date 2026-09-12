import io
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.agent as agent
from app.main import app


@pytest.fixture(autouse=True)
def close_model_pool():
    agent.close_model_client()
    yield
    agent.close_model_client()


@pytest.fixture
def model_caplog(caplog):
    # The operational logger intentionally does not propagate to root handlers.
    agent.logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(logging.INFO, logger=agent.logger.name):
            yield caplog
    finally:
        agent.logger.removeHandler(caplog.handler)


def response(text="完整回答", status=200):
    return httpx.Response(status, json={
        "choices": [{"finish_reason": "stop", "message": {"content": text}}],
    })


def mock_pool(monkeypatch, handler):
    clients = []

    def create():
        client = httpx.Client(transport=httpx.MockTransport(handler))
        clients.append(client)
        return client

    monkeypatch.setattr(agent, "_create_model_client", create)
    monkeypatch.setattr(agent, "settings", replace(
        agent.settings, llm_api_key="test-key-first", llm_base_url="https://api.deepseek.com",
        llm_model="deepseek-v4-pro", llm_timeout_seconds=12, llm_chat_max_tokens=1024,
    ))
    return clients


def test_requests_reuse_client_without_reusing_credentials_parameters_or_answers(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        return response(json.loads(request.content)["messages"][0]["content"])

    clients = mock_pool(monkeypatch, handler)
    first = agent.call_chat_model([{"role": "user", "content": "第一条独立问题"}])
    monkeypatch.setattr(agent, "settings", replace(
        agent.settings, llm_api_key="test-key-second", llm_timeout_seconds=23,
        llm_model="test-model-second", llm_base_url="https://other.example/v1",
    ))
    second = agent.call_model([{"role": "user", "content": "第二条独立问题"}])
    assert first == "第一条独立问题"
    assert second == "第二条独立问题"
    assert len(clients) == 1
    assert not clients[0].is_closed
    assert [request.headers["authorization"] for request in requests] == [
        "Bearer test-key-first", "Bearer test-key-second",
    ]
    assert [request.extensions["timeout"]["read"] for request in requests] == [12, 23]
    assert [request.url.host for request in requests] == ["api.deepseek.com", "other.example"]
    first_body, second_body = [json.loads(request.content) for request in requests]
    assert first_body["thinking"] == {"type": "disabled"}
    assert first_body["max_tokens"] == 1024
    assert second_body["model"] == "test-model-second"
    assert "thinking" not in second_body and "max_tokens" not in second_body
    assert "authorization" not in clients[0].headers


@pytest.mark.parametrize("failure", ["http", "timeout"])
def test_failed_call_does_not_retry_or_poison_next_call_and_logs_are_redacted(monkeypatch, model_caplog, failure):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            if failure == "timeout":
                raise httpx.ReadTimeout("private-exception-body", request=request)
            return response("private-failed-response", status=503)
        return response("private-successful-answer")

    clients = mock_pool(monkeypatch, handler)
    messages = [{"role": "user", "content": "private-user-prompt"}]
    with pytest.raises(HTTPException) as error:
        agent.call_chat_model(messages)
    assert error.value.status_code == 502
    assert error.value.detail == {"code": "MODEL_PROVIDER_FAILED"}
    assert calls == 1
    assert agent.call_chat_model(messages) == "private-successful-answer"
    assert calls == 2 and len(clients) == 1
    assert not clients[0].is_closed
    logs = [item.getMessage() for item in model_caplog.records if item.name == "app.agent"]
    assert len(logs) == 2
    entries = [json.loads(item.removeprefix("model_call ")) for item in logs]
    assert all(set(entry) == {"model", "status", "elapsed_ms"} for entry in entries)
    assert entries[0]["status"] == ("HTTP_503" if failure == "http" else "MODEL_PROVIDER_FAILED")
    assert entries[1]["status"] == "succeeded"
    assert all(entry["elapsed_ms"] >= 0 for entry in entries)
    for private_value in ("test-key-first", "private-user-prompt", "private-failed-response",
                          "private-successful-answer", "private-exception-body"):
        assert private_value not in " ".join(logs)


def test_metrics_are_visible_once_with_default_root_level_without_global_logging_changes(monkeypatch, model_caplog):
    root = logging.getLogger()
    root_output = io.StringIO()
    root_handler = logging.StreamHandler(root_output)
    root.addHandler(root_handler)
    monkeypatch.setattr(root, "level", logging.WARNING)
    metrics_output = io.StringIO()
    handler = next(item for item in agent.logger.handlers if item.get_name() == "poopsense_model_metrics")
    monkeypatch.setattr(handler, "stream", metrics_output)
    handlers_before = list(agent.logger.handlers)
    root_handlers_before = list(root.handlers)
    try:
        assert agent._configure_model_logging() is agent.logger
        assert agent._configure_model_logging() is agent.logger
        assert agent.logger.handlers == handlers_before
        assert root.handlers == root_handlers_before
        assert root.level == logging.WARNING
        mock_pool(monkeypatch, lambda request: response("private-reply"))
        assert agent.call_chat_model([{"role": "user", "content": "private-prompt"}]) == "private-reply"
        monkeypatch.setattr(agent, "settings", replace(agent.settings, llm_api_key=""))
        with pytest.raises(HTTPException) as error:
            agent.call_chat_model([{"role": "user", "content": "private-prompt"}])
        assert error.value.detail == {"code": "MODEL_NOT_CONFIGURED"}
        lines = metrics_output.getvalue().splitlines()
        assert len(lines) == 2
        entries = [json.loads(line.removeprefix("model_call ")) for line in lines]
        assert [entry["status"] for entry in entries] == ["succeeded", "MODEL_NOT_CONFIGURED"]
        assert all(set(entry) == {"model", "status", "elapsed_ms"} for entry in entries)
        assert all(entry["elapsed_ms"] >= 0 for entry in entries)
        assert len([record for record in model_caplog.records if record.name == "app.agent"]) == 2
        assert root_output.getvalue() == ""
        assert root.level == logging.WARNING and root.handlers == root_handlers_before
        for private_value in ("private-reply", "private-prompt", "test-key-first"):
            assert private_value not in metrics_output.getvalue()
    finally:
        root.removeHandler(root_handler)
        root_handler.close()


def test_parallel_calls_share_one_pool_without_serializing_requests(monkeypatch):
    concurrent = threading.Barrier(2, timeout=5)

    def handler(request):
        concurrent.wait()
        return response(json.loads(request.content)["messages"][0]["content"])

    clients = mock_pool(monkeypatch, handler)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(agent.call_chat_model, [{"role": "user", "content": text}])
                   for text in ("并行问题一", "并行问题二")]
        assert [future.result(timeout=10) for future in futures] == ["并行问题一", "并行问题二"]
    assert len(clients) == 1


def test_close_retires_inflight_client_and_rebuilds_without_interrupting_it(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def handler(request):
        text = json.loads(request.content)["messages"][0]["content"]
        if text == "等待中的请求":
            started.set()
            assert release.wait(timeout=5)
        return response(text)

    clients = mock_pool(monkeypatch, handler)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(agent.call_chat_model, [{"role": "user", "content": "等待中的请求"}])
        try:
            assert started.wait(timeout=5)
            agent.close_model_client()
            assert not clients[0].is_closed
            assert agent.call_chat_model([{"role": "user", "content": "新请求"}]) == "新请求"
            assert len(clients) == 2
        finally:
            release.set()
        assert pending.result(timeout=10) == "等待中的请求"
    assert clients[0].is_closed
    assert not clients[1].is_closed
    agent.close_model_client()
    assert clients[1].is_closed
    agent.close_model_client()


def test_application_lifespan_closes_pool_and_next_start_rebuilds_it(monkeypatch):
    clients = mock_pool(monkeypatch, lambda request: response())
    for index in range(2):
        with TestClient(app):
            assert agent.call_chat_model([{"role": "user", "content": "隔离生命周期检查"}]) == "完整回答"
            assert len(clients) == index + 1
            assert not clients[index].is_closed
        assert clients[index].is_closed
