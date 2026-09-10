from app.config import Settings
from app.agent import safety_decision, session_policy


def test_robot_integration_is_disabled_by_default():
    assert Settings().legacy_robot_enabled is False


def test_robot_endpoints_cannot_contact_hardware(client, monkeypatch):
    from app import main

    def forbidden(*args, **kwargs):
        raise AssertionError("Sensor product must not contact robot hardware")

    for method in ("controller_status", "capture_pose", "start_pickup", "start_delivery", "runtime_status", "confirm_handover", "stop"):
        monkeypatch.setattr(main.robot_service, method, forbidden)
    base = "/api/v1/households/hh_001/robot/"
    for method, path in (
        ("GET", "status"), ("POST", "trajectories/deliver-water/poses/home"),
        ("POST", "tasks/pickup-water"), ("POST", "tasks/deliver-water"),
        ("GET", "tasks/old-task"), ("POST", "tasks/old-task/confirm-handover"),
        ("POST", "tasks/stop"),
    ):
        response = client.request(method, base + path, headers={"X-Household-Key": "household-secret"})
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "ROBOT_FEATURE_DISABLED"
        assert response.headers["cache-control"] == "no-store"


def test_hydration_advice_does_not_offer_robot_actions():
    assert safety_decision("我想补水")[1] == ["explain", "ask_follow_up"]
    actions = session_policy({"status": "ready", "recommendations": [
        {"category": "hydration", "guidance": "分次补充水分"},
    ]})[1]
    assert actions == ["explain", "summarize_findings", "provide_lifestyle_plan"]
