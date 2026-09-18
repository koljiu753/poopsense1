from dataclasses import replace
import json

import httpx
import pytest
from sqlalchemy import select

import app.agent as agent
from app.chat_refinement import question_only_context, reply_format, reply_style
from app.database import SessionLocal
from app.models import AgentAction, AgentMessage, AgentProfile


OWNER = {"X-Household-Key": "household-secret"}
VIEWER = {"X-Household-Key": "viewer-secret"}
CHAT = "/api/v1/households/hh_001/agent/chat"
MEMORY = "/api/v1/households/hh_001/members/m_001/memory"
GENERAL = "膳食纤维与排便有什么关系？只做一般健康科普，不引用成员数据，不给剂量。"
PRIVATE = "MEMORY_PRIVATE_SENTINEL"
NICKNAME = "PROFILE_PRIVATE_SENTINEL"
SOUL = "SOUL_PRIVATE_SENTINEL"


@pytest.mark.parametrize("text,expected", [
    ("膳食纤维是什么？", "brief"),
    ("请简短解释便秘", "brief"),
    ("不用详细解释，说重点", "brief"),
    ("无需展开", "brief"),
    ("先简要结论，再详细解释", "detailed"),
    ("先用一句话概括，然后详细展开", "detailed"),
    ("请详细解释，不要简短回答", "detailed"),
    ("详细一点", "detailed"),
    ("展开说说", "detailed"),
    ("逐步解释其中的原理", "detailed"),
    ("详细内容我以后再问，这次简短回答", "brief"),
])
def test_current_question_selects_presentation_without_changing_safety(text, expected):
    assert reply_style(text) == expected
    contract = reply_format(expected)
    assert "安全提醒和不确定性说明必须完整" in contract
    assert ("100至180" in contract) == (expected == "brief")


@pytest.mark.parametrize("text,expected", [
    (GENERAL, True),
    ("一般健康知识：膳食纤维有什么作用？", True),
    ("请健康科普一下什么是肠道菌群", True),
    ("不引用个人资料，我最近便秘怎么办？", True),
    ("我最近便秘怎么办？", False),
    ("便秘怎么办？", False),
    ("一般健康知识：我最近便秘怎么办？", False),
    ("一般健康知识：孩子便秘怎么办？", False),
    ("一般健康知识：便秘已经三天怎么办？", False),
    ("请看我的记录并解释", False),
    ("不需要详细解释我的记录", False),
])
def test_general_context_scope_is_conservative(text, expected):
    assert question_only_context(text) is expected


def test_general_followup_inherits_scope_but_personal_followup_reopens_authorized_history():
    assert question_only_context("详细一点", inherited=True, previous_scope="question_only")
    assert not question_only_context("那我呢", inherited=True, previous_scope="question_only")
    assert not question_only_context("详细一点", inherited=True, previous_scope="member_history")


@pytest.fixture
def provider(monkeypatch):
    agent.close_model_client()
    config = replace(agent.settings, llm_routing_enabled=True, llm_profiles_json="{}", llm_routes_json="{}",
                     llm_api_key="", llm_chat_max_tokens=1024)
    monkeypatch.setattr(agent, "settings", config)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fictional-deepseek-key")
    monkeypatch.setenv("BAICHUAN_API_KEY", "fictional-baichuan-key")
    requests = []
    response_content = {"text": "膳食纤维可帮助维持规律。具体感受因人而异。"}
    def respond(request):
        requests.append(request)
        model = "Baichuan-M3-Plus-test" if request.url.host == "api.baichuan-ai.com" else "deepseek-v4-pro-test"
        return httpx.Response(200, json={"model": model, "choices": [{
            "finish_reason": "stop", "message": {"content": response_content["text"]},
        }]})
    monkeypatch.setattr(agent, "_create_model_client", lambda: httpx.Client(transport=httpx.MockTransport(respond)))
    yield requests, response_content
    agent.close_model_client()


def add_private_memory(client):
    assert client.post(MEMORY, headers=OWNER, json={"memory_key": "个人备注", "content": PRIVATE}).status_code == 200


def send(client, text, conversation_id=None, headers=OWNER):
    payload = {"member_id": "m_001", "message": text}
    if conversation_id:
        payload["conversation_id"] = conversation_id
    return client.post(CHAT, headers=headers, json=payload)


def payload_text(request):
    return json.dumps(json.loads(request.content)["messages"], ensure_ascii=False)


def test_general_medical_question_does_not_query_or_send_private_history(client, monkeypatch, provider):
    requests, _ = provider
    add_private_memory(client)
    with SessionLocal() as db:
        profile = agent.get_or_create_profile(db, "hh_001", "m_001")
        profile.display_name = NICKNAME
        profile.soul = {"tone": SOUL}
        db.commit()
    def no_trend(*args, **kwargs):
        pytest.fail("General knowledge should not read personal trends")
    monkeypatch.setattr(agent, "member_trend", no_trend)
    response = send(client, GENERAL)
    assert response.status_code == 200
    body = response.json()
    metadata = body["message"]["metadata"]
    assert metadata["response_style"] == "brief" and metadata["context_scope"] == "question_only"
    assert metadata["model_route"]["task"] == "health_knowledge"
    assert body["model_version"] == "Baichuan-M3-Plus-test"
    assert len(requests) == 1 and requests[0].url.host == "api.baichuan-ai.com"
    payload = json.loads(requests[0].content)
    assert payload["max_tokens"] == 1024 and payload["metadata"]["output_style"] == "patient"
    assert "thinking" not in payload
    prompt = payload_text(requests[0])
    assert all(secret not in prompt for secret in (PRIVATE, NICKNAME, SOUL))
    assert '"trend"' not in prompt and "recent_assessments" not in prompt and "visible_memory" not in prompt
    context = json.loads(payload["messages"][0]["content"].split("\n", 1)[1])
    system = context["software_constraints_and_authorized_context"][0]
    assert context["user_input"] == GENERAL
    assert system.endswith(reply_format("brief"))
    assert "不得诊断、改写风险等级" in system and "100至180" in system
    assert "不主动添加研究样本量、效果百分比或剂量" in system
    with SessionLocal() as db:
        audit = db.scalar(select(AgentAction).where(AgentAction.action_type == "agent_chat_response"))
        assert audit.input_summary["context_scope"] == "question_only"
        assert audit.input_summary["response_style"] == "brief"
        assert audit.model_version == body["model_version"]
        assert db.get(AgentMessage, body["message"]["message_id"]).content == body["message"]["content"]


def test_explicit_general_question_does_not_replay_previous_personal_turn(client, provider):
    requests, content = provider
    add_private_memory(client)
    content["text"] = "PREVIOUS_PRIVATE_REPLY"
    first = send(client, "我最近便秘，想理解我的记录")
    assert first.status_code == 200
    assert PRIVATE in payload_text(requests[0])
    second = send(client, GENERAL, first.json()["conversation_id"])
    assert second.status_code == 200
    assert len(requests) == 2
    assert PRIVATE not in payload_text(requests[1])
    assert "PREVIOUS_PRIVATE_REPLY" not in payload_text(requests[1])
    assert "我最近便秘" not in payload_text(requests[1])
    assert second.json()["message"]["metadata"]["context_scope"] == "question_only"


def test_detailed_medical_followup_stays_on_same_provider_and_scope(client, provider):
    requests, content = provider
    add_private_memory(client)
    first = send(client, GENERAL)
    assert first.status_code == 200
    complete_long_answer = "完整的详细说明。\n\n" * 30 + "如有紧急症状，请及时就医。"
    content["text"] = complete_long_answer
    second = send(client, "详细一点", first.json()["conversation_id"])
    assert second.status_code == 200
    assert second.json()["message"]["content"] == complete_long_answer
    assert len(requests) == 2 and all(item.url.host == "api.baichuan-ai.com" for item in requests)
    text = payload_text(requests[1])
    assert PRIVATE not in text
    assert "不受默认短答字数限制" in text and "100至180" not in text
    assert GENERAL in text and "conversation_followup" in text
    metadata = second.json()["message"]["metadata"]
    assert metadata["response_style"] == "detailed" and metadata["context_scope"] == "question_only"
    assert metadata["model_route"]["reason"] == "inherited_followup"


def test_personal_question_keeps_authorized_facts_and_default_complete_reply(client, provider):
    requests, content = provider
    add_private_memory(client)
    complete = "保留完整回答而不是从中剪掉信息。\n\n" * 20 + "这是结尾的必要安全提醒。"
    content["text"] = complete
    response = send(client, "一般健康知识：我最近便秘，想了解原因")
    assert response.status_code == 200
    assert PRIVATE in payload_text(requests[0]) and "recent_assessments" in payload_text(requests[0])
    assert response.json()["message"]["metadata"]["context_scope"] == "member_history"
    assert response.json()["message"]["content"] == complete
    assert len(requests) == 1


def test_history_exclusion_does_not_downgrade_redline_or_switch_provider(client, provider):
    requests, _ = provider
    add_private_memory(client)
    response = send(client, "我出现血便，不引用成员数据，请简短回答")
    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "urgent_care"
    assert body["allowed_actions"] == ["explain_safety_limit", "recommend_urgent_care"]
    assert requests[0].url.host == "api.deepseek.com"
    text = payload_text(requests[0])
    assert PRIVATE not in text
    assert "必须明确建议尽快线下就医" in text
    assert "安全提醒和不确定性说明必须完整" in text
    assert body["message"]["metadata"]["model_route"]["task"] == "urgent_care"


def test_general_label_cannot_bypass_member_authorization(client, monkeypatch, provider):
    requests, _ = provider
    response = send(client, GENERAL, headers=VIEWER)
    assert response.status_code == 403 and not requests
    with SessionLocal() as db:
        assert db.scalar(select(AgentMessage)) is None
