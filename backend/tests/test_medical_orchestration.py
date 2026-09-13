from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import select

import app.agent as agent
from app.agent_native import get_or_create_profile
from app.database import SessionLocal
from app.models import AgentAction, Assessment, HouseholdMember, OutboxEvent, SessionRecord


OWNER = {"X-Household-Key": "household-secret"}
DEVICE = {"X-Device-Key": "dev-secret"}
NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz is not None else NOW.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def medical_provider_without_network(monkeypatch):
    agent.close_model_client()
    monkeypatch.setattr(agent, "settings", replace(
        agent.settings, llm_api_key="test-medical-provider-key",
        llm_base_url="https://api.baichuan-ai.com/v1", llm_model="Baichuan-M3-Plus",
    ))
    monkeypatch.setattr(agent, "datetime", FixedDatetime)

    def unexpected_network(*args, **kwargs):
        pytest.fail("Medical policy orchestration must not construct or call a model client")

    monkeypatch.setattr(agent, "_create_model_client", unexpected_network)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", unexpected_network)
    yield
    agent.close_model_client()


@pytest.fixture(autouse=True)
def available_member_profile(client):
    with SessionLocal() as db:
        profile = get_or_create_profile(db, "hh_001", "m_001")
        profile.proactive_enabled = True
        profile.daily_non_redline_limit = 1
        profile.timezone = "UTC"
        profile.quiet_start = "00:00"
        profile.quiet_end = "00:01"
        db.commit()


def claimed_record(client, normal_payload, name, *, color="brown", confidence=0.74):
    payload = deepcopy(normal_payload)
    payload["session_id"] = name
    payload["correlation_id"] = f"cor_{name}"
    payload["observations"]["color"]["value"] = color
    payload["quality"]["overall_confidence"] = confidence
    response = client.post("/api/v1/device-sessions", json=payload, headers=DEVICE)
    assert response.status_code == 202
    claimed = client.post(f"/api/v1/households/hh_001/sessions/{name}/claim",
                          json={"member_id": "m_001"}, headers=OWNER)
    assert claimed.status_code == 200
    with SessionLocal() as db:
        record = db.scalar(select(SessionRecord).where(SessionRecord.external_session_id == name))
        return record.id


def dispatches_for(db, action):
    return db.scalars(select(OutboxEvent).where(
        OutboxEvent.topic == "agent_action.dispatch",
        OutboxEvent.aggregate_id == str(action.id),
    )).all()


def assert_policy_source(action):
    assert action.model_version == "policy-engine"
    assert action.input_summary["decision_source"] == "policy"


def test_default_medical_orchestration_queues_one_checkin_and_is_idempotent(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_checkin")
    with SessionLocal() as db:
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.action_type == "llm_send_check_in"
        assert action.status == "pending"
        assert action.recipient_id == "u_owner"
        assert action.authorization_basis == "subject_member"
        assert action.input_summary["allowed_actions"] == ["no_action", "send_check_in"]
        assert action.result == {
            "reason": "policy_medical_provider",
            "message": "新记录已整理，可以打开报告查看本次观察并记录感受",
            "model_route": {"mode": "single", "task": "structured_action", "source": "policy",
                            "model": "policy-engine", "reason": "rule_action"},
        }
        dispatch = dispatches_for(db, action)
        assert len(dispatch) == 1
        assert dispatch[0].payload == {"action_id": action.id}
        assert dispatch[0].status == "pending"
        again = agent.orchestrate_session(db, record_id)
        assert again.id == action.id
        assert len(dispatches_for(db, again)) == 1
        generated = db.scalars(select(AgentAction).where(
            AgentAction.session_id == record_id,
            AgentAction.action_type.in_(["llm_send_check_in", "llm_no_action"]),
        )).all()
        assert len(generated) == 1


def test_medical_checkin_respects_member_disable(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_disabled")
    with SessionLocal() as db:
        profile = get_or_create_profile(db, "hh_001", "m_001")
        profile.proactive_enabled = False
        db.commit()
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.action_type == "llm_no_action"
        assert action.status == "succeeded"
        assert action.result["reason"] == "member_proactive_disabled"
        assert not dispatches_for(db, action)


def test_medical_checkin_respects_actual_quiet_hours(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_quiet")
    with SessionLocal() as db:
        profile = get_or_create_profile(db, "hh_001", "m_001")
        profile.quiet_start = "11:00"
        profile.quiet_end = "13:00"
        db.commit()
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.action_type == "llm_no_action"
        assert action.result["reason"] == "member_quiet_hours"
        assert not dispatches_for(db, action)


def test_medical_checkin_respects_daily_limit_across_records(client, normal_payload):
    first_id = claimed_record(client, normal_payload, "medical_daily_first")
    second_id = claimed_record(client, normal_payload, "medical_daily_second")
    with SessionLocal() as db:
        first = agent.orchestrate_session(db, first_id)
        assert first.action_type == "llm_send_check_in"
        second = agent.orchestrate_session(db, second_id)
        assert_policy_source(second)
        assert second.action_type == "llm_no_action"
        assert second.result["reason"] == "daily_proactive_limit_reached"
        assert len(dispatches_for(db, first)) == 1
        assert not dispatches_for(db, second)


def test_unreliable_medical_record_has_only_no_action(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_unreliable", confidence=0.2)
    with SessionLocal() as db:
        assessment = db.scalar(select(Assessment).where(
            Assessment.session_id == record_id, Assessment.active.is_(True),
        ))
        assert assessment.reliable is False
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.input_summary["allowed_actions"] == ["no_action"]
        assert action.action_type == "llm_no_action"
        assert action.result["message"] == ""
        assert action.result["reason"] == "policy_medical_provider"
        assert not dispatches_for(db, action)


def test_redline_uses_rule_reminder_and_keeps_existing_redline_dispatch(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_redline", color="red")
    with SessionLocal() as db:
        profile = get_or_create_profile(db, "hh_001", "m_001")
        profile.proactive_enabled = False
        profile.daily_non_redline_limit = 0
        profile.quiet_start = "11:00"
        profile.quiet_end = "13:00"
        db.commit()
        assessment = db.scalar(select(Assessment).where(
            Assessment.session_id == record_id, Assessment.active.is_(True),
        ))
        assert assessment.reliable is True and assessment.risk_level == "redline"
        existing = db.scalars(select(AgentAction).where(
            AgentAction.session_id == record_id, AgentAction.action_type == "redline_notification",
        )).all()
        assert existing and any(item.recipient_id == "u_owner" for item in existing)
        before_dispatch_ids = {event.id for item in existing for event in dispatches_for(db, item)}
        assert before_dispatch_ids
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.action_type == "llm_redline_notification"
        assert action.input_summary["allowed_actions"] == ["redline_notification"]
        assert action.result["reason"] == "policy_medical_provider"
        assert "报告中的安全提示" in action.result["message"]
        assert action.recipient_id == "u_owner"
        assert action.status == "succeeded"
        assert not dispatches_for(db, action)
        assert {event.id for item in existing for event in dispatches_for(db, item)} == before_dispatch_ids


def test_member_without_linked_account_does_not_receive_dispatch(client, normal_payload):
    record_id = claimed_record(client, normal_payload, "medical_no_account")
    with SessionLocal() as db:
        member = db.get(HouseholdMember, "m_001")
        member.linked_user_id = None
        db.commit()
        action = agent.orchestrate_session(db, record_id)
        assert_policy_source(action)
        assert action.action_type == "llm_send_check_in"
        assert action.status == "succeeded"
        assert action.recipient_id is None
        assert action.authorization_basis == "policy_only"
        assert not dispatches_for(db, action)
