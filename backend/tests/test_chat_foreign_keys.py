"""Exercise actual FK enforcement, which the default SQLite suite leaves off."""
from dataclasses import replace
from datetime import datetime, timezone

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app import agent, main
from app.agent_loop import start_chat_run
from app.database import Base, get_db
from app.models import (
    AgentConversation, AgentHandoff, AgentMessage, AgentProfile, AgentProfileRevision, AgentRun, AgentStep,
    ApiCredential, Household, HouseholdMember, HouseholdMembership, UserAccount,
)
from app.service import hash_secret


OWNER = {"X-Household-Key": "fk-test-owner"}
CHAT = "/api/v1/households/hh_fk/agent/chat"


@pytest.fixture
def fk_workspace(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'chat-fk.db'}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions() as db:
        assert db.scalar(text("PRAGMA foreign_keys")) == 1
        db.add_all([UserAccount(id="u_fk", display_name="Test owner", active=True),
                    Household(id="hh_fk", name="FK test", active=True)])
        db.flush()
        db.add_all([
            HouseholdMember(id="m_fk", household_id="hh_fk", display_name="Test member", linked_user_id="u_fk", active=True),
            HouseholdMembership(household_id="hh_fk", user_id="u_fk", role="owner", active=True),
            ApiCredential(api_key_hash=hash_secret("fk-test-owner"), user_id="u_fk", active=True),
        ])
        db.commit()

    def database_override():
        with sessions() as db:
            assert db.scalar(text("PRAGMA foreign_keys")) == 1
            yield db

    monkeypatch.setattr(main, "settings", replace(main.settings, auto_create_schema=False,
                        bootstrap_demo_device=False, bootstrap_demo_data=False, inline_worker_enabled=False))
    prior = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[get_db] = database_override
    try:
        with TestClient(main.app) as client:
            yield client, sessions
    finally:
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(prior)
        engine.dispose()


@pytest.mark.parametrize("message,expected_steps,expected_calls", [
    ("你好，介绍一下自己", 2, 1),
    ("请让健康医生和生活教练一起做综合分析", 4, 2),
])
def test_chat_persists_parent_children_and_profile_with_foreign_keys(fk_workspace, monkeypatch, message, expected_steps, expected_calls):
    client, sessions = fk_workspace
    calls = []

    def fake_chat(db, auth, member_id, question, conversation_id=None):
        return agent.chat(db, auth, member_id, question, conversation_id,
                          model_caller=lambda messages: calls.append(messages) or "固定测试回复，仅验证数据库。")

    monkeypatch.setattr(main, "agent_chat", fake_chat)
    response = client.post(CHAT, headers=OWNER, json={"member_id": "m_fk", "message": message})
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(calls) == expected_calls
    with sessions() as db:
        run = db.get(AgentRun, body["run_id"])
        assert run.status == "completed"
        assert db.get(AgentConversation, run.conversation_id) is not None
        assert len(db.scalars(select(AgentMessage).where(AgentMessage.conversation_id == run.conversation_id)).all()) == 2
        assert len(db.scalars(select(AgentStep).where(AgentStep.run_id == run.id)).all()) == expected_steps
        assert len(db.scalars(select(AgentHandoff).where(AgentHandoff.run_id == run.id)).all()) == expected_steps - 1
        profile = db.scalar(select(AgentProfile))
        assert db.scalar(select(AgentProfileRevision).where(AgentProfileRevision.profile_id == profile.id)) is not None
        assert db.execute(text("PRAGMA foreign_key_check")).all() == []
    followup = client.post(CHAT, headers=OWNER, json={"member_id": "m_fk", "message": "继续解释",
                                                   "conversation_id": body["conversation_id"]})
    assert followup.status_code == 200, followup.text
    assert followup.json()["conversation_id"] == body["conversation_id"]


@pytest.mark.parametrize("confirmed,expected", [(True, "completed"), (False, "cancelled")])
def test_pause_resume_keeps_valid_run_handoff_graph(fk_workspace, monkeypatch, confirmed, expected):
    client, sessions = fk_workspace
    paused = client.post(CHAT, headers=OWNER,
                         json={"member_id": "m_fk", "message": "帮我授权家庭成员查看"})
    assert paused.status_code == 200, paused.text
    run_id = paused.json()["run_id"]

    def fake_resume(db, auth, target_id, allowed):
        return agent.resume_paused_chat(db, auth, target_id, allowed,
                                        model_caller=lambda _: "确认已收到，请选择成员和授权范围。")

    monkeypatch.setattr(main, "resume_paused_chat", fake_resume)
    url = f"/api/v1/households/hh_fk/agent/runs/{run_id}/resume"
    response = client.post(url, headers=OWNER, json={"confirmed": confirmed})
    assert response.status_code == 200, response.text
    assert response.json()["run"]["status"] == expected
    assert client.post(url, headers=OWNER, json={"confirmed": confirmed}).status_code == 409
    with sessions() as db:
        assert db.execute(text("PRAGMA foreign_key_check")).all() == []


def test_start_run_flushes_but_does_not_commit_parent_or_children(fk_workspace, monkeypatch):
    _, sessions = fk_workspace
    now = datetime.now(timezone.utc)
    with sessions() as db:
        db.add(AgentConversation(id="conv_rollback", household_id="hh_fk", subject_member_id="m_fk",
                                 created_by_user_id="u_fk", status="active", created_at=now, updated_at=now))
        db.flush()

        def forbidden_commit():
            raise AssertionError("start_chat_run must leave transaction ownership to its caller")

        monkeypatch.setattr(db, "commit", forbidden_commit)
        run, _ = start_chat_run(db, household_id="hh_fk", member_id="m_fk", conversation_id="conv_rollback",
                                user_id="u_fk", goal="transaction test", authorization_basis="household_owner",
                                delegated_agent="health_doctor", skill="health_education", skill_version="1.0.0",
                                context_domains=(), policy_version="test")
        run_id = run.id
        assert db.scalar(select(AgentHandoff).where(AgentHandoff.run_id == run_id)) is not None
        db.rollback()
    with sessions() as db:
        assert db.get(AgentRun, run_id) is None
        assert db.get(AgentConversation, "conv_rollback") is None
        assert db.scalar(select(AgentStep).where(AgentStep.run_id == run_id)) is None
        assert db.scalar(select(AgentHandoff).where(AgentHandoff.run_id == run_id)) is None


def test_fixture_actually_rejects_an_orphan_child(fk_workspace):
    _, sessions = fk_workspace
    with sessions() as db:
        now = datetime.now(timezone.utc)
        db.add(AgentHandoff(run_id="missing-run", from_step_index=1, to_step_index=2,
                            from_agent="main_agent", to_agent="health_doctor", skill_name="health_education",
                            skill_version="1.0.0", context_domains=[], payload={}, authorization_basis="test",
                            status="accepted", created_at=now, accepted_at=now))
        with pytest.raises(IntegrityError, match="FOREIGN KEY constraint failed"):
            db.flush()
        db.rollback()
