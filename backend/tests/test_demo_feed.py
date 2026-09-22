from copy import deepcopy

import pytest
from sqlalchemy import func, select

from app import demo_explanations
from app.database import SessionLocal
from app.models import (
    Assessment, DemoExplanation, DeviceBinding, FamilyGrant, HouseholdMembership,
    MemberAssignment, Observation, OutboxEvent, SessionRecord,
)
from app.service import hash_secret
from test_manual_sampling import manual_payload, claim, DEVICE, OWNER, VIEWER, UPLOAD


FEED = "/api/v1/households/hh_001/devices/dev_001/demo-sessions"


def upload(client, manual_payload, identifier, **changes):
    payload = deepcopy(manual_payload)
    payload.update(session_id=identifier, correlation_id="cor_" + identifier, **changes)
    response = client.post(UPLOAD, headers=DEVICE, json=payload)
    assert response.status_code == 202, response.text
    return payload


def ids(page):
    return [item["session_id"] for item in page["items"]]


def test_initial_empty_latest_and_next_upload_without_manual_lookup(client, manual_payload):
    empty = client.get(FEED, headers=OWNER).json()
    assert empty == {"items": [], "next_after_id": 0, "has_more": False}
    first = upload(client, manual_payload, "feed_first")
    page = client.get(FEED, headers=OWNER, params={"after_id": 0}).json()
    assert ids(page) == ["feed_first"]
    row = page["items"][0]
    assert row["cursor_id"] == page["next_after_id"]
    assert row["assignment_status"] == "pending_claim" and row["member_id"] is None
    assert row["raw_observations"]["color"]["value"] == "red"
    assert row["sampling"]["session_kind"] == "manual_sampling"
    assert row["processing"]["llm_status"] == "not_applicable"
    assert row["processing"]["reliable"] is False
    upload(client, manual_payload, "feed_latest", data_kind="hardware_test")
    latest = client.get(FEED, headers=OWNER).json()
    assert ids(latest) == ["feed_latest"] and not latest["has_more"]
    assert latest["items"][0]["data_kind"] == "hardware_test"
    assert ids(client.get(FEED, headers=OWNER, params={"after_id": page["next_after_id"]}).json()) == ["feed_latest"]
    duplicate = client.post(UPLOAD, headers=DEVICE, json=first)
    assert duplicate.json()["duplicate"] is True
    assert client.get(FEED, headers=OWNER, params={"after_id": latest["next_after_id"]}).json() == {
        "items": [], "next_after_id": latest["next_after_id"], "has_more": False}


def test_equal_device_and_received_timestamps_do_not_lose_paged_records(client, manual_payload):
    for number in range(5):
        upload(client, manual_payload, f"same_time_{number}")
    with SessionLocal() as db:
        rows = db.scalars(select(SessionRecord)).all()
        for row in rows:
            row.received_at = rows[0].received_at
        db.commit()
    cursor, found = 0, []
    for expected_more in (True, True, False):
        page = client.get(FEED, headers=OWNER, params={"after_id": cursor, "limit": 2}).json()
        assert page["has_more"] is expected_more
        assert page["next_after_id"] > cursor
        cursor = page["next_after_id"]
        found += ids(page)
    assert found == [f"same_time_{number}" for number in range(5)]


def test_feed_excludes_other_device_standard_and_unclassified_legacy_records(client, manual_payload):
    upload(client, manual_payload, "wanted")
    upload(client, manual_payload, "legacy")
    standard = deepcopy(manual_payload)
    standard["quality"] = {"overall_confidence": 0, "reasons": []}
    standard["observations"]["color"].pop("template_similarity")
    standard["observations"]["color"].pop("similarity_scale")
    upload(client, standard, "standard")
    with SessionLocal() as db:
        db.add(DeviceBinding(device_id="dev_other", household_id="hh_001", active=True, api_key_hash=hash_secret("dev-secret")))
        db.scalar(select(SessionRecord).where(SessionRecord.external_session_id == "legacy")).data_kind = "unknown"
        db.commit()
    upload(client, manual_payload, "other_device", device_id="dev_other")
    assert ids(client.get(FEED, headers=OWNER, params={"after_id": 0}).json()) == ["wanted"]


@pytest.mark.parametrize("headers,code", [({}, 422), (DEVICE, 422),
                                         ({"X-Household-Key": "dev-secret"}, 401),
                                         ({"X-Household-Key": "wrong"}, 401)])
def test_feed_requires_household_credential(client, headers, code):
    assert client.get(FEED, headers=headers).status_code == code


@pytest.mark.parametrize("change", ["inactive", "moved", "missing"])
def test_current_device_binding_required_even_with_old_cursor(client, manual_payload, change):
    upload(client, manual_payload, "was_visible")
    with SessionLocal() as db:
        binding = db.get(DeviceBinding, "dev_001")
        if change == "inactive":
            binding.active = False
        elif change == "moved":
            binding.household_id = "another-household"
        else:
            db.delete(binding)
        db.commit()
    response = client.get(FEED, headers=OWNER, params={"after_id": 0})
    assert response.status_code == 404 and response.json()["detail"]["code"] == "DEVICE_NOT_FOUND"
    assert client.get(FEED.replace("hh_001", "another-household"), headers=OWNER).status_code == 403


def test_skipped_private_records_advance_cursor_and_grant_revocation_is_effective(client, manual_payload):
    first = upload(client, manual_payload, "private_1")
    second = upload(client, manual_payload, "private_2")
    third = upload(client, manual_payload, "visible_3")
    for payload in (first, second, third):
        assert claim(client, payload, "m_001" if payload == third else "m_002").status_code == 200
    grant = client.post("/api/v1/households/hh_001/members/m_001/grants", headers=OWNER,
                        json={"viewer_user_id": "u_viewer", "can_view": True})
    assert grant.status_code == 200
    page = client.get(FEED, headers=VIEWER, params={"after_id": 0, "limit": 2}).json()
    assert page["items"] == [] and page["next_after_id"] > 0 and page["has_more"]
    last = client.get(FEED, headers=VIEWER, params={"after_id": page["next_after_id"], "limit": 2}).json()
    assert ids(last) == ["visible_3"] and last["items"][0]["member_id"] == "m_001"
    with SessionLocal() as db:
        for row in db.scalars(select(FamilyGrant)):
            row.active = False
        db.commit()
    revoked = client.get(FEED, headers=VIEWER, params={"after_id": page["next_after_id"]}).json()
    assert revoked["items"] == [] and revoked["next_after_id"] == last["next_after_id"]


def test_caregiver_only_sees_unclaimed_without_member_grant(client, manual_payload):
    first = upload(client, manual_payload, "claimed")
    assert claim(client, first).status_code == 200
    upload(client, manual_payload, "unclaimed")
    with SessionLocal() as db:
        membership = db.scalar(select(HouseholdMembership).where(HouseholdMembership.user_id == "u_viewer"))
        membership.role = "caregiver"
        db.commit()
    page = client.get(FEED, headers=VIEWER, params={"after_id": 0}).json()
    assert ids(page) == ["unclaimed"] and page["items"][0]["member_id"] is None
    with SessionLocal() as db:
        membership = db.scalar(select(HouseholdMembership).where(HouseholdMembership.user_id == "u_viewer"))
        membership.role = "viewer"
        db.commit()
    latest = client.get(FEED, headers=VIEWER).json()
    assert latest["items"] == [] and latest["next_after_id"] == page["next_after_id"]


def test_feed_is_read_only_and_does_not_generate_or_claim(client, manual_payload, monkeypatch):
    upload(client, manual_payload, "readonly")
    monkeypatch.setattr(demo_explanations, "generate", lambda *_: pytest.fail("feed must not generate"))
    tables = (SessionRecord, Observation, Assessment, MemberAssignment, OutboxEvent, DemoExplanation)
    def counts():
        with SessionLocal() as db:
            return [db.scalar(select(func.count()).select_from(table)) for table in tables]
    before = counts()
    for _ in range(3):
        assert client.get(FEED, headers=OWNER).status_code == 200
    assert counts() == before
    with SessionLocal() as db:
        assert db.scalar(select(MemberAssignment)).assignment_status == "pending_claim"


@pytest.mark.parametrize("params", [{"after_id": -1}, {"after_id": "invalid"},
                                    {"after_id": 2**63}, {"limit": 0}, {"limit": 101}])
def test_cursor_and_limit_validation(client, params):
    assert client.get(FEED, headers=OWNER, params=params).status_code == 422


def test_exact_device_feed_does_not_weaken_ambiguous_session_explanation(client, manual_payload):
    upload(client, manual_payload, "same_id")
    with SessionLocal() as db:
        db.add(DeviceBinding(device_id="dev_other", household_id="hh_001", active=True, api_key_hash=hash_secret("dev-secret")))
        db.commit()
    upload(client, manual_payload, "same_id", device_id="dev_other")
    result = client.get(FEED, headers=OWNER).json()
    assert len(result["items"]) == 1 and result["items"][0]["device_id"] == "dev_001"
    response = client.get("/api/v1/households/hh_001/sessions/same_id/demo-explanation", headers=OWNER)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "SESSION_ID_AMBIGUOUS"
