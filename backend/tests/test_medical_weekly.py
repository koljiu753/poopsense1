from copy import deepcopy
from dataclasses import replace
import json

import httpx
import pytest
from sqlalchemy import select

import app.agent as agent
import app.weekly_reports as weekly_reports
from app.database import SessionLocal
from app.models import AgentAction, UserNotification, WeeklyHealthReport
from app.service import AuthContext


AUTH = AuthContext(user_id="u_owner", role="owner", household_id="hh_001")
FALLBACK = "本周有 4 次可靠记录，每周频率约 4.0 次。"
RECOMMENDATIONS = ["保持规律饮水与作息", "如连续异常或不适加重，请咨询医生"]
TREND = {
    "valid_sessions": 4, "valid_sample_coverage": 0.8,
    "frequency_per_week": 4.0, "consecutive_abnormal": 0,
    "insufficient_coverage": False,
    "dimensions": {"shape": {"baseline_status": "insufficient"}},
    "baseline_progress": {"status": "collecting", "current_valid_sessions": 4},
}


@pytest.fixture(autouse=True)
def isolated_weekly_provider(monkeypatch):
    agent.close_model_client()
    test_settings = replace(
        agent.settings, llm_api_key="test-weekly-provider-key",
        llm_base_url="https://api.baichuan-ai.com/v1", llm_model="Baichuan-M3-Plus",
        llm_chat_max_tokens=1536,
    )
    monkeypatch.setattr(agent, "settings", test_settings)
    monkeypatch.setattr(weekly_reports, "settings", test_settings)
    monkeypatch.setattr(weekly_reports, "member_trend", lambda *args: deepcopy(TREND))

    def unexpected_network(*args, **kwargs):
        pytest.fail("Weekly report tests must not make a real network request")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", unexpected_network)
    yield
    agent.close_model_client()


def mock_response(monkeypatch, text, *, finish_reason="stop", status_code=200):
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(status_code, json={"choices": [{
            "finish_reason": finish_reason,
            "message": {"content": text, "reasoning_content": "不得展示的内部推理"},
            "grounding": {"evidence": [{
                "ref_num": 2, "title_zh": "虚构测试资料",
                "url": "https://source.example/weekly",
            }]},
        }]})

    monkeypatch.setattr(agent, "_create_model_client", lambda: httpx.Client(
        transport=httpx.MockTransport(respond),
    ))
    return requests


def assert_saved_summary(report, expected, model_version):
    assert report["summary"] == expected
    assert report["status"] == "ready"
    assert report["recommendations"] == RECOMMENDATIONS
    assert report["model_version"] == model_version
    with SessionLocal() as db:
        assert db.get(WeeklyHealthReport, report["report_id"]).summary == expected
        notification = db.scalar(select(UserNotification).where(
            UserNotification.notification_type == "weekly_report_ready",
        ))
        assert notification.body == expected
        action = db.scalar(select(AgentAction).where(
            AgentAction.action_type == "weekly_report_ready",
        ))
        assert action.model_version == model_version


def test_weekly_default_medical_reply_is_bounded_patient_text_with_safe_sources(client, monkeypatch):
    requests = mock_response(
        monkeypatch,
        "本周有4次可靠记录，每周频率约4.0次。个人基线仍需积累记录。^[2]^",
    )
    with SessionLocal() as db:
        report = weekly_reports.generate(db, AUTH, "m_001")
        again = weekly_reports.generate(db, AUTH, "m_001")
    assert again["report_id"] == report["report_id"]
    assert len(requests) == 1
    payload = requests[0]
    assert payload["max_tokens"] == 1536
    assert payload["metadata"]["output_style"] == "patient"
    assert "thinking" not in payload
    assert all(message["role"] != "system" for message in payload["messages"])
    context = json.loads(payload["messages"][0]["content"].split("\n", 1)[1])
    assert agent.REPORT_EXPLANATION_RULES in context["software_constraints_and_authorized_context"][0]
    weekly_context = json.loads(context["user_input"])
    assert weekly_context["current_session"]["facts"]["frequency_per_week"] == 4.0
    assert weekly_context["current_session"]["recommendations"] == RECOMMENDATIONS
    assert weekly_context["baseline_progress"]["status"] == "collecting"
    summary = report["summary"]
    assert "每周频率约4.0次" in summary
    assert "[2](https://source.example/weekly)" in summary
    assert "**参考来源（模型提供，未逐条核验）**" in summary
    assert "- [2] [虚构测试资料](https://source.example/weekly)" in summary
    assert "内部推理" not in summary
    assert_saved_summary(report, summary, "Baichuan-M3-Plus")


@pytest.mark.parametrize("text,finish_reason,status_code", [
    ("如不适加重，请", "length", 200),
    ("", "stop", 200),
    ("本周完全正常。", "stop", 200),
    ("本周与个人基线一致。", "stop", 200),
    ("建议每天饮水2000毫升。", "stop", 200),
    ("本周记录可参考 ^[trend]^。", "stop", 200),
    ("服务暂不可用", "stop", 503),
])
def test_invalid_weekly_model_reply_preserves_policy_summary_everywhere(
    client, monkeypatch, text, finish_reason, status_code,
):
    requests = mock_response(monkeypatch, text, finish_reason=finish_reason, status_code=status_code)
    with SessionLocal() as db:
        report = weekly_reports.generate(db, AUTH, "m_001")
    assert len(requests) == 1
    assert_saved_summary(report, FALLBACK, "policy-engine")
    assert report["facts"]["valid_sessions"] == 4
    assert "参考来源" not in report["summary"]


def test_weekly_injected_caller_still_uses_same_explanation_guard(client):
    prompts = []

    def contradictory_caller(messages):
        prompts.append(messages)
        return "本周没有异常，已经排除疾病。"

    with SessionLocal() as db:
        report = weekly_reports.generate(db, AUTH, "m_001", model_caller=contradictory_caller)
    assert len(prompts) == 1
    assert_saved_summary(report, FALLBACK, "policy-engine")
