import hashlib
import json
import uuid
from copy import deepcopy
from datetime import datetime, time, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from .agent import REPORT_EXPLANATION_RULES, call_chat_model, policy_route, reply_route, validate_report_explanation
from .config import settings
from .memory import authorize_memory_edit
from .models import AgentAction, UserNotification, WeeklyHealthReport
from .service import AuthContext, POLICY_VERSION, authorize_member_view, member_trend


REPORT_SCHEMA_VERSION = 2
REPORT_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


def _view(row: WeeklyHealthReport) -> dict:
    return {"report_id": row.id, "member_id": row.subject_member_id,
            "period_start": row.period_start, "period_end": row.period_end,
            "status": row.status, "facts": row.facts, "summary": row.summary,
            "recommendations": row.recommendations, "policy_version": row.policy_version,
            "model_version": row.model_version,
            "created_at": row.created_at.replace(tzinfo=row.created_at.tzinfo or timezone.utc)}


def list_reports(db: Session, auth: AuthContext, member_id: str) -> list[dict]:
    authorize_member_view(db, auth, member_id)
    rows = db.scalars(select(WeeklyHealthReport).where(
        WeeklyHealthReport.household_id == auth.household_id,
        WeeklyHealthReport.subject_member_id == member_id,
    ).order_by(WeeklyHealthReport.period_start.desc()).limit(12)).all()
    return [_view(row) for row in rows]


def _find_report(db: Session, auth: AuthContext, member_id: str, start):
    return db.scalar(select(WeeklyHealthReport).where(
        WeeklyHealthReport.household_id == auth.household_id,
        WeeklyHealthReport.subject_member_id == member_id,
        WeeklyHealthReport.period_start == start,
    ).execution_options(populate_existing=True))


def _same_snapshot(row, fingerprint):
    return bool(row and row.facts.get("schema_version") == REPORT_SCHEMA_VERSION
                and row.facts.get("source_fingerprint") == fingerprint
                and row.status in {"ready", "insufficient"}
                and not row.facts.get("_refreshing"))


def _winner_or_busy(db: Session, auth: AuthContext, member_id: str, start, fingerprint):
    db.rollback()
    winner = _find_report(db, auth, member_id, start)
    if _same_snapshot(winner, fingerprint):
        return _view(winner)
    raise HTTPException(status_code=409, detail={"code": "WEEKLY_REPORT_BUSY"})


def _render(trend: dict, facts: dict, model_caller) -> tuple:
    insufficient = trend["insufficient_coverage"] or trend["valid_sessions"] < 3
    route = policy_route("weekly_summary", "rule_report")
    model_version = "policy-engine"
    if insufficient:
        summary = "本周可靠样本不足，暂不做趋势判断。继续积累记录后再回看。"
        recommendations = ["保持自然记录，不必为凑数据改变生活习惯"]
    else:
        recommendations = ["保持规律饮水与作息", "如连续异常或不适加重，请咨询医生"]
        summary = f"本周已覆盖 {facts['reliable_days']} 天，共 {trend['valid_sessions']} 次可靠记录。"
        if settings.llm_api_key or settings.llm_routing_enabled:
            try:
                # Keep audit metadata out of the model's business context.
                business_facts = {name: facts[name] for name in (
                    "valid_sessions", "assigned_sessions", "reliable_days", "coverage",
                    "frequency_per_week", "consecutive_abnormal", "dimensions",
                )}
                messages = [
                    {"role": "system", "content": (
                        "只解释给定周报事实和已有建议，不诊断、不新增事实，80字内中文。"
                        "统计窗口是北京时间本周一至数据截止时刻，不推算完整周频率。"
                        "reliable_days表示有可靠记录的天数；coverage是可靠记录占比，不是天数。"
                        "current_session表示本次规则周报。记录次数是观察事实，不是建议次数。"
                        "没有记录不代表没有排便。安全提醒优先于篇幅限制。"
                        + REPORT_EXPLANATION_RULES
                    )},
                    {"role": "user", "content": json.dumps({
                        "current_session": {"facts": business_facts, "recommendations": recommendations},
                        "baseline_progress": trend.get("baseline_progress", {}),
                    }, ensure_ascii=False)},
                ]
                explanation = call_chat_model(messages, task="weekly_summary") if model_caller is call_chat_model else model_caller(messages)
                validate_report_explanation(explanation, {
                    "recommendations": [*recommendations, summary],
                }, trend)
                summary = explanation
                route = reply_route(explanation, "weekly_summary")
                model_version = route["model"]
            except Exception as exc:
                guarded = isinstance(exc, HTTPException) and exc.detail == {"code": "MODEL_REPORT_CONTRADICTION"}
                route = policy_route("weekly_summary", "output_guard" if guarded else "provider_error")
    return "insufficient" if insufficient else "ready", summary, recommendations, model_version, route


def generate(db: Session, auth: AuthContext, member_id: str, model_caller=call_chat_model) -> dict:
    authorize_memory_edit(db, auth, member_id)
    cutoff = datetime.now(timezone.utc)
    today = cutoff.astimezone(REPORT_TIMEZONE).date()
    start = today - timedelta(days=today.weekday())
    start_utc = datetime.combine(start, time.min, tzinfo=REPORT_TIMEZONE).astimezone(timezone.utc)
    end_utc = start_utc + timedelta(days=7)
    existing = _find_report(db, auth, member_id, start)
    trend = member_trend(
        db, auth.household_id, member_id, 7, period_start=start_utc,
        period_end=end_utc, as_of=cutoff, calendar_timezone=REPORT_TIMEZONE,
    )
    fingerprint = hashlib.sha256(json.dumps({
        "source": trend.get("source_fingerprint", trend),
        "period_start": start.isoformat(), "timezone": "Asia/Shanghai",
        "schema_version": REPORT_SCHEMA_VERSION, "policy_version": POLICY_VERSION,
    }, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if _same_snapshot(existing, fingerprint):
        return _view(existing)

    previous = deepcopy(_view(existing)) if existing else None
    revision = (int(existing.facts.get("revision", 0)) if existing else 0) + 1
    facts = {
        "schema_version": REPORT_SCHEMA_VERSION, "timezone": "Asia/Shanghai",
        "data_as_of": cutoff.isoformat(), "source_fingerprint": fingerprint,
        "revision": revision, "reliable_days": trend.get("reliable_days", 0),
        "assigned_sessions": trend.get("assigned_sessions", trend["valid_sessions"]),
        "valid_sessions": trend["valid_sessions"], "coverage": trend["valid_sample_coverage"],
        "frequency_per_week": trend["frequency_per_week"],
        "consecutive_abnormal": trend["consecutive_abnormal"], "dimensions": trend["dimensions"],
    }
    try:
        if existing:
            # Claim the database write BEFORE any expensive model call. Scalar
            # JSON predicates work on SQLite and PostgreSQL. The original version
            # prevents a slower request from overwriting a newer snapshot.
            old = existing.facts
            conditions = [WeeklyHealthReport.id == existing.id]
            for key, typed in (("schema_version", "integer"), ("revision", "integer"),
                               ("source_fingerprint", "string")):
                column = WeeklyHealthReport.facts[key]
                column = column.as_integer() if typed == "integer" else column.as_string()
                conditions.append(column == old[key] if old.get(key) is not None else column.is_(None))
            claimed = db.execute(update(WeeklyHealthReport).where(*conditions).values(
                facts={**old, "revision": revision, "_refreshing": True},
            ).execution_options(synchronize_session=False))
            if claimed.rowcount != 1:
                return _winner_or_busy(db, auth, member_id, start, fingerprint)
            db.refresh(existing)
            row = existing
        else:
            row = WeeklyHealthReport(
                id=f"weekly_{uuid.uuid4().hex}", household_id=auth.household_id,
                subject_member_id=member_id, period_start=start, period_end=start + timedelta(days=6),
                status="generating", facts={**facts, "_refreshing": True}, summary="",
                recommendations=[], policy_version=POLICY_VERSION, model_version="policy-engine",
                created_by_user_id=auth.user_id, created_at=cutoff,
            )
            db.add(row)
            # The existing period unique constraint serializes first generation.
            # This placeholder is never committed as a completed report.
            db.flush()
        status, summary, recommendations, model_version, route = _render(trend, facts, model_caller)
        generated_at = datetime.now(timezone.utc)
        facts["generated_at"] = generated_at.isoformat()
        row.period_end = start + timedelta(days=6)
        row.status, row.summary, row.recommendations = status, summary, recommendations
        row.facts, row.policy_version, row.model_version = facts, POLICY_VERSION, model_version
        snapshot = json.loads(json.dumps(_view(row), default=str, ensure_ascii=False))
        result = {"report_id": row.id, "model_route": route, "snapshot": snapshot}
        if previous:
            result["previous_snapshot"] = json.loads(json.dumps(previous, default=str, ensure_ascii=False))
        action = AgentAction(
            session_id=None, subject_member_id=member_id, grant_id=None,
            action_type="weekly_report_updated" if previous else "weekly_report_ready",
            status="succeeded", recipient_id=auth.user_id,
            authorization_basis="authorized_weekly_report_generation", policy_version=POLICY_VERSION,
            model_version=model_version, input_summary={
                "period_start": start.isoformat(), "revision": revision,
                "source_fingerprint": fingerprint, "data_as_of": cutoff.isoformat(),
            }, result=result,
            idempotency_key=(f"weekly-report-refresh:{row.id}:{revision}" if previous else
                             f"weekly-report:{auth.household_id}:{member_id}:{start}"),
            created_at=generated_at, processed_at=generated_at,
        )
        db.add(action)
        db.flush()
        if not previous:
            db.add(UserNotification(
                household_id=auth.household_id, recipient_user_id=auth.user_id,
                subject_member_id=member_id, agent_action_id=action.id,
                notification_type="weekly_report_ready", title="本周健康周报已生成",
                body=summary, priority="normal", status="unread",
                authorization_basis="authorized_weekly_report_generation",
                payload={"report_id": row.id}, created_at=generated_at, read_at=None, acknowledged_at=None,
            ))
        db.commit()
        return _view(row)
    except IntegrityError:
        return _winner_or_busy(db, auth, member_id, start, fingerprint)
    except OperationalError as exc:
        db.rollback()
        sqlstate = getattr(exc.orig, "sqlstate", None)
        if "locked" in str(exc.orig).lower() or sqlstate in {"40001", "40P01", "55P03"}:
            raise HTTPException(status_code=409, detail={"code": "WEEKLY_REPORT_BUSY"}) from exc
        raise
    except Exception:
        db.rollback()
        raise
