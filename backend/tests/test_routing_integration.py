from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import threading

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

import app.agent as agent
import app.weekly_reports as weekly
from app.database import SessionLocal
from app.model_routing import resolve_model
from app.models import AgentAction, AgentMessage, SessionRecord, WeeklyHealthReport


OWNER = {"X-Household-Key": "household-secret"}
VIEWER = {"X-Household-Key": "viewer-secret"}
DEVICE = {"X-Device-Key": "dev-secret"}
CHAT = "/api/v1/households/hh_001/agent/chat"
ENVIRONMENT = {"DEEPSEEK_API_KEY": "test-routing-deepseek-key", "BAICHUAN_API_KEY": "test-routing-baichuan-key"}
VERSIONS = {"api.deepseek.com": "deepseek-v4-pro-test-snapshot", "api.baichuan-ai.com": "Baichuan-M3-Plus-test-snapshot"}


@pytest.fixture(autouse=True)
def isolated_routing(monkeypatch):
    agent.close_model_client()
    config = replace(agent.settings, llm_routing_enabled=True, llm_profiles_json="{}", llm_routes_json="{}",
                     llm_api_key="", llm_base_url="https://api.baichuan-ai.com/v1", llm_model="Baichuan-M3-Plus")
    monkeypatch.setattr(agent, "settings", config)
    monkeypatch.setattr(weekly, "settings", config)
    for name, value in ENVIRONMENT.items():
        monkeypatch.setenv(name, value)

    def no_real_network(*args, **kwargs):
        pytest.fail("Routing integration tests must not use real network")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_real_network)
    yield config
    agent.close_model_client()


def fake_providers(monkeypatch, *, barrier=None):
    calls = []
    clients = []
    lock = threading.Lock()

    def handler(request):
        with lock:
            calls.append(request)
        if barrier is not None:
            barrier.wait(timeout=5)
        model = VERSIONS[request.url.host]
        return httpx.Response(200, json={
            "model": model,
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "可以继续查看已有记录，并保持原有日常节奏。",
            }}],
        })

    def create():
        client = httpx.Client(transport=httpx.MockTransport(handler))
        clients.append(client)
        return client

    monkeypatch.setattr(agent, "_create_model_client", create)
    return calls, clients


def upload_and_claim(client, normal_payload, name, *, hours_ago=1):
    payload = deepcopy(normal_payload)
    payload["session_id"] = name
    payload["correlation_id"] = "cor_" + name
    when = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    payload["timestamp"] = when.isoformat()
    payload["end_timestamp"] = (when + timedelta(seconds=93)).isoformat()
    assert client.post("/api/v1/device-sessions", json=payload, headers=DEVICE).status_code == 202
    assert client.post(f"/api/v1/households/hh_001/sessions/{name}/claim", headers=OWNER,
                       json={"member_id": "m_001"}).status_code == 200
    with SessionLocal() as db:
        return db.scalar(select(SessionRecord).where(SessionRecord.external_session_id == name)).id


def test_parallel_routed_calls_keep_credentials_parameters_and_model_audits_separate(monkeypatch, isolated_routing):
    config = replace(isolated_routing, llm_profiles_json=json.dumps({
        "deepseek": {"timeout_seconds": 11, "max_tokens": 768},
        "baichuan": {"timeout_seconds": 22, "max_tokens": 1536},
    }))
    general = resolve_model("general_chat", config, environ=ENVIRONMENT)
    medical = resolve_model("health_knowledge", config, environ=ENVIRONMENT)
    calls, clients = fake_providers(monkeypatch, barrier=threading.Barrier(2))
    messages = [{"role": "system", "content": "保留软件约束"}, {"role": "user", "content": "虚构测试问题"}]
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(agent.call_chat_model, messages, task="general_chat", model_spec=general)
        second = executor.submit(agent.call_chat_model, messages, task="health_knowledge", model_spec=medical)
        results = [first.result(timeout=10), second.result(timeout=10)]
    assert len(clients) == 1 and len(calls) == 2
    requests = {request.url.host: request for request in calls}
    deepseek = requests["api.deepseek.com"]
    baichuan = requests["api.baichuan-ai.com"]
    assert deepseek.headers["authorization"] == "Bearer test-routing-deepseek-key"
    assert baichuan.headers["authorization"] == "Bearer test-routing-baichuan-key"
    assert deepseek.extensions["timeout"]["read"] == 11 and baichuan.extensions["timeout"]["read"] == 22
    general_payload, medical_payload = json.loads(deepseek.content), json.loads(baichuan.content)
    assert general_payload["model"] == "deepseek-v4-pro" and medical_payload["model"] == "Baichuan-M3-Plus"
    assert general_payload["max_tokens"] == 768 and medical_payload["max_tokens"] == 1536
    assert general_payload["thinking"] == {"type": "disabled"}
    assert "thinking" not in medical_payload and medical_payload["metadata"]["output_style"] == "patient"
    assert medical_payload["messages"][0]["role"] == "user" and general_payload["messages"][0]["role"] == "system"
    assert results[0].route["task"] == "general_chat" and results[1].route["task"] == "health_knowledge"
    assert results[0].route["model"] == VERSIONS["api.deepseek.com"]
    assert results[1].route["model"] == VERSIONS["api.baichuan-ai.com"]
    assert "authorization" not in clients[0].headers


def test_missing_selected_key_fails_without_requesting_other_configured_provider(monkeypatch):
    calls, _ = fake_providers(monkeypatch)
    monkeypatch.delenv("BAICHUAN_API_KEY", raising=False)
    with pytest.raises(HTTPException) as exc:
        agent.call_chat_model([{"role": "user", "content": "虚构知识问题"}], task="health_knowledge")
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] in {"MODEL_NOT_CONFIGURED", "MODEL_ROUTE_NOT_CONFIGURED"}
    assert calls == []


def test_repeated_failed_followups_preserve_original_route_and_resume_same_provider(client, monkeypatch):
    calls, _ = fake_providers(monkeypatch)
    first = client.post(CHAT, headers=OWNER, json={"member_id": "m_001", "message": "便秘有哪些常见原因"})
    assert first.status_code == 200
    conversation = first.json()["conversation_id"]
    original_route = first.json()["message"]["metadata"]["model_route"]
    assert original_route["task"] == "health_knowledge"
    monkeypatch.delenv("BAICHUAN_API_KEY", raising=False)
    for _ in range(3):
        response = client.post(CHAT, headers=OWNER, json={
            "member_id": "m_001", "message": "继续说", "conversation_id": conversation,
        })
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "MODEL_NOT_CONFIGURED"
    assert [request.url.host for request in calls] == ["api.baichuan-ai.com"]
    monkeypatch.setenv("BAICHUAN_API_KEY", ENVIRONMENT["BAICHUAN_API_KEY"])
    recovered = client.post(CHAT, headers=OWNER, json={
        "member_id": "m_001", "message": "继续说", "conversation_id": conversation,
    })
    assert recovered.status_code == 200
    route = recovered.json()["message"]["metadata"]["model_route"]
    assert route["task"] == "health_knowledge" and route["provider"] == "baichuan"
    assert [request.url.host for request in calls] == ["api.baichuan-ai.com", "api.baichuan-ai.com"]
    history = client.get(f"/api/v1/households/hh_001/agent/conversations/{conversation}", headers=OWNER)
    saved = next(item for item in history.json()["messages"] if item["message_id"] == first.json()["message"]["message_id"])
    assert saved["metadata"]["model_route"] == original_route


def test_same_conversation_routes_new_intents_and_preserves_short_followup_and_history(client, monkeypatch):
    calls, _ = fake_providers(monkeypatch)
    first = client.post(CHAT, headers=OWNER, json={"member_id": "m_001", "message": "怎么打开记录页面"})
    assert first.status_code == 200
    product = first.json()
    conversation = product["conversation_id"]
    second = client.post(CHAT, headers=OWNER, json={
        "member_id": "m_001", "message": "便秘有哪些常见原因", "conversation_id": conversation,
    })
    assert second.status_code == 200
    medical = second.json()
    third = client.post(CHAT, headers=OWNER, json={
        "member_id": "m_001", "message": "继续说", "conversation_id": conversation,
    })
    assert third.status_code == 200
    followup = third.json()
    assert [request.url.host for request in calls] == ["api.deepseek.com", "api.baichuan-ai.com", "api.baichuan-ai.com"]
    for body, task, host in [(product, "product_help", "api.deepseek.com"),
                             (medical, "health_knowledge", "api.baichuan-ai.com"),
                             (followup, "health_knowledge", "api.baichuan-ai.com")]:
        route = body["message"]["metadata"]["model_route"]
        assert route["task"] == task and route["source"] == "model" and route["model"] == VERSIONS[host]
        assert body["model_version"] == VERSIONS[host]
        with SessionLocal() as db:
            saved = db.get(AgentMessage, body["message"]["message_id"])
            assert saved.model_version == VERSIONS[host]
            actions = db.scalars(select(AgentAction).where(AgentAction.idempotency_key.like(
                f"agent-chat:{conversation}:%"))).all()
            action = next(item for item in actions if item.result.get("assistant_message_id") == saved.id)
            assert action.model_version == VERSIONS[host]
            assert action.result["model_route"] == route
    history = client.get(f"/api/v1/households/hh_001/agent/conversations/{conversation}", headers=OWNER)
    assert history.status_code == 200
    saved_routes = {item["message_id"]: item["metadata"].get("model_route") for item in history.json()["messages"]}
    assert saved_routes[product["message"]["message_id"]] == product["message"]["metadata"]["model_route"]
    assert saved_routes[medical["message"]["message_id"]] == medical["message"]["metadata"]["model_route"]


def test_unauthorized_member_is_rejected_before_model_selection_or_network(client, monkeypatch, isolated_routing):
    calls, _ = fake_providers(monkeypatch)
    monkeypatch.setattr(agent, "settings", replace(isolated_routing, llm_profiles_json="invalid private configuration"))
    result = client.post(CHAT, headers=VIEWER, json={"member_id": "m_001", "message": "便秘有什么常见原因"})
    assert result.status_code == 403
    assert calls == []


def test_automatic_session_report_and_background_action_use_rules_without_model_requests(client, normal_payload, monkeypatch):
    calls, _ = fake_providers(monkeypatch)
    record_id = upload_and_claim(client, normal_payload, "routing_rule_report")
    response = client.post("/api/v1/households/hh_001/agent/session-analysis", headers=OWNER,
                           json={"member_id": "m_001", "session_id": "routing_rule_report"})
    assert response.status_code == 200
    body = response.json()
    assert body["report"]["reliable"] is True and body["model_version"] == "policy-engine"
    assert body["message"]["metadata"]["model_route"]["source"] == "policy"
    assert body["message"]["metadata"]["model_route"]["task"] == "session_report"
    with SessionLocal() as db:
        action = agent.orchestrate_session(db, record_id)
        assert action.model_version == "policy-engine" and action.input_summary["decision_source"] == "policy"
    assert calls == []


def test_legacy_action_preserves_returned_model_alias_and_structured_action_route(
    client, normal_payload, monkeypatch, isolated_routing,
):
    config = replace(isolated_routing, llm_routing_enabled=False, llm_base_url="https://api.deepseek.com",
                     llm_model="deepseek-v4-pro", llm_api_key="test-legacy-action-key")
    monkeypatch.setattr(agent, "settings", config)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={
            "model": VERSIONS["api.deepseek.com"],
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant",
                "content": json.dumps({"action": "no_action", "reason": "no_followup_needed", "message": ""}),
            }}],
        })

    monkeypatch.setattr(agent, "_create_model_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    record_id = upload_and_claim(client, normal_payload, "routing_legacy_action_alias")
    with SessionLocal() as db:
        action = agent.orchestrate_session(db, record_id)
        assert action.action_type == "llm_no_action" and action.status == "succeeded"
        assert action.model_version == VERSIONS["api.deepseek.com"]
        assert action.input_summary["decision_source"] == "model"
        route = action.result["model_route"]
        assert route["model"] == action.model_version and route["provider"] == "deepseek"
        assert route["task"] == "structured_action" and route["source"] == "model" and route["mode"] == "single"
    assert len(calls) == 1 and calls[0].url.host == "api.deepseek.com"
    assert calls[0].headers["authorization"] == "Bearer test-legacy-action-key"
    assert json.loads(calls[0].content)["model"] == "deepseek-v4-pro"


def test_weekly_summary_uses_its_own_route_and_actual_model_version(client, normal_payload, monkeypatch, isolated_routing):
    config = replace(isolated_routing, llm_routes_json='{"weekly_summary":"baichuan"}')
    monkeypatch.setattr(agent, "settings", config)
    monkeypatch.setattr(weekly, "settings", config)
    calls, _ = fake_providers(monkeypatch)
    for index in range(3):
        upload_and_claim(client, normal_payload, f"routing_weekly_{index}", hours_ago=index + 1)
    response = client.post("/api/v1/households/hh_001/members/m_001/weekly-reports", headers=OWNER)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert len(calls) == 1 and calls[0].url.host == "api.baichuan-ai.com"
    assert body["model_version"] == VERSIONS["api.baichuan-ai.com"]
    with SessionLocal() as db:
        report = db.get(WeeklyHealthReport, body["report_id"])
        action = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_ready"))
        assert report.model_version == VERSIONS["api.baichuan-ai.com"]
        assert action.model_version == VERSIONS["api.baichuan-ai.com"]
