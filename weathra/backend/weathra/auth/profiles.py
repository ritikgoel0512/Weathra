"""The application profile, created on first authenticated use.

Weathra stores no credential and no contact data: the email lives in Supabase Auth and arrives on
each request inside the validated token. The profile row exists only so user-owned records have a
parent to hang from and so "when did this person first use Weathra" has an answer.

Creation is idempotent by construction. ``INSERT ... ON CONFLICT DO NOTHING`` rather than
check-then-insert, because two concurrent first requests from the same newly verified user are the
normal case — the frontend loads a screen and the screen fires two queries — and a check-then-insert
would lose that race and surface a unique-violation to one of them
(``specs/authentication``: "concurrent first requests ... exactly one profile exists").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.db.models import Profile
from weathra.domain.identity import Principal

__all__ = ["ProfileRecord", "ensure_profile", "load_profile", "touch_profile"]


@dataclass(frozen=True, slots=True)
class ProfileRecord:
    """A profile as a caller sees it. Carries no credential and no contact data."""

    user_id: str
    created_at: datetime
    last_seen_at: datetime
    created_now: bool = False


async def ensure_profile(session: AsyncSession, principal: Principal) -> ProfileRecord:
    """Return the acting user's profile, creating it on first authenticated use.

    Safe to call on every authenticated request: the insert is a no-op once the row exists.
    """
    statement = (
        pg_insert(Profile)
        .values(user_id=principal.user_id)
        .on_conflict_do_nothing(index_elements=[Profile.user_id])
        .returning(Profile.created_at, Profile.last_seen_at)
    )
    inserted = (await session.execute(statement)).one_or_none()

    if inserted is not None:
        created_at, last_seen_at = inserted
        return ProfileRecord(
            user_id=principal.user_id,
            created_at=created_at,
            last_seen_at=last_seen_at,
            created_now=True,
        )

    # The row already existed — either from an earlier request or from the other half of a
    # concurrent first pair. Either way, read it back.
    existing = await load_profile(session, principal)
    if existing is None:  # pragma: no cover - only reachable if the row vanished mid-transaction
        raise RuntimeError(
            f"The profile for {principal.user_id} neither inserted nor exists. This should be "
            "impossible inside one transaction."
        )
    return existing


async def load_profile(session: AsyncSession, principal: Principal) -> ProfileRecord | None:
    """The acting user's profile, or ``None`` when they have none yet.

    Scoped to the principal: the query cannot name another user's profile, and Row Level Security
    would return nothing if it did.
    """
    statement = select(Profile.created_at, Profile.last_seen_at).where(
        Profile.user_id == principal.user_id
    )
    row = (await session.execute(statement)).one_or_none()
    if row is None:
        return None
    created_at, last_seen_at = row
    return ProfileRecord(
        user_id=principal.user_id, created_at=created_at, last_seen_at=last_seen_at
    )


async def touch_profile(session: AsyncSession, principal: Principal) -> None:
    """Record that the acting user was seen. A last-seen timestamp, not an activity log.

    Deliberately the only behavioural thing Weathra writes about a person without being asked:
    ``specs/memory`` forbids inferring and persisting preferences from usage, and a browsing trail
    is exactly what the shared, location-keyed snapshot table exists to avoid.
    """
    await session.execute(
        update(Profile).where(Profile.user_id == principal.user_id).values(last_seen_at=func.now())
    )
