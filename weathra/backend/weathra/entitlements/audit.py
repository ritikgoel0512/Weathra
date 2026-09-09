"""One place that writes `admin_audit`, so no administrative write can forget to.

``specs/model-catalog``, ``specs/model-policy`` and ``specs/usage-limits`` each require the same
thing of their administrative surface: the change takes effect, and the acting principal and the
time are recorded. Three requirements, one mechanism — because three mechanisms would be three
chances for the fourth administrative write somebody adds to record nothing.

The audit row is written in the *same transaction* as the change it describes. That is the property
worth stating: a change that committed with no audit row, or an audit row for a change that rolled
back, would each be worse than no audit at all, because both look like a complete record.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.entitlements.records import AdminAction, AuditEntry

__all__ = ["record_change", "recorded_changes"]

_INSERT = text(
    """
    INSERT INTO admin_audit (
        id, acting_principal, action, subject_kind, subject_id,
        before, after, cited_comparison_run_ids, created_at
    ) VALUES (
        CAST(:id AS uuid), CAST(:acting AS uuid), :action, :subject_kind, :subject_id,
        CAST(:before AS jsonb), CAST(:after AS jsonb), CAST(:cited AS text[]),
        -- clock_timestamp() and not the column's now() default: now() is *transaction* start
        -- time, so two changes made in one transaction would share a timestamp and the audit
        -- trail would have no order. An audit row's time should be when the change happened.
        clock_timestamp()
    )
    """
)


async def record_change(
    session: AsyncSession,
    *,
    acting_principal: str,
    action: AdminAction,
    subject_kind: str,
    subject_id: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    cited_comparison_run_ids: tuple[str, ...] = (),
) -> None:
    """Record one administrative change on the session that made it.

    The table refuses a row with neither a before nor an after, which is deliberate: a change that
    can describe neither side of itself is a note, and a note in an audit log is worse than a gap
    because it reads as a record.
    """
    import json

    await session.execute(
        _INSERT,
        {
            "id": str(uuid.uuid4()),
            "acting": acting_principal,
            "action": action.value,
            "subject_kind": subject_kind,
            "subject_id": subject_id,
            "before": json.dumps(before) if before is not None else None,
            "after": json.dumps(after) if after is not None else None,
            "cited": list(cited_comparison_run_ids),
        },
    )


async def recorded_changes(
    session: AsyncSession, *, subject_kind: str | None = None, subject_id: str | None = None
) -> tuple[AuditEntry, ...]:
    """The audit trail, newest first, optionally narrowed to one record.

    A read rather than a convenience for tests: ``specs/model-policy`` requires the change to be
    *recorded*, and something has to be able to read it back for that to mean anything.
    """
    rows = await session.execute(
        text(
            "SELECT acting_principal, action, subject_kind, subject_id, before, after, "
            "       cited_comparison_run_ids, created_at "
            "  FROM admin_audit "
            " WHERE (CAST(:subject_kind AS text) IS NULL "
            "        OR subject_kind = CAST(:subject_kind AS text)) "
            "   AND (CAST(:subject_id AS text) IS NULL "
            "        OR subject_id = CAST(:subject_id AS text)) "
            " ORDER BY created_at DESC, subject_id"
        ),
        {"subject_kind": subject_kind, "subject_id": subject_id},
    )
    return tuple(
        AuditEntry(
            acting_principal=str(row[0]),
            action=AdminAction(row[1]),
            subject_kind=row[2],
            subject_id=row[3],
            before=row[4],
            after=row[5],
            cited_comparison_run_ids=tuple(row[6] or ()),
            created_at=row[7],
        )
        for row in rows
    )
