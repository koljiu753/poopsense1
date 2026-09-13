from dataclasses import replace
import json

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

import app.agent as agent
from app.database import SessionLocal
from app.models import AgentAction, AgentMessage, AgentRun


OWNER = {"X-Household-Key": "household-secret"}
MESSAGES = [{"role": "user", "content": "请简短介绍你能做什么"}]


@pytest.fixture(autouse=True)
def close_model_pool():
    agent.close_model_client()
    yield
    agent.close_model_client()


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

    class FakeClient:
        is_closed = False

        def post(self, url, **kwargs):
            return post(url, **kwargs)

        def close(self):
            self.is_closed = True

    monkeypatch.setattr(agent, "_create_model_client", FakeClient)
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


def mock_medical_provider(monkeypatch, *, content="先观察记录。 ^[2]^", finish_reason="stop"):
    requests = []
    monkeypatch.setattr(agent, "settings", replace(
        agent.settings, llm_api_key="test-baichuan-key", llm_model="Baichuan-M3-Plus",
        llm_base_url="https://api.baichuan-ai.com/v1", llm_chat_max_tokens=1024,
    ))
    def provider(request):
        requests.append(request)
        return httpx.Response(200, json={"choices": [{
            "finish_reason": finish_reason, "message": {"content": content},
            "grounding": {"evidence": [{"ref_num": 2, "title_zh": "观察记录说明", "url": "https://example.org/records"}]},
            "thinking": {"summary": "内部思考不要显示"},
        }]})
    monkeypatch.setattr(agent, "_create_model_client", lambda: httpx.Client(transport=httpx.MockTransport(provider)))
    return requests


def test_medical_chat_preserves_authorized_context_and_saves_citations(client, monkeypatch):
    requests = mock_medical_provider(monkeypatch)
    response = client.post("/api/v1/households/hh_001/agent/chat", headers=OWNER,
                           json={"member_id": "m_001", "message": "帮我理解最近的记录"})
    assert response.status_code == 200
    body = response.json()
    assert body["model_version"] == "Baichuan-M3-Plus"
    assert body["authorization_basis"] == "household_owner"
    assert len(requests) == 1
    assert str(requests[0].url) == "https://api.baichuan-ai.com/v1/chat/completions"
    payload = json.loads(requests[0].content)
    assert all(item["role"] in {"user", "assistant"} for item in payload["messages"])
    prompt = json.dumps(payload["messages"], ensure_ascii=False)
    assert "不得诊断、改写风险等级" in prompt and "安全上下文" in prompt
    assert "帮我理解最近的记录" in prompt
    assert payload["metadata"]["output_style"] == "patient"
    assert "thinking" not in payload
    assert "https://example.org/records" in body["message"]["content"]
    assert "内部思考" not in body["message"]["content"]
    with SessionLocal() as db:
        saved = db.get(AgentMessage, body["message"]["message_id"])
        assert saved.content == body["message"]["content"]


def test_medical_background_json_is_not_polluted_by_reference_text(monkeypatch):
    decision = '{"action":"no_action","reason":"无需行动","message":""}'
    mock_medical_provider(monkeypatch, content=decision)
    reply = agent.call_model([{"role": "system", "content": "仅返回JSON"}, *MESSAGES])
    assert reply == decision
    assert agent.parse_model_decision(reply)["action"] == "no_action"


@pytest.mark.parametrize("reason", ["refuse_answer", "content_filter", "length"])
def test_medical_background_rejection_is_not_a_successful_plan(monkeypatch, reason):
    mock_medical_provider(monkeypatch, content="不完整正文", finish_reason=reason)
    with pytest.raises(HTTPException) as error:
        agent.call_model(MESSAGES)
    assert error.value.detail["code"] == "MODEL_RESPONSE_INCOMPLETE"


@pytest.mark.parametrize("base_url,provider", [
    ("https://api.baichuan-ai.com/v1", "baichuan"),
    ("https://api.deepseek.com", "deepseek"),
    ("https://provider.example/v1", "openai-compatible"),
])
def test_model_status_reports_configured_provider(client, monkeypatch, base_url, provider):
    import app.main as main
    monkeypatch.setattr(main, "settings", replace(
        main.settings, llm_base_url=base_url, llm_model="test-selected-model", llm_api_key="",
    ))
    response = client.get("/api/v1/households/hh_001/agent/status", headers=OWNER)
    assert response.status_code == 200
    assert response.json()["provider"] == provider
    assert response.json()["model"] == "test-selected-model"
    assert not response.json()["configured"]


@pytest.mark.parametrize("reply", [
    "本次未检测到任何异常信号。", "这次完全正常。", "当前结果与个人基线一致。",
    "基线一致，继续保持。", "建议每小时起来走动。", "建议喝2000毫升水。",
    "还差一次记录。^[trend]^",
    "软件不能诊断疾病。本次没有任何异常。",
    "仅供参考。\n\n**参考来源**\n\n本次完全正常。",
    "建议每天补充两千毫升水。",
])
def test_report_guard_rejects_observed_contradictions(reply):
    with pytest.raises(HTTPException) as error:
        agent.validate_report_explanation(reply, {"recommendations": []}, {"baseline_progress": {"status": "collecting"}})
    assert error.value.detail["code"] == "MODEL_REPORT_CONTRADICTION"


def test_report_guard_keeps_qualified_explanation_and_record_counts():
    reply = "未触发规则红线，不代表没有异常；不能说与个人基线一致，还需要1次可靠记录。目前无法排除疾病，仍需结合症状。建议保持每天的日常记录。"
    agent.validate_report_explanation(reply, {"recommendations": []}, {"baseline_progress": {"status": "collecting"}})


def test_mixed_dimensions_cannot_establish_overall_baseline_agreement():
    trend = {"baseline_progress": {"status": "established"}, "dimensions": {
        "shape": {"baseline_status": "deviated"}, "color": {"baseline_status": "within_baseline"},
    }}
    with pytest.raises(HTTPException):
        agent.validate_report_explanation("本次形态与个人基线一致。", {"recommendations": []}, trend)


@pytest.mark.parametrize("bad_segment", [0, 1])
def test_each_report_segment_falls_back_without_overwriting_rule_report(client, monkeypatch, normal_payload, bad_segment):
    payload = {**normal_payload, "session_id": "guard_report"}
    assert client.post("/api/v1/device-sessions", json=payload, headers={"X-Device-Key": "dev-secret"}).status_code == 202
    from app.worker import run_until_empty
    with SessionLocal() as db:
        run_until_empty(db)
    assert client.post("/api/v1/households/hh_001/sessions/guard_report/claim", json={"member_id": "m_001"}, headers=OWNER).status_code == 200
    replies = ["未触发规则红线并不等于完全正常。", "保持原有饮水和活动节奏。"]
    replies[bad_segment] = "本次没有任何异常，当前与个人基线一致。"
    prompts = []
    def caller(messages):
        prompts.append(messages)
        return replies[len(prompts) - 1]
    import app.main as main
    monkeypatch.setattr(main, "agent_analyze_session", lambda *args: agent.analyze_session(*args, model_caller=caller))
    response = client.post("/api/v1/households/hh_001/agent/session-analysis", headers=OWNER,
                           json={"member_id": "m_001", "session_id": "guard_report"})
    assert response.status_code == 200
    body = response.json()
    assert len(prompts) == 2
    assert all(agent.REPORT_EXPLANATION_RULES in p[0]["content"] for p in prompts)
    assert body["model_version"] == "policy-engine"
    assert body["report"]["status"] == "ready"
    assert "没有任何异常" not in body["message"]["content"]
    assert "当前与个人基线一致" not in body["message"]["content"]
    with SessionLocal() as db:
        audit = db.scalar(select(AgentAction).where(AgentAction.action_type == "agent_session_analysis"))
        assert audit.model_version == "policy-engine" and audit.status == "succeeded"


def test_medical_automatic_report_uses_rules_without_waiting_for_model(client, monkeypatch, normal_payload):
    payload = {**normal_payload, "session_id": "medical_rule_report"}
    assert client.post("/api/v1/device-sessions", json=payload, headers={"X-Device-Key": "dev-secret"}).status_code == 202
    from app.worker import run_until_empty
    with SessionLocal() as db:
        run_until_empty(db)
    assert client.post("/api/v1/households/hh_001/sessions/medical_rule_report/claim", json={"member_id": "m_001"}, headers=OWNER).status_code == 200
    requests = mock_medical_provider(monkeypatch, content="完全正常，不应使用这段回答。")
    response = client.post("/api/v1/households/hh_001/agent/session-analysis", headers=OWNER,
                           json={"member_id": "m_001", "session_id": "medical_rule_report"})
    assert response.status_code == 200
    body = response.json()
    assert not requests
    assert body["model_version"] == "policy-engine"
    assert body["report"]["summary"] in body["message"]["content"]
    assert all(item["guidance"] in body["message"]["content"] for item in body["report"]["recommendations"])
    assert "完全正常" not in body["message"]["content"]
