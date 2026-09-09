"""The model policy repository: which ordered candidate list each named policy declares.

The refusal that carries this module is the dangling reference. ``specs/model-policy``: "A policy
referencing a model absent from the catalog SHALL be refused at write time with a structured error
naming the missing reference."

*At write time* is the whole requirement. The database cannot enforce it — the candidates are an
ordered `text[]`, and PostgreSQL has no foreign key from an array element to another table — so
without this check a typo in a candidate list is accepted silently and discovered on the first
request that walks it, as a model that resolves to nothing. Checking here turns a runtime outage
into a refused administrative write that names the key it could not find.

The order of the candidate list is data, and this module preserves it exactly as given. Resolution
walks it in declared order and takes the first enabled entry, so re-ordering a list is a deliberate
administrative act with an audit row, not an incidental property of how a set happened to iterate.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.entitlements import CallRole, PolicyId
from weathra.domain.errors import RecordNotFound, ValidationFailed
from weathra.entitlements.audit import record_change
from weathra.entitlements.records import AdminAction, PolicyEligibility, PolicyRecord

__all__ = ["POLICY_SUBJECT_KIND", "PolicyStore"]

POLICY_SUBJECT_KIND = "model_policy"

_COLUMNS = (
    "policy_id, display_name, candidate_catalog_keys, applicable_call_roles, "
    "eligibility, fallback_policy_id, failover_enabled"
)


def _record_from_row(row: Any) -> PolicyRecord:
    return PolicyRecord(
        policy_id=PolicyId(row[0]),
        display_name=row[1],
        candidate_catalog_keys=tuple(row[2]),
        applicable_call_roles=tuple(CallRole(role) for role in row[3]),
        eligibility=PolicyEligibility(row[4]),
        fallback_policy_id=PolicyId(row[5]) if row[5] else None,
        failover_enabled=row[6],
    )


def _auditable(record: PolicyRecord) -> dict[str, Any]:
    return {
        "display_name": record.display_name,
        "candidate_catalog_keys": list(record.candidate_catalog_keys),
        "applicable_call_roles": [role.value for role in record.applicable_call_roles],
        "eligibility": record.eligibility.value,
        "fallback_policy_id": str(record.fallback_policy_id) if record.fallback_policy_id else None,
        "failover_enabled": record.failover_enabled,
    }


class PolicyStore:
    """Policy reads for the resolver, and policy administration for the privileged path."""

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ---------------------------------------------------------------- reads

    async def get(self, policy_id: str) -> PolicyRecord | None:
        row = (
            await self._session.execute(
                text(f"SELECT {_COLUMNS} FROM model_policies WHERE policy_id = :id"),
                {"id": str(policy_id)},
            )
        ).one_or_none()
        return None if row is None else _record_from_row(row)

    async def require(self, policy_id: str) -> PolicyRecord:
        record = await self.get(policy_id)
        if record is None:
            raise RecordNotFound(
                f"No model policy named {policy_id!r}.", details={"policy_id": str(policy_id)}
            )
        return record

    async def list(self) -> tuple[PolicyRecord, ...]:
        rows = await self._session.execute(
            text(f"SELECT {_COLUMNS} FROM model_policies ORDER BY policy_id")
        )
        return tuple(_record_from_row(row) for row in rows)

    # ---------------------------------------------------------------- validation

    async def _refuse_dangling_candidates(self, candidates: Sequence[str]) -> None:
        """``specs/model-policy``: a policy naming a catalog entry that does not exist is refused.

        The error names every missing key rather than the first, because an administrator pasting
        a candidate list wants to fix all the typos in one pass.
        """
        if not candidates:
            raise ValidationFailed(
                "A policy must declare at least one candidate; a policy with none can never "
                "resolve a model.",
                details={"field": "candidate_catalog_keys"},
            )
        rows = await self._session.execute(
            text(
                "SELECT catalog_key FROM model_catalog "
                " WHERE catalog_key = ANY(CAST(:keys AS text[]))"
            ),
            {"keys": list(candidates)},
        )
        known = {row[0] for row in rows}
        missing = [key for key in candidates if key not in known]
        if missing:
            raise ValidationFailed(
                f"These candidate catalog keys do not exist: {missing}. A policy may only "
                "reference entries the catalog actually carries.",
                details={"field": "candidate_catalog_keys", "missing_catalog_keys": missing},
            )

        duplicates = [key for key in set(candidates) if list(candidates).count(key) > 1]
        if duplicates:
            raise ValidationFailed(
                f"A candidate appears more than once: {sorted(duplicates)}. The list is an order "
                "of preference, and a repeated entry has no second meaning.",
                details={"field": "candidate_catalog_keys", "duplicated": sorted(duplicates)},
            )

    async def _refuse_unknown_fallback(self, policy_id: str, fallback: str | None) -> None:
        if fallback is None:
            return
        if str(fallback) == str(policy_id):
            raise ValidationFailed(
                "A policy cannot declare itself as its own fallback.",
                details={"field": "fallback_policy_id"},
            )
        if await self.get(fallback) is None:
            raise ValidationFailed(
                f"The declared fallback policy {fallback!r} does not exist.",
                details={"field": "fallback_policy_id", "missing_policy_id": str(fallback)},
            )

    # ---------------------------------------------------------------- administration

    async def create(
        self,
        *,
        acting_principal: str,
        policy_id: str,
        display_name: str,
        candidate_catalog_keys: Sequence[str],
        applicable_call_roles: Sequence[CallRole],
        eligibility: PolicyEligibility,
        fallback_policy_id: str | None = None,
        failover_enabled: bool = True,
    ) -> PolicyRecord:
        identifier = PolicyId(policy_id)
        if await self.get(identifier) is not None:
            raise ValidationFailed(
                f"A policy named {identifier!r} already exists.",
                details={"field": "policy_id", "policy_id": str(identifier)},
            )
        if not applicable_call_roles:
            raise ValidationFailed(
                "A policy must declare at least one call role, or nothing will ever consult it.",
                details={"field": "applicable_call_roles"},
            )
        await self._refuse_dangling_candidates(candidate_catalog_keys)
        await self._refuse_unknown_fallback(identifier, fallback_policy_id)

        await self._session.execute(
            text(
                f"INSERT INTO model_policies ({_COLUMNS}) VALUES ("
                ":policy_id, :display_name, CAST(:candidates AS text[]), "
                "CAST(:roles AS text[]), :eligibility, :fallback, :failover)"
            ),
            {
                "policy_id": str(identifier),
                "display_name": display_name,
                "candidates": list(candidate_catalog_keys),
                "roles": [role.value for role in applicable_call_roles],
                "eligibility": eligibility.value,
                "fallback": str(fallback_policy_id) if fallback_policy_id else None,
                "failover": failover_enabled,
            },
        )
        written = await self.require(identifier)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.POLICY_CREATE,
            subject_kind=POLICY_SUBJECT_KIND,
            subject_id=str(identifier),
            after=_auditable(written),
        )
        return written

    async def set_candidates(
        self,
        policy_id: str,
        candidates: Sequence[str],
        *,
        acting_principal: str,
        cited_comparison_run_ids: tuple[str, ...] = (),
    ) -> PolicyRecord:
        """Re-point a policy's ordered candidate list — a model promotion, in practice.

        ``cited_comparison_run_ids`` is where design.md decision 26's discipline lands: promotion
        is a separate administrative write citing the comparison runs that justified it, so the
        audit row carries the evidence rather than the recollection. Empty is allowed, because a
        promotion for an operational reason — a model withdrawn by its vendor — has no comparison
        to cite and should not have one invented.
        """
        before = await self.require(policy_id)
        await self._refuse_dangling_candidates(candidates)
        if before.is_pinned and len(candidates) != 1:
            raise ValidationFailed(
                f"{policy_id!r} has failover disabled, so it must declare exactly one candidate. "
                "Giving a pinned policy a second candidate would let a run measure two models.",
                details={"field": "candidate_catalog_keys", "policy_id": str(policy_id)},
            )

        await self._session.execute(
            text(
                "UPDATE model_policies SET candidate_catalog_keys = CAST(:candidates AS text[]), "
                "       updated_at = now() WHERE policy_id = :id"
            ),
            {"candidates": list(candidates), "id": str(policy_id)},
        )
        after = await self.require(policy_id)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.POLICY_EDIT,
            subject_kind=POLICY_SUBJECT_KIND,
            subject_id=str(policy_id),
            before=_auditable(before),
            after=_auditable(after),
            cited_comparison_run_ids=cited_comparison_run_ids,
        )
        return after

    async def set_fallback(
        self, policy_id: str, fallback_policy_id: str | None, *, acting_principal: str
    ) -> PolicyRecord:
        """Change or clear a policy's declared fallback."""
        before = await self.require(policy_id)
        await self._refuse_unknown_fallback(policy_id, fallback_policy_id)
        if before.is_pinned and fallback_policy_id is not None:
            raise ValidationFailed(
                f"{policy_id!r} has failover disabled and may declare no fallback: a pinned policy "
                "that falls back is not pinned.",
                details={"field": "fallback_policy_id", "policy_id": str(policy_id)},
            )

        await self._session.execute(
            text(
                "UPDATE model_policies SET fallback_policy_id = :fallback, updated_at = now() "
                " WHERE policy_id = :id"
            ),
            {
                "fallback": str(fallback_policy_id) if fallback_policy_id else None,
                "id": str(policy_id),
            },
        )
        after = await self.require(policy_id)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.POLICY_EDIT,
            subject_kind=POLICY_SUBJECT_KIND,
            subject_id=str(policy_id),
            before=_auditable(before),
            after=_auditable(after),
        )
        return after
