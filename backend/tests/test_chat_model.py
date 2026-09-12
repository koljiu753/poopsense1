from dataclasses import replace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

import app.agent as agent
from app.database import SessionLocal
from app.models import AgentAction, AgentMessage, AgentRun


OWNER = {"X-Household-Key": "household-secret"}
MESSAGES = [{"role": "user", "content": "请简短介绍你能做什么"}]


def mock_provider(monkeypatch, *, content="可以帮你理解记录。", finish_reason="stop",
                  base_url="https://api.deepseek.com", max_tokens=1024):
    requests = []
    monkeypatch.setattr(agent, "settings", replace(
        agent.settings, llm_api_key="test-provider-key", llm_base_url=base_url,
        llm_chat_max_tokens=max_tokens,
    ))

    def post(url, **kwargs):
        requests.append(kwargs)
        return httpx.Response(200, request=httpx.Request("POST", url), json={
            "choices": [{"finish_reason": finish_reason, "message": {
                "content": content, "reasoning_content": "内部推理不得作为回答返回",
            }}],
        })

    monkeypatch.setattr(agent.httpx, "post", post)
    return requests


def test_interactive_deepseek_request_is_bounded_and_non_thinking(monkeypatch):
    requests = mock_provider(monkeypatch, max_tokens=1536)
    assert agent.call_chat_model(MESSAGES) == "可以帮你理解记录。"
    assert len(requests) == 1
    payload = requests[0]["json"]
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["max_tokens"] == 1536
    assert not payload.get("stream", False)
    assert requests[0]["timeout"] == agent.settings.llm_timeout_seconds


def test_custom_provider_does_not_receive_deepseek_extension(monkeypatch):
    requests = mock_provider(monkeypatch, base_url="https://provider.example/v1")
    agent.call_chat_model(MESSAGES)
    assert "thinking" not in requests[0]["json"]
    assert requests[0]["json"]["max_tokens"] == 1024


def test_background_json_caller_keeps_its_existing_generation_parameters(monkeypatch):
    reply = '{"action":"no_action","reason":"无需行动","message":""}'
    requests = mock_provider(monkeypatch, content=reply)
    assert agent.call_model(MESSAGES) == reply
    assert "max_tokens" not in requests[0]["json"]
    assert "thinking" not in requests[0]["json"]


@pytest.mark.parametrize("finish_reason", ["length", "content_filter", "tool_calls", None])
def test_incomplete_interactive_reply_is_not_exposed(monkeypatch, finish_reason):
    requests = mock_provider(monkeypatch, content="如出现出血，请", finish_reason=finish_reason)
    with pytest.raises(HTTPException) as error:
        agent.call_chat_model(MESSAGES)
    assert error.value.status_code == 502
    assert error.value.detail == {"code": "MODEL_RESPONSE_INCOMPLETE"}
    assert len(requests) == 1


@pytest.mark.parametrize("content", ["", " \n ", None])
def test_empty_interactive_reply_is_not_successful(monkeypatch, content):
    mock_provider(monkeypatch, content=content)
    with pytest.raises(HTTPException) as error:
        agent.call_chat_model(MESSAGES)
    assert error.value.detail == {"code": "MODEL_EMPTY_RESPONSE"}


def test_plain_question_uses_one_fast_call_and_preserves_audit(client, monkeypatch):
    requests = mock_provider(monkeypatch)
    response = client.post("/api/v1/households/hh_001/agent/chat", headers=OWNER,
                           json={"member_id": "m_001", "message": MESSAGES[0]["content"]})
    assert response.status_code == 200
    body = response.json()
    assert body["report"] is None
    assert body["model_version"] == agent.settings.llm_model
    assert body["authorization_basis"] == "household_owner"
    assert len(requests) == 1
    assert requests[0]["json"]["thinking"] == {"type": "disabled"}
    prompt = requests[0]["json"]["messages"][0]["content"]
    assert "手机阅读格式" in prompt
    assert "不得诊断、改写风险等级" in prompt
    assert "安全提醒和不确定性说明必须完整" in prompt
    with SessionLocal() as db:
        assert db.get(AgentRun, body["run_id"]).status == "completed"
        audit = db.scalar(select(AgentAction).where(AgentAction.action_type == "agent_chat_response"))
        assert audit.status == "succeeded"
        assert audit.model_version == agent.settings.llm_model


def test_truncated_chat_fails_audit_without_saving_partial_assistant(client, monkeypatch):
    requests = mock_provider(monkeypatch, content="如出现出血，请", finish_reason="length")
    response = client.post("/api/v1/households/hh_001/agent/chat", headers=OWNER,
                           json={"member_id": "m_001", "message": "出现血便怎么办"})
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "MODEL_RESPONSE_INCOMPLETE"
    assert len(requests) == 1
    with SessionLocal() as db:
        audit = db.scalar(select(AgentAction).where(AgentAction.action_type == "agent_chat_response"))
        assert audit.status == "failed"
        assert audit.input_summary["decision"] == "urgent_care"
        assert audit.input_summary["allowed_actions"] == ["explain_safety_limit", "recommend_urgent_care"]
        assert db.scalar(select(AgentMessage).where(AgentMessage.role == "assistant")) is None


def test_report_truncation_uses_labelled_safe_report_fallback(client, monkeypatch, normal_payload):
    payload = {**normal_payload, "session_id": "budget_report"}
    payload["observations"]["odor"]["confidence"] = 0.2
    uploaded = client.post("/api/v1/device-sessions", json=payload,
                           headers={"X-Device-Key": "dev-secret"})
    assert uploaded.status_code == 202
    from app.worker import run_until_empty
    with SessionLocal() as db:
        run_until_empty(db)
    claimed = client.post("/api/v1/households/hh_001/sessions/budget_report/claim",
                          json={"member_id": "m_001"}, headers=OWNER)
    assert claimed.status_code == 200
    requests = mock_provider(monkeypatch, content="不完整建议", finish_reason="length")
    response = client.post("/api/v1/households/hh_001/agent/session-analysis", headers=OWNER,
                           json={"member_id": "m_001", "session_id": "budget_report"})
    assert response.status_code == 200
    body = response.json()
    assert len(requests) == 1
    assert body["model_version"] == "policy-engine"
    assert body["report"]["status"] == "insufficient"
    assert "无法可靠判断" in body["message"]["content"]
    assert "不完整建议" not in body["message"]["content"]
