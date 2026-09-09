"""Which Weathra roles a subject holds, read from backend state and from nothing else.

``specs/authentication`` states the rule twice, in two directions, and both halves matter:

* the role is *held as backend state keyed by the validated token subject*, and
* *a body field, query parameter, header, cookie, or unverified token claim asserting the role
  SHALL be ignored*.

So the authority is a row in ``admin_roles``. Nothing here reads a request, and nothing here reads
a claim other than ``sub`` — which is the subject the token was validated for, not an assertion
about what that subject may do.

**What changed, and why it is not a rewrite for its own sake.** Groups 28 to 30 read the role from
the validated token's ``app_metadata``. That is server-controlled at Supabase and was the honest
stand-in while Weathra held no role state; ``entitlements/administration.py`` said so and named
this group as the one that would move it. The move is the security property: a claim travels with
the caller, so an identity-provider misconfiguration, a project's metadata copied between
environments, or a token minted by a compromised project all promote somebody. A row promotes
nobody, because Weathra wrote it.

**Reading is cheap and scoped; writing is privileged.** The request role is granted ``SELECT`` on
``admin_roles`` under an owner-only policy (``0011``), so this predicate answers on the request
path without reaching for the privileged connection — and a caller asking about anyone else gets
nothing back, because the policy returns nothing. Granting and revoking are privileged writes and
are recorded in ``admin_audit`` like every other administrative change.

**Holding the role grants no access to anybody's data.** There is no method here that widens what a
principal owns, and the administrative surface reads operational tables and aggregates. That is
``specs/authentication``'s "administrative role grants no access to user data", and it is true by
construction: an administrative principal's own session is still an ordinary owner-scoped session.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Final, TypedDict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.errors import NotFound, ValidationFailed
from weathra.domain.identity import Principal
from weathra.entitlements.audit import record_change
from weathra.entitlements.records import AdminAction

__all__ = [
    "ADMINISTRATOR_ROLE",
    "GRANTABLE_ROLES",
    "ROLE_SUBJECT_KIND",
    "RoleGrant",
    "RoleStore",
    "is_administrative",
]

logger = logging.getLogger("weathra.auth.roles")

# The one role this change defines. `specs/authentication` speaks of an "administrative/internal
# role"; internal *accounting* is derived from holding this one (design.md decision 25), rather
# than being a second grant somebody has to remember to keep in step with the first.
ADMINISTRATOR_ROLE: Final = "administrator"

# What a grant may name. An allowlist rather than free text, because a typo in a role name is a
# grant that silently does nothing and reads, in the audit trail, exactly like one that worked.
GRANTABLE_ROLES: Final[frozenset[str]] = frozenset({ADMINISTRATOR_ROLE})

# The audit vocabulary's noun for this table, alongside `model_catalog`, `subscription_plan` and
# the rest.
ROLE_SUBJECT_KIND: Final = "admin_role"


class _GrantRow(TypedDict):
    """One grant as `admin_audit` records it. Four fields, none of them a credential."""

    subject_id: str
    role: str
    granted_by: str | None
    granted_at: str


class RoleGrant:
    """One role a subject holds, and where it came from."""

    __slots__ = ("granted_at", "granted_by", "role", "user_id")

    def __init__(
        self, user_id: str, role: str, granted_by: str | None, granted_at: datetime
    ) -> None:
        self.user_id = user_id
        self.role = role
        self.granted_by = granted_by
        self.granted_at = granted_at

    def __repr__(self) -> str:
        return f"RoleGrant(user_id={self.user_id!r}, role={self.role!r})"


async def is_administrative(session: AsyncSession, principal: Principal | None) -> bool:
    """Whether *principal* holds the administrative role, according to Weathra's own state.

    ``None`` is not an administrator, which is worth stating rather than leaving to the truthiness
    of a missing object: an unauthenticated call is the one case where a permissive default would
    be catastrophic and would look like an oversight rather than a decision.

    Safe on the request session. The owner policy means the query can only ever see the acting
    principal's own row, so the predicate cannot be turned into a way of enumerating who else is
    an administrator — whatever the query says.
    """
    if principal is None:
        return False
    return await RoleStore(session).holds(principal.user_id, ADMINISTRATOR_ROLE)


class RoleStore:
    """Reads and writes ``admin_roles``. Reads run anywhere; writes are privileged."""

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ---------------------------------------------------------------- reads

    async def holds(self, user_id: str, role: str) -> bool:
        """Whether one subject holds one role.

        ``EXISTS`` rather than a count, because the answer is a boolean and a count invites a
        caller to believe two grants of the same role are distinguishable. They are not: the
        primary key is ``(subject_id, role)``.
        """
        found = await self._session.scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM admin_roles "
                " WHERE subject_id = CAST(:user AS uuid) AND role = :role)"
            ),
            {"user": user_id, "role": role},
        )
        return bool(found)

    async def roles_for(self, user_id: str) -> frozenset[str]:
        """Every role one subject holds. Empty for a subject with none, which is most of them."""
        rows = await self._session.execute(
            text(
                "SELECT role FROM admin_roles WHERE subject_id = CAST(:user AS uuid) ORDER BY role"
            ),
            {"user": user_id},
        )
        return frozenset(str(row[0]) for row in rows)

    async def holders(self, role: str = ADMINISTRATOR_ROLE) -> tuple[RoleGrant, ...]:
        """Everyone holding *role*. Privileged: the owner policy returns nothing to a request
        session asking about anyone but itself, which is the point of the policy."""
        rows = await self._session.execute(
            text(
                "SELECT subject_id, role, granted_by, granted_at FROM admin_roles "
                " WHERE role = :role ORDER BY granted_at, subject_id"
            ),
            {"role": role},
        )
        return tuple(
            RoleGrant(str(r[0]), str(r[1]), str(r[2]) if r[2] else None, r[3]) for r in rows
        )

    # ---------------------------------------------------------------- writes

    async def grant(
        self, user_id: str, role: str = ADMINISTRATOR_ROLE, *, acting_principal: str | None
    ) -> RoleGrant:
        """Give a subject a role. Privileged, validated, recorded, and idempotent.

        *acting_principal* is ``None`` only for the bootstrap grant made by the operator script:
        there is no administrator to attribute the first one to, and naming a fiction in an audit
        row would be worse than recording the absence. Every other grant names its granter.

        Re-granting is not an error and not a second row — the primary key is the pair — but it
        *is* audited, because "somebody re-asserted this grant on this date" is a fact an auditor
        may want and losing it would cost nothing to nobody except them.
        """
        self._refuse_unknown_role(role)
        before = await self._grant_row(user_id, role)

        await self._session.execute(
            text(
                "INSERT INTO admin_roles (subject_id, role, granted_by, granted_at) "
                "VALUES (CAST(:user AS uuid), :role, CAST(:by AS uuid), now()) "
                "ON CONFLICT (subject_id, role) DO UPDATE "
                "   SET granted_by = excluded.granted_by, granted_at = excluded.granted_at"
            ),
            {"user": user_id, "role": role, "by": acting_principal},
        )
        after = await self._grant_row(user_id, role)
        assert after is not None  # the insert above either wrote it or updated it

        await record_change(
            self._session,
            acting_principal=acting_principal or user_id,
            action=AdminAction.ROLE_GRANT,
            subject_kind=ROLE_SUBJECT_KIND,
            subject_id=f"{user_id}:{role}",
            before=dict(before) if before else None,
            after=dict(after),
        )
        logger.info("role %s granted to %s", role, user_id)
        return RoleGrant(
            user_id, role, acting_principal, datetime.fromisoformat(after["granted_at"])
        )

    async def revoke(
        self, user_id: str, role: str = ADMINISTRATOR_ROLE, *, acting_principal: str
    ) -> None:
        """Take a role away. Privileged, recorded, and refused when there is nothing to take.

        Refused rather than silently succeeding, because "revoke this administrator" answering
        *fine* for a subject who never held the role is how a typo in a user id reads as a
        completed action.
        """
        self._refuse_unknown_role(role)
        before = await self._grant_row(user_id, role)
        if before is None:
            raise NotFound(
                f"That subject does not hold the {role!r} role.",
                details={"role": role},
            )

        await self._session.execute(
            text("DELETE FROM admin_roles WHERE subject_id = CAST(:user AS uuid) AND role = :role"),
            {"user": user_id, "role": role},
        )
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.ROLE_REVOKE,
            subject_kind=ROLE_SUBJECT_KIND,
            subject_id=f"{user_id}:{role}",
            before=dict(before),
            after=None,
        )
        logger.info("role %s revoked from %s", role, user_id)

    # ---------------------------------------------------------------- internals

    @staticmethod
    def _refuse_unknown_role(role: str) -> None:
        if role not in GRANTABLE_ROLES:
            raise ValidationFailed(
                f"{role!r} is not a role this system grants.",
                details={"field": "role", "known": sorted(GRANTABLE_ROLES)},
            )

    async def _grant_row(self, user_id: str, role: str) -> _GrantRow | None:
        """The auditable shape of one grant, or ``None`` where there is none.

        Four fields, none of them a credential: who, what, who granted it, when. There is nothing
        else in the row to leak.
        """
        found = (
            await self._session.execute(
                text(
                    "SELECT subject_id, role, granted_by, granted_at FROM admin_roles "
                    " WHERE subject_id = CAST(:user AS uuid) AND role = :role"
                ),
                {"user": user_id, "role": role},
            )
        ).first()
        if found is None:
            return None
        return _GrantRow(
            subject_id=str(found[0]),
            role=str(found[1]),
            granted_by=str(found[2]) if found[2] else None,
            granted_at=found[3].isoformat(),
        )
