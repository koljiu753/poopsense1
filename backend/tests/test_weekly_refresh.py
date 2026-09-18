from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from threading import Barrier, Event, Lock, current_thread

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

import app.weekly_reports as weekly
from app.database import SessionLocal
from app.models import AgentAction, Observation, SessionRecord, UserNotification, WeeklyHealthReport
from app.service import AuthContext, member_trend


OWNER = {"X-Household-Key": "household-secret"}
VIEWER = {"X-Household-Key": "viewer-secret"}
DEVICE = {"X-Device-Key": "dev-secret"}
AUTH = AuthContext(user_id="u_owner", role="owner", household_id="hh_001")
URL = "/api/v1/households/hh_001/members/m_001/weekly-reports"
WEDNESDAY = datetime(2026, 9, 16, 4, tzinfo=timezone.utc)


def freeze(monkeypatch, now=WEDNESDAY):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.astimezone(tz) if tz else now.replace(tzinfo=None)
    monkeypatch.setattr(weekly, "datetime", Clock)


def upload(client, base, name, when, *, member="m_001", reliable=True):
    payload = deepcopy(base)
    payload.update(session_id=name, correlation_id="cor_" + name,
                   timestamp=when.isoformat(), end_timestamp=(when + timedelta(seconds=93)).isoformat())
    if not reliable:
        payload["quality"]["overall_confidence"] = 0.2
        for observation in payload["observations"].values():
            observation["confidence"] = 0.2
    assert client.post("/api/v1/device-sessions", json=payload, headers=DEVICE).status_code == 202
    if member:
        assert client.post(f"/api/v1/households/hh_001/sessions/{name}/claim", headers=OWNER,
                           json={"member_id": member}).status_code == 200


def stats():
    with SessionLocal() as db:
        return (
            db.scalar(select(func.count()).select_from(WeeklyHealthReport)),
            db.scalar(select(func.count()).select_from(AgentAction).where(
                AgentAction.action_type.in_(["weekly_report_ready", "weekly_report_updated"]))),
            db.scalar(select(func.count()).select_from(UserNotification).where(
                UserNotification.notification_type == "weekly_report_ready")),
        )


@pytest.mark.parametrize("now,expected_start,included,excluded", [
    (datetime(2026, 9, 13, 16, 0, tzinfo=timezone.utc), date(2026, 9, 14),
     datetime(2026, 9, 13, 16, 0, tzinfo=timezone.utc), datetime(2026, 9, 13, 15, 59, 59, tzinfo=timezone.utc)),
    (datetime(2026, 9, 20, 15, 59, 59, tzinfo=timezone.utc), date(2026, 9, 14),
     datetime(2026, 9, 20, 15, 59, 58, tzinfo=timezone.utc), datetime(2026, 9, 20, 16, 0, tzinfo=timezone.utc)),
])
def test_beijing_natural_week_includes_boundaries_and_excludes_prior_and_future(
    client, normal_payload, monkeypatch, now, expected_start, included, excluded,
):
    freeze(monkeypatch, now)
    upload(client, normal_payload, "included", included)
    upload(client, normal_payload, "excluded", excluded)
    response = client.post(URL, headers=OWNER)
    assert response.status_code == 200
    report = response.json()
    assert report["period_start"] == expected_start.isoformat()
    assert report["period_end"] == (expected_start + timedelta(days=6)).isoformat()
    assert report["facts"]["valid_sessions"] == 1
    assert report["facts"]["assigned_sessions"] == 1
    assert report["facts"]["reliable_days"] == 1
    assert report["facts"]["timezone"] == "Asia/Shanghai"
    assert report["facts"]["data_as_of"] == now.isoformat()


def test_reliable_days_are_local_calendar_days_not_sample_ratio(client, normal_payload, monkeypatch):
    freeze(monkeypatch)
    for name, when, reliable in [
        ("mon", datetime(2026, 9, 14, 15, 59, tzinfo=timezone.utc), True),
        ("tue1", datetime(2026, 9, 14, 16, 0, tzinfo=timezone.utc), True),
        ("tue2", datetime(2026, 9, 15, 3, 0, tzinfo=timezone.utc), True),
        ("wed_low", datetime(2026, 9, 15, 16, 0, tzinfo=timezone.utc), False),
    ]:
        upload(client, normal_payload, name, when, reliable=reliable)
    upload(client, normal_payload, "pending", WEDNESDAY - timedelta(minutes=5), member=None)
    upload(client, normal_payload, "other_member", WEDNESDAY - timedelta(minutes=5), member="m_002")
    upload(client, normal_payload, "last_week", datetime(2026, 9, 13, 15, 59, tzinfo=timezone.utc))
    upload(client, normal_payload, "future", WEDNESDAY + timedelta(seconds=1))
    report = client.post(URL, headers=OWNER).json()
    assert report["facts"]["valid_sessions"] == 3
    assert report["facts"]["assigned_sessions"] == 4
    assert report["facts"]["reliable_days"] == 2
    assert report["facts"]["coverage"] == 0.75
    assert "2 天" in report["summary"] and "3 次" in report["summary"]
    with SessionLocal() as db:
        bounded = member_trend(db, "hh_001", "m_001", 7,
            period_start=datetime(2026, 9, 13, 16, tzinfo=timezone.utc),
            period_end=datetime(2026, 9, 20, 16, tzinfo=timezone.utc),
            as_of=WEDNESDAY, calendar_timezone=weekly.REPORT_TIMEZONE)
    assert bounded["weekly_series"][0]["assigned_sessions"] == 4
    assert bounded["baseline_progress"]["current_valid_sessions"] == 4  # Prior history is valid, future is not.


def test_new_record_refreshes_same_report_and_preserves_original_audit_and_notification(
    client, normal_payload, monkeypatch,
):
    freeze(monkeypatch)
    first = client.post(URL, headers=OWNER).json()
    with SessionLocal() as db:
        original_action = deepcopy(db.scalar(select(AgentAction).where(
            AgentAction.action_type == "weekly_report_ready")).result)
        notification_body = db.scalar(select(UserNotification)).body
    upload(client, normal_payload, "new_record", WEDNESDAY - timedelta(hours=1))
    second = client.post(URL, headers=OWNER).json()
    assert second["report_id"] == first["report_id"]
    assert second["created_at"] == first["created_at"]
    assert second["facts"]["revision"] == 2 and second["facts"]["valid_sessions"] == 1
    assert second["facts"]["source_fingerprint"] != first["facts"]["source_fingerprint"]
    assert stats() == (1, 2, 1)
    with SessionLocal() as db:
        original = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_ready"))
        update = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_updated"))
        assert original.result == original_action
        assert update.result["previous_snapshot"]["facts"] == first["facts"]
        assert update.result["snapshot"]["facts"] == second["facts"]
        assert update.result["model_route"]["source"] == "policy"
        assert db.scalar(select(UserNotification)).body == notification_body


def test_unchanged_source_reuses_snapshot_even_when_clock_advances(client, normal_payload, monkeypatch):
    freeze(monkeypatch)
    monkeypatch.setattr(weekly, "settings", replace(weekly.settings, llm_api_key="fictional-test-key"))
    for index in range(3):
        upload(client, normal_payload, f"stable{index}", WEDNESDAY - timedelta(hours=index + 1))
    calls = []
    def model(messages):
        calls.append(messages)
        return "继续积累记录，保持原有生活节奏。"
    with SessionLocal() as db:
        first = weekly.generate(db, AUTH, "m_001", model_caller=model)
    freeze(monkeypatch, WEDNESDAY + timedelta(hours=5))
    with SessionLocal() as db:
        second = weekly.generate(db, AUTH, "m_001", model_caller=model)
    assert first == second
    assert len(calls) == 1 and stats() == (1, 1, 1)
    content = calls[0][1]["content"]
    assert "source_fingerprint" not in content and "revision" not in content


@pytest.mark.parametrize("change", ["assignment", "reassessment", "observation", "timestamp"])
def test_corrections_reassessment_and_facts_invalidate_the_snapshot(
    client, normal_payload, monkeypatch, change,
):
    freeze(monkeypatch)
    upload(client, normal_payload, "editable", WEDNESDAY - timedelta(hours=1))
    first = client.post(URL, headers=OWNER).json()
    if change == "assignment":
        assert client.post("/api/v1/households/hh_001/sessions/editable/claim", headers=OWNER,
                           json={"member_id": "m_002", "claim_method": "correction"}).status_code == 200
    elif change == "reassessment":
        assert client.post("/api/v1/households/hh_001/sessions/editable/reassess", headers=OWNER).status_code == 200
    else:
        with SessionLocal() as db:
            record = db.scalar(select(SessionRecord).where(SessionRecord.external_session_id == "editable"))
            if change == "observation":
                db.scalar(select(Observation).where(Observation.session_id == record.id,
                                                    Observation.dimension == "shape")).value = "hard"
            else:
                record.occurred_at = WEDNESDAY - timedelta(days=1)
            db.commit()
    second = client.post(URL, headers=OWNER).json()
    assert second["report_id"] == first["report_id"]
    assert second["facts"]["revision"] == 2
    assert second["facts"]["source_fingerprint"] != first["facts"]["source_fingerprint"]
    assert second["facts"]["valid_sessions"] == (0 if change == "assignment" else 1)
    assert stats() == (1, 2, 1)


def test_legacy_report_upgrades_without_editing_its_audit_or_notifying_again(client, monkeypatch):
    freeze(monkeypatch)
    first = client.post(URL, headers=OWNER).json()
    with SessionLocal() as db:
        row = db.get(WeeklyHealthReport, first["report_id"])
        row.facts = {"valid_sessions": 99, "coverage": 1.0}
        row.summary = "历史快照"
        db.commit()
        original_action = deepcopy(db.scalar(select(AgentAction)).result)
    upgraded = client.post(URL, headers=OWNER).json()
    assert upgraded["report_id"] == first["report_id"]
    assert upgraded["facts"]["schema_version"] == 2
    assert upgraded["facts"]["valid_sessions"] == 0
    with SessionLocal() as db:
        original = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_ready"))
        update = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_updated"))
        assert original.result == original_action
        assert update.result["previous_snapshot"]["summary"] == "历史快照"
    assert stats() == (1, 2, 1)


def test_authorization_runs_before_reading_source_or_calling_model(client, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("Unauthorized caller must not query weekly source or use a model")
    monkeypatch.setattr(weekly, "member_trend", unexpected)
    assert client.post(URL, headers=VIEWER).status_code == 403
    assert client.get(URL, headers=VIEWER).status_code == 403
    assert client.post(URL.replace("m_001", "nonexistent"), headers=OWNER).status_code == 404
    assert stats() == (0, 0, 0)


@pytest.mark.parametrize("refresh", [False, True])
def test_concurrent_requests_use_one_model_and_one_notification(client, normal_payload, monkeypatch, refresh):
    freeze(monkeypatch)
    for index in range(3):
        upload(client, normal_payload, f"concurrent{index}", WEDNESDAY - timedelta(hours=index + 1))
    if refresh:
        assert client.post(URL, headers=OWNER).status_code == 200
        upload(client, normal_payload, "concurrent_new", WEDNESDAY - timedelta(minutes=5))
    monkeypatch.setattr(weekly, "settings", replace(weekly.settings, llm_api_key="fictional-test-key"))
    barrier, lock, calls = Barrier(2), Lock(), []
    actual_trend = weekly.member_trend
    def simultaneous_source(*args, **kwargs):
        result = actual_trend(*args, **kwargs)
        barrier.wait(timeout=5)
        return result
    monkeypatch.setattr(weekly, "member_trend", simultaneous_source)
    def model(messages):
        with lock:
            calls.append(messages)
        return "继续积累记录，保持原有生活节奏。"
    def request():
        with SessionLocal() as db:
            try:
                return weekly.generate(db, AUTH, "m_001", model_caller=model)
            except HTTPException as exc:
                assert exc.status_code == 409 and exc.detail["code"] == "WEEKLY_REPORT_BUSY"
                return None
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = [future.result(timeout=12) for future in [executor.submit(request), executor.submit(request)]]
    completed = [result for result in results if result]
    assert completed and len({result["report_id"] for result in completed}) == 1
    assert len(calls) == 1
    assert stats() == (1, 2 if refresh else 1, 1)
    with SessionLocal() as db:
        row = db.scalar(select(WeeklyHealthReport))
        assert row.status == "ready" and "_refreshing" not in row.facts


def test_failed_database_claim_returns_retryable_error_without_model_or_partial_report(client, monkeypatch):
    freeze(monkeypatch)
    with SessionLocal() as db:
        original_flush = db.flush
        def collision(*args, **kwargs):
            if any(isinstance(item, WeeklyHealthReport) for item in db.new):
                raise IntegrityError("simulated unique constraint collision", {}, Exception("collision"))
            return original_flush(*args, **kwargs)
        monkeypatch.setattr(db, "flush", collision)
        with pytest.raises(HTTPException) as error:
            weekly.generate(db, AUTH, "m_001", model_caller=lambda messages: pytest.fail("No model before claim"))
    assert error.value.status_code == 409 and error.value.detail == {"code": "WEEKLY_REPORT_BUSY"}
    assert stats() == (0, 0, 0)
    assert client.post(URL, headers=OWNER).status_code == 200


def test_provider_failure_on_refresh_keeps_old_audit_and_records_rule_fallback(client, normal_payload, monkeypatch):
    freeze(monkeypatch)
    for index in range(3):
        upload(client, normal_payload, f"provider{index}", WEDNESDAY - timedelta(hours=index + 1))
    first = client.post(URL, headers=OWNER).json()
    upload(client, normal_payload, "provider_new", WEDNESDAY - timedelta(minutes=5))
    monkeypatch.setattr(weekly, "settings", replace(weekly.settings, llm_api_key="fictional-test-key"))
    def fail(messages):
        raise RuntimeError("fictional provider unavailable")
    with SessionLocal() as db:
        second = weekly.generate(db, AUTH, "m_001", model_caller=fail)
        audit = db.scalar(select(AgentAction).where(AgentAction.action_type == "weekly_report_updated"))
        assert audit.result["model_route"]["reason"] == "provider_error"
        assert audit.result["previous_snapshot"]["facts"] == first["facts"]
    assert second["model_version"] == "policy-engine" and "4 次" in second["summary"]
    assert stats() == (1, 2, 1)


def test_slow_older_source_cannot_overwrite_newer_committed_report(client, normal_payload, monkeypatch):
    freeze(monkeypatch)
    original = client.post(URL, headers=OWNER).json()
    for index in range(3):
        upload(client, normal_payload, f"old_source{index}", WEDNESDAY - timedelta(hours=index + 1))
    monkeypatch.setattr(weekly, "settings", replace(weekly.settings, llm_api_key="fictional-test-key"))
    source_captured, newer_finished = Event(), Event()
    real_trend = weekly.member_trend
    calls = []
    def controlled_source(*args, **kwargs):
        result = real_trend(*args, **kwargs)
        if current_thread().name.startswith("older-weekly"):
            source_captured.set()
            assert newer_finished.wait(timeout=8)
        return result
    monkeypatch.setattr(weekly, "member_trend", controlled_source)
    def model(messages):
        calls.append(messages)
        return "继续积累记录，保持原有生活节奏。"
    def older_request():
        with SessionLocal() as db:
            with pytest.raises(HTTPException) as conflict:
                weekly.generate(db, AUTH, "m_001", model_caller=model)
            assert conflict.value.status_code == 409
            assert conflict.value.detail == {"code": "WEEKLY_REPORT_BUSY"}
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="older-weekly") as executor:
        older = executor.submit(older_request)
        assert source_captured.wait(timeout=8)
        upload(client, normal_payload, "newer_source", WEDNESDAY - timedelta(minutes=5))
        try:
            with SessionLocal() as db:
                newer = weekly.generate(db, AUTH, "m_001", model_caller=model)
        finally:
            newer_finished.set()
        older.result(timeout=8)
    assert len(calls) == 1
    with SessionLocal() as db:
        final = db.get(WeeklyHealthReport, original["report_id"])
        assert final.facts == newer["facts"]
        assert final.facts["revision"] == 2 and final.facts["valid_sessions"] == 4
    assert stats() == (1, 2, 1)
