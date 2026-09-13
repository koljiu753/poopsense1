from dataclasses import replace

import httpx
from sqlalchemy import func, select

import app.agent as agent
from app.database import SessionLocal
from app.models import AgentAction, AgentConversation, AgentMessage


CHAT = "/api/v1/households/hh_001/agent/chat"
OWNER = {"X-Household-Key": "household-secret"}


def counts():
    with SessionLocal() as db:
        return tuple(db.scalar(select(func.count()).select_from(model))
                     for model in (AgentConversation, AgentMessage, AgentAction))


def test_missing_conversation_never_silently_starts_a_new_one(client, monkeypatch):
    calls = []
    agent.close_model_client()
    monkeypatch.setattr(agent, "settings", replace(agent.settings, llm_routing_enabled=False,
                        llm_api_key="test-expiry-key", llm_base_url="https://api.deepseek.com"))

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"model": "deepseek-v4-pro", "choices": [{
            "finish_reason": "stop", "message": {"role": "assistant", "content": "这是一次新的问答。"},
        }]})

    monkeypatch.setattr(agent, "_create_model_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    before = counts()
    try:
        for question in ("继续说", "请解释膳食纤维与肠道的关系"):
            response = client.post(CHAT, headers=OWNER, json={"member_id": "m_001", "message": question,
                                   "conversation_id": "expired-conversation"})
            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "CONVERSATION_EXPIRED"
        assert calls == [] and counts() == before
        # A fresh conversation is possible only when explicitly requested.
        fresh = client.post(CHAT, headers=OWNER, json={"member_id": "m_001", "message": "请解释膳食纤维与肠道的关系"})
        assert fresh.status_code == 200
        assert fresh.json()["conversation_id"] != "expired-conversation"
        assert len(calls) == 1
    finally:
        agent.close_model_client()


def test_missing_conversation_does_not_bypass_member_authorization(client):
    before = counts()
    response = client.post(CHAT, headers={"X-Household-Key": "viewer-secret"}, json={
        "member_id": "m_001", "message": "继续说", "conversation_id": "expired-conversation",
    })
    assert response.status_code == 403
    assert counts() == before
