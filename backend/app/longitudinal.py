import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Assessment, HealthActionFollowup, HouseholdMember, MemberAssignment, Observation, SessionRecord,
)
from .service import AuthContext, authorize_member_view


NORMAL_SHAPES = {"normal", "elongated"}


def _member_records(household_id: str, member_id: str):
    return (select(SessionRecord)
            .join(MemberAssignment, MemberAssignment.session_id == SessionRecord.id)
            .where(SessionRecord.household_id == household_id,
                   MemberAssignment.active.is_(True),
                   MemberAssignment.assignment_status == "confirmed",
                   MemberAssignment.member_id == member_id))


def _source_is_current(db: Session, item: HealthActionFollowup) -> bool:
    return db.scalar(_member_records(item.household_id, item.subject_member_id)
                     .where(SessionRecord.id == item.source_session_id)) is not None


def _current_comparison(db: Session, item: HealthActionFollowup):
    """Derive from current ownership, not arrival order or a cached chat result."""
    source = db.scalar(_member_records(item.household_id, item.subject_member_id)
                       .where(SessionRecord.id == item.source_session_id))
    if source is None:
        return "pending", None, None
    source_assessment = db.scalar(select(Assessment).where(
        Assessment.session_id == source.id, Assessment.active.is_(True)))
    if not source_assessment or not source_assessment.reliable or source_assessment.risk_level == "redline":
        return "insufficient", None, "原记录已无法用于可靠对照，请查看更新后的结果。"
    following = db.scalar(_member_records(item.household_id, item.subject_member_id)
                         .join(Assessment, Assessment.session_id == SessionRecord.id)
                         .where(SessionRecord.occurred_at > source.occurred_at,
                                Assessment.active.is_(True), Assessment.reliable.is_(True))
                         .order_by(SessionRecord.occurred_at, SessionRecord.id))
    if following is None:
        return "pending", None, None
    assessment = db.scalar(select(Assessment).where(
        Assessment.session_id == following.id, Assessment.active.is_(True)))
    if assessment.risk_level == "redline":
        return "insufficient", following.id, "下一次记录有需要关注的信号，请先查看该次提醒，不将它作为改善结论。"
    outcome, note = _observed_change(_shape_for_session(db, source.id),
                                     _shape_for_session(db, following.id))
    return outcome, following.id, note


def _shape_for_session(db: Session, session_id: int) -> str | None:
    return db.scalar(select(Observation.value).where(
        Observation.session_id == session_id,
        Observation.dimension == "shape",
    ))


def _observed_change(previous: str | None, current: str | None) -> tuple[str, str]:
    if not previous or not current:
        return "insufficient", "前后记录缺少可靠形态信息，暂时无法比较。"
    if previous == current:
        outcome, message = "same", "下一次可靠记录与这次形态相近。"
    elif previous not in NORMAL_SHAPES and current in NORMAL_SHAPES:
        outcome, message = "improved", "下一次可靠记录已回到常见范围。"
    elif previous in NORMAL_SHAPES and current not in NORMAL_SHAPES:
        outcome, message = "worse", "下一次可靠记录偏离了原来的常见范围。"
    else:
        outcome, message = "changed", "下一次可靠记录出现了不同变化，建议继续观察。"
    return outcome, f"{message} 这只表示时间先后的变化，不证明由建议导致。"


def reconcile_previous_followup(db: Session, household_id: str, member_id: str,
                                current_record: SessionRecord) -> None:
    """Attach the first later reliable observation to the latest unresolved plan."""
    previous = db.scalar(
        select(HealthActionFollowup)
        .join(SessionRecord, SessionRecord.id == HealthActionFollowup.source_session_id)
        .where(
            HealthActionFollowup.household_id == household_id,
            HealthActionFollowup.subject_member_id == member_id,
            HealthActionFollowup.observed_outcome == "pending",
            SessionRecord.occurred_at < current_record.occurred_at,
        )
        .order_by(SessionRecord.occurred_at.desc())
    )
    if not previous:
        return
    outcome, observed_id, note = _current_comparison(db, previous)
    previous.observed_outcome = outcome
    previous.observed_from_session_id = observed_id
    previous.observed_outcome_note = note
    previous.updated_at = datetime.now(timezone.utc)


def ensure_followup(db: Session, auth: AuthContext, member_id: str,
                    record: SessionRecord, report: dict[str, Any]) -> HealthActionFollowup | None:
    if report.get("status") != "ready" or not report.get("reliable"):
        return None
    reconcile_previous_followup(db, auth.household_id, member_id, record)
    existing = db.scalar(select(HealthActionFollowup).where(
        HealthActionFollowup.household_id == auth.household_id,
        HealthActionFollowup.subject_member_id == member_id,
        HealthActionFollowup.source_session_id == record.id,
    ))
    if existing:
        return existing
    now = datetime.now(timezone.utc)
    followup = HealthActionFollowup(
        id=f"followup_{uuid.uuid4().hex}", household_id=auth.household_id,
        subject_member_id=member_id, source_session_id=record.id,
        recommendation_categories=[item["category"] for item in report["recommendations"]],
        adoption_status="suggested", perceived_outcome="pending",
        observed_outcome="pending", observed_from_session_id=None,
        observed_outcome_note=None, note=None, created_by_user_id=auth.user_id,
        updated_by_user_id=None, created_at=now, updated_at=now, completed_at=None,
    )
    db.add(followup)
    db.flush()
    return followup


def _external_session_id(db: Session, session_id: int | None) -> str | None:
    if session_id is None:
        return None
    record = db.get(SessionRecord, session_id)
    return record.external_session_id if record else None


def render_followup(db: Session, item: HealthActionFollowup) -> dict[str, Any]:
    outcome, observed_id, note = _current_comparison(db, item)
    return {
        "followup_id": item.id,
        "member_id": item.subject_member_id,
        "source_session_id": _external_session_id(db, item.source_session_id),
        "recommendation_categories": item.recommendation_categories,
        "adoption_status": item.adoption_status,
        "perceived_outcome": item.perceived_outcome,
        "observed_outcome": outcome,
        "observed_from_session_id": _external_session_id(db, observed_id),
        "observed_outcome_note": note,
        "note": item.note,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def list_followups(db: Session, auth: AuthContext, member_id: str) -> list[dict[str, Any]]:
    authorize_member_view(db, auth, member_id)
    rows = db.scalars(select(HealthActionFollowup)
        .join(MemberAssignment, MemberAssignment.session_id == HealthActionFollowup.source_session_id).where(
        MemberAssignment.active.is_(True),
        MemberAssignment.assignment_status == "confirmed",
        MemberAssignment.member_id == member_id,
        HealthActionFollowup.household_id == auth.household_id,
        HealthActionFollowup.subject_member_id == member_id,
    ).order_by(HealthActionFollowup.created_at.desc()).limit(20)).all()
    return [render_followup(db, item) for item in rows]


def update_followup(db: Session, auth: AuthContext, member_id: str, followup_id: str,
                    adoption_status: str | None, perceived_outcome: str | None,
                    note: str | None) -> dict[str, Any]:
    member = db.get(HouseholdMember, member_id)
    if not member or member.household_id != auth.household_id:
        raise HTTPException(status_code=404, detail={"code": "MEMBER_NOT_FOUND"})
    if auth.role != "owner" and member.linked_user_id != auth.user_id:
        raise HTTPException(status_code=403, detail={"code": "FOLLOWUP_EDIT_NOT_ALLOWED"})
    item = db.get(HealthActionFollowup, followup_id)
    if (not item or item.household_id != auth.household_id or item.subject_member_id != member_id
            or not _source_is_current(db, item)):
        raise HTTPException(status_code=404, detail={"code": "FOLLOWUP_NOT_FOUND"})
    now = datetime.now(timezone.utc)
    if adoption_status is not None:
        item.adoption_status = adoption_status
        item.completed_at = now if adoption_status in {"completed", "skipped"} else None
    if perceived_outcome is not None:
        item.perceived_outcome = perceived_outcome
    if note is not None:
        item.note = note.strip() or None
    item.updated_by_user_id = auth.user_id
    item.updated_at = now
    db.commit()
    db.refresh(item)
    return render_followup(db, item)
