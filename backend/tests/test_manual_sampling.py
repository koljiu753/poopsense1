from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json

import pytest
from sqlalchemy import func, select

from app import agent, service
from app.database import SessionLocal
from app.models import (
    AgentAction, Assessment, DeviceBinding, MemberAssignment, Observation, OutboxEvent, SessionRecord,
)
from app.schemas import DeviceSessionInput
from app.service import AuthContext, hash_secret, ingest, member_trend


DEVICE = {"X-Device-Key": "dev-secret"}
OWNER = {"X-Household-Key": "household-secret"}
VIEWER = {"X-Household-Key": "viewer-secret"}
UPLOAD = "/api/v1/device-sessions"
INBOX = "/api/v1/households/hh_001/claim-inbox"
HISTORY = "/api/v1/households/hh_001/members/m_001/sessions"


@pytest.fixture
def manual_payload(normal_payload):
    now = datetime.now(timezone.utc) - timedelta(minutes=1)
    normal_payload.update(
        session_id="manual_001", correlation_id="cor_manual_001", data_kind="simulated",
        timestamp=now.isoformat(), end_timestamp=(now + timedelta(seconds=10)).isoformat(), duration_s=10,
        presence_state="unknown", collection_state="partial", temperature_c=None, humidity_pct=None,
        member_candidates=[],
        quality={"overall_confidence": 0, "reasons": ["manual_sampling_test"],
                 "session_kind": "manual_sampling", "duration_semantics": "manual_sampling_seconds"},
        observations={
            "shape": {"value": "compact", "confidence": None, "source": "adapter", "model_version": "test-shape"},
            "color": {"value": "red", "confidence": None, "source": "adapter", "model_version": "test-color",
                      "template_similarity": .72, "similarity_scale": "unknown"},
            "odor": {"value": None, "confidence": None, "missing_reason": "sensor_disabled",
                     "source": "adapter", "model_version": "disabled"},
        },
    )
    return normal_payload


def device_path(payload):
    return f"/api/v1/devices/{payload['device_id']}/sessions/{payload['session_id']}"


def household_path(payload):
    return f"/api/v1/households/{payload['household_id']}/sessions/{payload['session_id']}"


def claim(client, payload, member="m_001"):
    return client.post(household_path(payload) + "/claim", headers=OWNER, json={"member_id": member})


@pytest.mark.parametrize("kind", ["simulated", "hardware_test"])
def test_manual_upload_query_claim_and_observations_remain_test_only(client, manual_payload, kind):
    manual_payload["data_kind"] = kind
    received = client.post(UPLOAD, headers=DEVICE, json=manual_payload)
    assert received.status_code == 202, received.text
    assert received.json()["processing"]["analysis_complete"] is True
    assert received.json()["processing"]["llm_status"] == "not_applicable"
    first = client.get(device_path(manual_payload), headers=DEVICE)
    assert first.status_code == 200
    body = first.json()
    assert body["data_kind"] == kind
    assert body["sampling"]["duration_semantics"] == "manual_sampling_seconds"
    assert body["sampling"]["duration_s"] == 10
    assert body["sampling"]["started_at"].endswith("Z")
    assert body["raw_observations"]["shape"]["value"] == "compact"
    assert body["raw_observations"]["color"]["template_similarity"] == .72
    assert body["raw_observations"]["color"]["similarity_scale"] == "unknown"
    assert body["raw_observations"]["odor"]["missing_reason"] == "sensor_disabled"
    assert body["processing"]["assessment_status"] == "unable_to_determine"
    assert body["processing"]["risk_level"] == "not_evaluated"
    assert body["processing"]["reliable"] is False
    assert body["processing"]["analysis_source"] == "rules"
    assert client.get(INBOX, headers=OWNER).json()[0]["raw_observations"] == body["raw_observations"]
    assert claim(client, manual_payload).status_code == 200
    history = client.get(HISTORY, headers=OWNER).json()[0]
    assert history["raw_observations"] == body["raw_observations"]
    assert history["visual_profile"]["reliable"] is False
    assert history["visual_profile"]["shape"] is None
    assert history["processing"]["llm_status"] == "not_applicable"
    assert client.get(device_path(manual_payload), headers=DEVICE).json()["assignment_status"] == "confirmed"
    duplicate = client.post(UPLOAD, headers=DEVICE, json=manual_payload)
    assert duplicate.status_code == 202
    assert duplicate.json()["duplicate"] is True
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SessionRecord)) == 1
        assert db.scalar(select(AgentAction).where(AgentAction.action_type == "redline_notification")) is None


@pytest.mark.parametrize("path,value", [
    (("quality", "unexpected"), True),
    (("quality", "session_kind"), "toileting"),
    (("quality", "duration_semantics"), "toileting_seconds"),
    (("quality", "duration_semantics"), None),
    (("quality", "overall_confidence"), .9),
    (("quality", "reasons"), []),
    (("quality", "reasons"), [" "]),
    (("observations", "color", "accuracy"), .9),
    (("observations", "color", "template_similarity"), "0.72"),
    (("observations", "color", "template_similarity"), True),
    (("observations", "color", "similarity_scale"), "percent"),
    (("observations", "color", "value"), "brown"),
    (("observations", "shape", "value"), "hard"),
    (("observations", "shape", "confidence"), .8),
    (("observations", "shape", "template_similarity"), .8),
    (("observations", "odor", "value"), "mild"),
    (("observations", "odor", "missing_reason"), "unavailable"),
    (("observations", "odor", "change_pct"), 20),
    (("observations", "extra_dimension"), {"value": "extra", "source": "sensor", "model_version": "test"}),
    (("data_kind",), "unknown"),
    (("presence_state",), "absent"),
    (("collection_state",), "completed"),
    (("temperature_c",), 24),
    (("humidity_pct",), 60),
    (("member_candidates",), [{"member_ref": "m_001", "confidence": .8}]),
    (("unsupported",), True),
])
def test_manual_contract_rejects_invalid_nested_fields(client, manual_payload, path, value):
    node = manual_payload
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    response = client.post(UPLOAD, headers=DEVICE, json=manual_payload)
    assert response.status_code == 422, response.text
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SessionRecord)) == 0


@pytest.mark.parametrize("scale,score,accepted", [
    ("0_1", 1, True), ("0_1", 1.01, False), ("0_1", -.1, False),
    ("0_100", 72, True), ("0_100", 100.1, False),
    ("unknown", 172.5, True), ("unknown", -3.2, True),
])
def test_similarity_scale_is_explicit_and_does_not_become_confidence(client, manual_payload, scale, score, accepted):
    manual_payload["observations"]["color"].update(similarity_scale=scale, template_similarity=score)
    response = client.post(UPLOAD, headers=DEVICE, json=manual_payload)
    assert response.status_code == (202 if accepted else 422), response.text
    if accepted:
        observation = client.get(device_path(manual_payload), headers=DEVICE).json()["raw_observations"]["color"]
        assert observation["template_similarity"] == score
        assert observation["similarity_scale"] == scale
        assert observation["confidence"] is None


@pytest.mark.parametrize("score", [float("nan"), float("inf"), float("-inf")])
def test_similarity_nonfinite_values_are_rejected(manual_payload, score):
    manual_payload["observations"]["color"]["template_similarity"] = score
    with pytest.raises(ValueError):
        DeviceSessionInput.model_validate(manual_payload)


@pytest.mark.parametrize("score", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_json_gets_validation_error_not_server_error(client, manual_payload, score):
    manual_payload["observations"]["color"]["template_similarity"] = score
    response = client.post(UPLOAD, headers={**DEVICE, "Content-Type": "application/json"},
                           content=json.dumps(manual_payload))
    assert response.status_code == 422


def test_declared_scale_without_score_is_not_silently_lost(client, manual_payload):
    manual_payload["observations"]["color"].update(template_similarity=None, similarity_scale="0_100")
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    observed = client.get(device_path(manual_payload), headers=DEVICE).json()["raw_observations"]["color"]
    assert observed["template_similarity"] is None
    assert observed["similarity_scale"] == "0_100"


@pytest.mark.parametrize("change", ["score", "scale", "sampling_purpose"])
def test_manual_semantics_are_part_of_idempotency(client, manual_payload, change):
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    changed = deepcopy(manual_payload)
    if change == "score":
        changed["observations"]["color"]["template_similarity"] = .73
    elif change == "scale":
        changed["observations"]["color"]["similarity_scale"] = "0_1"
    else:
        changed["quality"].pop("session_kind")
        changed["quality"].pop("duration_semantics")
        changed["observations"]["color"].pop("template_similarity")
        changed["observations"]["color"].pop("similarity_scale")
    response = client.post(UPLOAD, headers=DEVICE, json=changed)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_manual_session_never_enters_baseline_or_proactive_redline(client, manual_payload, monkeypatch):
    monkeypatch.setattr(service, "settings", replace(service.settings, llm_proactive_enabled=True, llm_routing_enabled=True))
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    assert claim(client, manual_payload).status_code == 200
    with SessionLocal() as db:
        record = db.scalar(select(SessionRecord))
        assessment = db.scalar(select(Assessment))
        # Defend against stale or externally altered assessment flags too.
        assessment.reliable, assessment.risk_level = True, "redline"
        db.commit()
        assert service.queue_redline_actions(db, record, db.scalar(select(MemberAssignment).where(MemberAssignment.active.is_(True)))) == []
        trend = member_trend(db, "hh_001", "m_001", 30)
        assert trend["assigned_sessions"] == trend["valid_sessions"] == 0
        assert trend["baseline_progress"]["current_valid_sessions"] == 0
        assert trend["dimensions"] == {}
        assert not db.scalar(select(OutboxEvent).where(OutboxEvent.topic == "agent.orchestration.requested"))
        reassessed = service.create_assessment_version(db, record)
        db.commit()
        assert reassessed.reliable is False
        assert reassessed.risk_level == "not_evaluated"


def test_explicit_manual_analysis_and_orchestration_use_rules_without_model(client, manual_payload):
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    assert claim(client, manual_payload).status_code == 200

    def forbidden(*args, **kwargs):
        raise AssertionError("Manual sampling must not call a health model")

    with SessionLocal() as db:
        result = agent.analyze_session(db, AuthContext("u_owner", "owner", "hh_001"), "m_001",
                                       manual_payload["session_id"], model_caller=forbidden)
        assert result["report"]["status"] == "insufficient"
        assert result["report"]["recommendations"] == []
        assert result["message"].model_version == "policy-engine"
        record = db.scalar(select(SessionRecord))
        action = agent.orchestrate_session(db, record.id, model_caller=forbidden)
        assert action.action_type == "llm_no_action"
    detail = client.get(device_path(manual_payload), headers=DEVICE).json()
    assert detail["processing"]["llm_status"] == "not_applicable"


def test_device_query_is_bound_to_device_current_household_and_excludes_members(client, manual_payload):
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    assert claim(client, manual_payload).status_code == 200
    body = client.get(device_path(manual_payload), headers=DEVICE).json()
    assert not ({"member_id", "member_candidates", "candidates", "household_id", "member_name"} & body.keys())
    assert "m_001" not in json.dumps(body)
    assert client.get(device_path(manual_payload), headers={"X-Device-Key": "wrong"}).status_code == 401
    with SessionLocal() as db:
        db.add(DeviceBinding(device_id="dev_other", household_id="hh_001", api_key_hash=hash_secret("other-key"), active=True))
        db.commit()
    other_path = device_path(manual_payload).replace("dev_001", "dev_other")
    assert client.get(other_path, headers=DEVICE).status_code == 401
    assert client.get(other_path, headers={"X-Device-Key": "other-key"}).status_code == 404
    with SessionLocal() as db:
        db.get(DeviceBinding, "dev_001").household_id = "hh_rebound"
        db.commit()
    assert client.get(device_path(manual_payload), headers=DEVICE).status_code == 404
    with SessionLocal() as db:
        db.get(DeviceBinding, "dev_001").active = False
        db.commit()
    assert client.get(device_path(manual_payload), headers=DEVICE).status_code == 401


def test_family_lookup_checks_current_member_grant_and_pending_roles(client, manual_payload):
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    url = household_path(manual_payload)
    assert client.get(url, headers=OWNER).json()["member_id"] is None
    assert client.get(url, headers=VIEWER).status_code == 403
    assert claim(client, manual_payload).status_code == 200
    assert client.get(url, headers=VIEWER).status_code == 403
    grant = client.post("/api/v1/households/hh_001/members/m_001/grants", headers=OWNER,
                        json={"viewer_user_id": "u_viewer", "can_view": True, "redline_notifications": False})
    assert grant.status_code == 200
    assert client.get(url, headers=VIEWER).json()["member_id"] == "m_001"
    assert client.delete(f"/api/v1/households/hh_001/grants/{grant.json()['grant_id']}", headers=OWNER).status_code == 200
    assert client.get(url, headers=VIEWER).status_code == 403
    assert client.get(url.replace("hh_001", "hh_other"), headers=OWNER).status_code == 403
    assert client.get(url + "_missing", headers=OWNER).status_code == 404


def test_family_same_id_different_devices_is_ambiguous_not_arbitrarily_claimed(client, manual_payload):
    assert client.post(UPLOAD, headers=DEVICE, json=manual_payload).status_code == 202
    with SessionLocal() as db:
        db.add(DeviceBinding(device_id="dev_other", household_id="hh_001", api_key_hash=hash_secret("other-key"), active=True))
        db.commit()
    other = {**manual_payload, "device_id": "dev_other"}
    assert client.post(UPLOAD, headers={"X-Device-Key": "other-key"}, json=other).status_code == 202
    result = client.get(household_path(manual_payload), headers=OWNER)
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "SESSION_ID_AMBIGUOUS"
    assert claim(client, manual_payload).status_code == 409
    assert client.post(household_path(manual_payload) + "/reassess", headers=OWNER).status_code == 409
    analysis = client.post("/api/v1/households/hh_001/agent/session-analysis", headers=OWNER,
                           json={"member_id": "m_001", "session_id": manual_payload["session_id"]})
    assert analysis.status_code == 409
    assert analysis.json()["detail"]["code"] == "SESSION_ID_AMBIGUOUS"
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Assessment)) == 2
    assert client.get(device_path(manual_payload), headers=DEVICE).status_code == 200


@pytest.mark.parametrize("status,model,expected", [
    ("succeeded", "policy-engine", "policy_only"), ("succeeded", "test-model", "available"),
    ("failed", "test-model", "failed"), ("processing", None, "pending"),
])
def test_rule_completion_does_not_claim_llm_completion(client, normal_payload, status, model, expected):
    assert client.post(UPLOAD, headers=DEVICE, json=normal_payload).status_code == 202
    assert claim(client, normal_payload).status_code == 200
    assert client.get(device_path(normal_payload), headers=DEVICE).json()["processing"]["llm_status"] == "not_requested"
    with SessionLocal() as db:
        record = db.scalar(select(SessionRecord))
        db.add(AgentAction(session_id=record.id, subject_member_id="m_001", action_type="agent_session_analysis",
                           status=status, recipient_id="u_owner", policy_version="test", model_version=model,
                           input_summary={}, result={"private_report": "PRIVATE_REPORT_SENTINEL"},
                           idempotency_key="test-report-status", created_at=datetime.now(timezone.utc)))
        db.commit()
    result = client.get(device_path(normal_payload), headers=DEVICE)
    assert result.json()["processing"]["analysis_complete"] is True
    assert result.json()["processing"]["llm_status"] == expected
    assert "PRIVATE_REPORT_SENTINEL" not in result.text
    assert claim(client, normal_payload, "m_002").status_code == 200
    assert client.get(device_path(normal_payload), headers=DEVICE).json()["processing"]["llm_status"] == "not_requested"


def test_api_proxy_openapi_has_single_upload_route_and_new_contract(client):
    result = client.get("/api/v1/openapi.json")
    assert result.status_code == 200
    body = result.json()
    assert "post" in body["paths"][UPLOAD]
    assert "/api/v1/devices/{device_id}/sessions/{session_id}" in body["paths"]
    schema = body["components"]["schemas"]["ObservationInput"]
    assert schema["additionalProperties"] is False
    assert {"template_similarity", "similarity_scale"} <= schema["properties"].keys()
    assert body["components"]["schemas"]["QualityInput"]["additionalProperties"] is False
