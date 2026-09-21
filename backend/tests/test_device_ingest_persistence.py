"""Compatibility and database-backed race recovery for device test uploads."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import IntegrityError

from app import main
from app.database import SessionLocal
from app.models import (
    Assessment, DeviceBinding, HouseholdMember, MemberAssignment, Observation,
    OutboxEvent, SessionRecord,
)
from app.schemas import DeviceSessionInput
from app.service import canonical_hash, ingest


DEVICE_HEADERS = {"X-Device-Key": "dev-secret"}
OWNER_HEADERS = {"X-Household-Key": "household-secret"}
UPLOAD = "/api/v1/device-sessions"
INBOX = "/api/v1/households/hh_001/claim-inbox"
HISTORY = "/api/v1/households/hh_001/members/m_001/sessions"


def legacy_hash(payload):
    # The old schema has exactly these fields, with all original defaults kept.
    data = payload.model_dump(mode="json", exclude={"data_kind"})
    data["quality"].pop("session_kind", None)
    data["quality"].pop("duration_semantics", None)
    for item in data["observations"].values():
        item.pop("template_similarity", None)
        item.pop("similarity_scale", None)
    raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def assert_one_aggregate():
    with SessionLocal() as db:
        for model, count in (
            (SessionRecord, 1), (Observation, 3), (MemberAssignment, 1),
            (Assessment, 1), (OutboxEvent, 1),
        ):
            assert db.scalar(select(func.count()).select_from(model)) == count


@pytest.mark.parametrize("kind", [None, "unknown", "simulated", "hardware_test"])
def test_data_kind_survives_receipt_inbox_and_member_history(client, normal_payload, kind):
    if kind is not None:
        normal_payload["data_kind"] = kind
    expected = kind or "unknown"
    first = client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload)
    assert first.status_code == 202, first.text
    assert first.json()["data_kind"] == expected
    again = client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload)
    assert again.json()["duplicate"] is True
    assert again.json()["data_kind"] == expected
    assert client.get(INBOX, headers=OWNER_HEADERS).json()[0]["data_kind"] == expected
    assert client.get(HISTORY, headers=OWNER_HEADERS).json() == []
    assert client.post(
        "/api/v1/households/hh_001/sessions/ses_001/claim",
        headers=OWNER_HEADERS, json={"member_id": "m_001"},
    ).status_code == 200
    record = client.get(HISTORY, headers=OWNER_HEADERS).json()[0]
    assert record["data_kind"] == expected
    assert record["simulated"] is (kind == "simulated")
    # Classification conveys provenance, not per-dimension measurement validity.
    assert record["visual_profile"]["reliable"] is True
    assert client.get(HISTORY, headers={"X-Household-Key": "viewer-secret"}).status_code == 403


@pytest.mark.parametrize("kind", [None, "real", "clinical", ""])
def test_invalid_data_kind_is_not_silently_accepted(client, normal_payload, kind):
    normal_payload["data_kind"] = kind
    assert client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload).status_code == 422


def test_legacy_digest_and_explicit_unknown_retry_stay_compatible(client, normal_payload):
    payload = DeviceSessionInput.model_validate(normal_payload)
    digest = legacy_hash(payload)
    assert canonical_hash(payload) == digest
    assert client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload).status_code == 202
    # Simulate an existing row whose hash was produced before data_kind existed.
    with SessionLocal() as db:
        record = db.scalar(select(SessionRecord))
        record.payload_hash = digest
        db.commit()
    normal_payload["data_kind"] = "unknown"
    again = client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload)
    assert again.status_code == 202
    assert again.json()["duplicate"] is True
    with SessionLocal() as db:
        assert db.scalar(select(SessionRecord)).payload_hash == digest
    for kind in ("simulated", "hardware_test"):
        normal_payload["data_kind"] = kind
        assert canonical_hash(DeviceSessionInput.model_validate(normal_payload)) != digest
        response = client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert_one_aggregate()


def test_explicit_kind_change_conflicts_and_overrides_legacy_display_heuristic(client, normal_payload):
    normal_payload.update(session_id="demo_device_uploaded", data_kind="hardware_test")
    assert client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload).status_code == 202
    normal_payload["data_kind"] = "simulated"
    assert client.post(UPLOAD, headers=DEVICE_HEADERS, json=normal_payload).status_code == 409
    assert client.post(
        "/api/v1/households/hh_001/sessions/demo_device_uploaded/claim",
        headers=OWNER_HEADERS, json={"member_id": "m_001"},
    ).status_code == 200
    result = client.get(HISTORY, headers=OWNER_HEADERS).json()[0]
    assert result["data_kind"] == "hardware_test"
    assert result["simulated"] is False


def install_competing_insert(monkeypatch, losing_db, winning_payload, after_commit=None):
    """Commit a second session between the initial lookup and losing INSERT.

    This deterministically exercises a real SQLite unique violation and rollback;
    threaded PostgreSQL concurrency is a separate deployment verification.
    """
    original_flush = losing_db.flush
    committed = False

    def flush(objects=None):
        nonlocal committed
        if not committed and any(isinstance(row, SessionRecord) for row in losing_db.new):
            committed = True
            with SessionLocal() as winner:
                result = ingest(winner, winning_payload, "dev-secret")
                assert result[3] is False
                if after_commit:
                    after_commit(winner)
        return original_flush(objects)

    monkeypatch.setattr(losing_db, "flush", flush)


def test_competing_identical_insert_returns_committed_receipt(client, normal_payload, monkeypatch):
    payload = DeviceSessionInput.model_validate({**normal_payload, "data_kind": "hardware_test"})
    with SessionLocal() as db:
        install_competing_insert(monkeypatch, db, payload)
        record, assignment, assessment, duplicate = ingest(db, payload, "dev-secret")
        assert duplicate is True
        assert record.data_kind == "hardware_test"
        assert assignment.session_id == assessment.session_id == record.id
        assert assignment.assignment_status == "pending_claim"
        assert assessment.active is True
        # The rolled-back session can still perform normal reads.
        assert db.scalar(select(func.count()).select_from(SessionRecord)) == 1
    assert_one_aggregate()


@pytest.mark.parametrize("change", ["observation", "data_kind"])
def test_competing_different_packet_conflicts(client, normal_payload, monkeypatch, change):
    winner_data = {**normal_payload, "data_kind": "hardware_test"}
    loser_data = deepcopy(winner_data)
    if change == "observation":
        loser_data["observations"]["shape"]["value"] = "hard"
    else:
        loser_data["data_kind"] = "simulated"
    with SessionLocal() as db:
        install_competing_insert(monkeypatch, db, DeviceSessionInput.model_validate(winner_data))
        with pytest.raises(HTTPException) as error:
            ingest(db, DeviceSessionInput.model_validate(loser_data), "dev-secret")
        assert error.value.status_code == 409
        assert error.value.detail == {"code": "IDEMPOTENCY_CONFLICT"}
    assert_one_aggregate()


def test_race_rechecks_device_authorization_after_rollback(client, normal_payload, monkeypatch):
    payload = DeviceSessionInput.model_validate(normal_payload)

    def revoke(winner):
        winner.get(DeviceBinding, payload.device_id).active = False
        winner.commit()

    with SessionLocal() as db:
        install_competing_insert(monkeypatch, db, payload, after_commit=revoke)
        with pytest.raises(HTTPException) as error:
            ingest(db, payload, "dev-secret")
        assert error.value.status_code == 401
    assert_one_aggregate()


def test_initial_constraint_failure_without_winner_is_not_swallowed(client, normal_payload, monkeypatch):
    failure = IntegrityError("INSERT", {}, ValueError("unrelated constraint"))
    with SessionLocal() as db:
        original_flush = db.flush

        def flush(objects=None):
            if any(isinstance(row, SessionRecord) for row in db.new):
                raise failure
            return original_flush(objects)

        monkeypatch.setattr(db, "flush", flush)
        with pytest.raises(IntegrityError) as error:
            ingest(db, DeviceSessionInput.model_validate(normal_payload), "dev-secret")
        assert error.value is failure
        assert db.scalar(select(func.count()).select_from(SessionRecord)) == 0


def test_later_fact_failure_rolls_back_entire_upload(client, normal_payload, monkeypatch):
    failure = IntegrityError("INSERT observations", {}, ValueError("fact constraint"))
    with SessionLocal() as db:
        original_flush = db.flush

        def flush(objects=None):
            if any(isinstance(row, Observation) for row in db.new):
                raise failure
            return original_flush(objects)

        monkeypatch.setattr(db, "flush", flush)
        with pytest.raises(IntegrityError) as error:
            ingest(db, DeviceSessionInput.model_validate(normal_payload), "dev-secret")
        assert error.value is failure
    with SessionLocal() as db:
        for model in (SessionRecord, Observation, MemberAssignment, Assessment, OutboxEvent):
            assert db.scalar(select(func.count()).select_from(model)) == 0


def test_startup_preserves_member_names_and_classifies_new_seed_records(client, monkeypatch):
    with SessionLocal() as db:
        db.get(HouseholdMember, "m_001").display_name = "自定义测试成员"
        db.commit()
    monkeypatch.setattr(main, "settings", replace(main.settings, bootstrap_demo_data=True))
    with TestClient(main.app):
        with SessionLocal() as db:
            assert db.get(HouseholdMember, "m_001").display_name == "自定义测试成员"
            records = db.scalars(select(SessionRecord)).all()
            assert len(records) == 5
            assert {record.data_kind for record in records} == {"simulated"}
            ids = {record.id for record in records}
    with TestClient(main.app):
        with SessionLocal() as db:
            assert {record.id for record in db.scalars(select(SessionRecord))} == ids


def test_data_kind_migration_preserves_old_hash_and_defaults(tmp_path):
    migration_path = Path(__file__).resolve().parents[1] / "migrations/versions/b92f17c03a64_session_data_kind.py"
    spec = importlib.util.spec_from_file_location("session_data_kind_migration", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine(f"sqlite:///{tmp_path / 'migration.db'}")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE sessions (id INTEGER PRIMARY KEY, payload_hash VARCHAR(64) NOT NULL)"))
            connection.execute(text("INSERT INTO sessions (id, payload_hash) VALUES (1, 'legacy-digest')"))
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            assert connection.execute(text("SELECT payload_hash, data_kind FROM sessions WHERE id=1")).one() == ("legacy-digest", "unknown")
            connection.execute(text("INSERT INTO sessions (id, payload_hash) VALUES (2, 'new-digest')"))
            assert connection.execute(text("SELECT data_kind FROM sessions WHERE id=2")).scalar_one() == "unknown"
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            assert connection.execute(text("SELECT COUNT(*) FROM sessions")).scalar_one() == 2
    finally:
        engine.dispose()
