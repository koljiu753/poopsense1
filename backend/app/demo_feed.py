"""Read-only discovery of authorized manual demo measurements for one device.

Insertion IDs are stable even when device timestamps are equal or out of order.
Ingest holds the device binding lock before allocating an ID until commit, so
same-device uploads cannot commit out of ID order. This remains a discovery
feed, not an acknowledgement queue: initial reads intentionally show only the
latest sample; old imports or writes bypassing ingest are not covered.
"""
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import select

from .models import DeviceBinding, MemberAssignment, SessionRecord
from .service import authorize_household, authorize_member_view, is_simulated_record, session_evidence_map


def read(db, household_id: str, device_id: str, key: str, *, after_id: int | None = None, limit: int = 20):
    auth = authorize_household(db, household_id, key)
    binding = db.get(DeviceBinding, device_id)
    if not binding or not binding.active or binding.household_id != household_id:
        # Do not reveal whether the requested device belongs to another family.
        raise HTTPException(404, detail={"code": "DEVICE_NOT_FOUND"})
    eligible = select(SessionRecord).where(
        SessionRecord.household_id == household_id,
        SessionRecord.device_id == device_id,
        SessionRecord.data_kind.in_(("simulated", "hardware_test")),
        SessionRecord.quality["session_kind"].as_string() == "manual_sampling",
    )
    if after_id is None:
        rows = db.scalars(eligible.order_by(SessionRecord.id.desc()).limit(1)).all()
        more = False
    else:
        candidates = db.scalars(eligible.where(SessionRecord.id > after_id)
                               .order_by(SessionRecord.id.asc()).limit(limit + 1)).all()
        more, rows = len(candidates) > limit, candidates[:limit]
    cursor = rows[-1].id if rows else (after_id or 0)
    visible = []
    for record in rows:
        assignments = db.scalars(select(MemberAssignment).where(
            MemberAssignment.session_id == record.id, MemberAssignment.active.is_(True)).limit(2)).all()
        if len(assignments) != 1:
            # An incomplete or ambiguous assignment is never guessed.
            continue
        assignment = assignments[0]
        if assignment.assignment_status == "confirmed":
            if not assignment.member_id:
                continue
            try:
                authorize_member_view(db, auth, assignment.member_id)
            except HTTPException as exc:
                if exc.status_code in {403, 404}:
                    continue
                raise
        elif auth.role not in {"owner", "caregiver"}:
            continue
        visible.append((record, assignment))
    evidence = session_evidence_map(db, [record for record, _ in visible])
    return {
        "items": [{
            "cursor_id": record.id, "session_id": record.external_session_id,
            "device_id": record.device_id, "correlation_id": record.correlation_id,
            "data_kind": record.data_kind,
            "received_at": record.received_at.replace(tzinfo=record.received_at.tzinfo or timezone.utc),
            "assignment_status": assignment.assignment_status, "assignment_version": assignment.version,
            "member_id": assignment.member_id, "simulated": is_simulated_record(record),
            **evidence[record.id],
        } for record, assignment in visible],
        "next_after_id": cursor, "has_more": more,
    }
