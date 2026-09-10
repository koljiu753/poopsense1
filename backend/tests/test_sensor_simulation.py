from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

import pytest

URL = "/api/v1/households/hh_001/sensor-simulation"
HEADERS = {"X-Household-Key": "household-secret"}


def sample(scenario="dry", member="m_001"):
    return {"request_id": str(uuid4()), "timestamp": datetime.now(timezone.utc).isoformat(),
            "scenario": scenario, "member_id": member}


@pytest.mark.parametrize("scenario", ["normal", "dry", "loose", "uncertain", "redline"])
def test_presets_use_ingestion_and_claim(client, scenario):
    payload = sample(scenario)
    first = client.post(URL, headers=HEADERS, json=payload)
    assert first.status_code == 202, first.text
    assert first.json()["assignment_status"] == "confirmed"
    again = client.post(URL, headers=HEADERS, json=payload)
    assert again.json()["duplicate"] is True
    records = client.get("/api/v1/households/hh_001/members/m_001/sessions", headers=HEADERS).json()
    assert len(records) == 1
    assert records[0]["simulated"] is True
    if scenario == "redline":
        assert records[0]["risk_level"] == "redline"
    if scenario == "uncertain":
        assert records[0]["visual_profile"]["reliable"] is False
    payload["scenario"] = "normal" if scenario != "normal" else "dry"
    assert client.post(URL, headers=HEADERS, json=payload).status_code == 409


def test_pending_does_not_enter_personal_history(client):
    assert client.post(URL, headers=HEADERS, json=sample(member=None)).status_code == 202
    assert client.get("/api/v1/households/hh_001/members/m_001/sessions", headers=HEADERS).json() == []
    assert len(client.get("/api/v1/households/hh_001/claim-inbox", headers=HEADERS).json()) == 1


def test_serverless_temporary_sqlite_does_not_offer_unreliable_simulation(client, monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    assert client.get(URL, headers=HEADERS).json() == {"enabled": False, "reason": "temporary_storage"}
    assert client.post(URL, headers=HEADERS, json=sample()).status_code == 404


def test_simulation_cannot_be_used_in_production_or_by_viewer(client, monkeypatch):
    from app import main
    assert client.post(URL, headers={"X-Household-Key": "viewer-secret"}, json=sample()).status_code == 403
    assert client.post(URL, headers=HEADERS, json={**sample(), "observations": {}}).status_code == 422
    monkeypatch.setattr(main, "settings", replace(main.settings, app_env="production"))
    assert client.get(URL, headers=HEADERS).json()["enabled"] is False
    assert client.post(URL, headers=HEADERS, json=sample()).status_code == 404


@pytest.mark.parametrize("report", [{"status": "insufficient", "reliable": False}, {"status": "urgent", "reliable": True}])
def test_unreliable_or_urgent_report_cannot_mark_previous_plan_improved(monkeypatch, report):
    from app import longitudinal
    def forbidden(*args):
        raise AssertionError("Only reliable non-urgent records can reconcile lifestyle outcomes")
    monkeypatch.setattr(longitudinal, "reconcile_previous_followup", forbidden)
    assert longitudinal.ensure_followup(None, None, "m_001", None, report) is None
