"""The plan, plan-mapping and allowance repositories.

Three things live here because they are one administrative surface in practice: a plan, what it
maps each call role to, and how much of each dimension it allows. Splitting them would mean three
modules that each need the other two to say anything useful.

**The mapping change is the requirement worth naming.** ``specs/model-policy``: changing the
plan-to-policy mapping means "subsequent requests resolve the new policy with no code change and no
redeployment". That is a claim about *data*, and the only thing this module has to do to keep it
true is refuse to cache anything itself — the one snapshot with a TTL lives in `snapshot.py`, and
this module always reads through to the database. Two caches would make the staleness window
unknowable.

**Allowances are refused rather than clamped.** A negative allowance and an unknown dimension are
both writes somebody meant differently, and silently clamping a `-1` to `0` would produce a plan
that refuses every request while looking deliberately configured.

**Two ways onto a tier, and they are not the same write.** ``assign`` is administrative: it runs
under the privileged connection, names a subject, and records the acting principal in
``admin_audit``, because one person changed another person's entitlement. ``choose`` is a person
moving *themselves*, runs under the request session, and names no subject at all — the row it
writes is whichever one ``0015``'s ``WITH CHECK`` allows, which is the caller's own and cannot be
another. Keeping them separate is what stops the administrative path from being reachable by
shaping a request.

Reading a principal's effective plan on the request path stays the resolver's job rather than this
module's, so that "which plan is this person on" has one implementation.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.entitlements import CallRole, PlanCode, PolicyId
from weathra.domain.errors import RecordNotFound, ValidationFailed
from weathra.domain.usage import INTERNAL_SUBJECT, QuotaDimension, QuotaWindow
from weathra.entitlements.audit import record_change
from weathra.entitlements.records import AdminAction, AllowanceRecord, PlanRecord

__all__ = ["ALLOWANCE_SUBJECT_KIND", "PLAN_SUBJECT_KIND", "USER_PLAN_SUBJECT_KIND", "PlanStore"]

PLAN_SUBJECT_KIND = "subscription_plan"
ALLOWANCE_SUBJECT_KIND = "usage_limit"
USER_PLAN_SUBJECT_KIND = "user_plan"

_PLAN_COLUMNS = "plan_code, display_name, rank, policy_by_call_role, external_subscription_ref"


def _plan_from_row(row: Any) -> PlanRecord:
    return PlanRecord(
        plan_code=PlanCode(row[0]),
        display_name=row[1],
        rank=row[2],
        policy_by_call_role={
            CallRole(role): PolicyId(policy) for role, policy in (row[3] or {}).items()
        },
        external_subscription_ref=row[4],
    )


class PlanStore:
    """Plan, mapping and allowance reads, and the administrative writes that change them."""

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ---------------------------------------------------------------- reads

    async def get(self, plan_code: PlanCode | str) -> PlanRecord | None:
        row = (
            await self._session.execute(
                text(f"SELECT {_PLAN_COLUMNS} FROM subscription_plans WHERE plan_code = :code"),
                {"code": str(plan_code)},
            )
        ).one_or_none()
        return None if row is None else _plan_from_row(row)

    async def require(self, plan_code: PlanCode | str) -> PlanRecord:
        plan = await self.get(plan_code)
        if plan is None:
            raise RecordNotFound(
                f"No subscription plan with code {str(plan_code)!r}.",
                details={"plan_code": str(plan_code)},
            )
        return plan

    async def list(self) -> tuple[PlanRecord, ...]:
        """Every plan, in ascending entitlement order — which is what 'above' means elsewhere."""
        rows = await self._session.execute(
            text(f"SELECT {_PLAN_COLUMNS} FROM subscription_plans ORDER BY rank")
        )
        return tuple(_plan_from_row(row) for row in rows)

    async def allowances(
        self, *, plan_code: PlanCode | str | None = None, internal: bool = False
    ) -> tuple[AllowanceRecord, ...]:
        """The allowances for one plan, for the internal subject, or for everything.

        A dimension with no row is *unlimited*, not zero. Nothing here fills a missing dimension in
        with a default, because a default here would be a limit nobody configured.
        """
        rows = await self._session.execute(
            text(
                "SELECT plan_code, internal_subject, dimension, window_kind, allowance "
                "  FROM usage_limits "
                " WHERE (CAST(:plan AS text) IS NULL OR plan_code = CAST(:plan AS text)) "
                "   AND (NOT CAST(:internal AS boolean) OR internal_subject IS NOT NULL) "
                " ORDER BY plan_code NULLS LAST, dimension"
            ),
            {"plan": str(plan_code) if plan_code else None, "internal": internal},
        )
        return tuple(
            AllowanceRecord(
                plan_code=PlanCode(row[0]) if row[0] else None,
                internal_subject=row[1],
                dimension=QuotaDimension(row[2]),
                window_kind=QuotaWindow(row[3]),
                allowance=row[4],
            )
            for row in rows
        )

    # ---------------------------------------------------------------- administration

    async def set_policy_mapping(
        self,
        plan_code: PlanCode | str,
        mapping: Mapping[CallRole, str],
        *,
        acting_principal: str,
    ) -> PlanRecord:
        """Re-point a plan at different policies, per call role.

        Refuses a mapping naming a policy that does not exist, for the same reason the policy store
        refuses a dangling candidate: the alternative is a plan that resolves to nothing, found by
        the first caller on that tier rather than by the administrator who typed it.
        """
        before = await self.require(plan_code)
        if not mapping:
            raise ValidationFailed(
                "A plan's policy mapping must name at least one call role.",
                details={"field": "policy_by_call_role"},
            )

        wanted = [str(policy) for policy in mapping.values()]
        rows = await self._session.execute(
            text(
                "SELECT policy_id FROM model_policies WHERE policy_id = ANY(CAST(:ids AS text[]))"
            ),
            {"ids": wanted},
        )
        known = {row[0] for row in rows}
        missing = sorted({policy for policy in wanted if policy not in known})
        if missing:
            raise ValidationFailed(
                f"These policies do not exist: {missing}. A plan may only map to policies the "
                "policy store actually carries.",
                details={"field": "policy_by_call_role", "missing_policy_ids": missing},
            )

        rendered = {role.value: str(policy) for role, policy in mapping.items()}
        import json

        await self._session.execute(
            text(
                "UPDATE subscription_plans SET policy_by_call_role = CAST(:mapping AS jsonb), "
                "       updated_at = now() WHERE plan_code = :code"
            ),
            {"mapping": json.dumps(rendered), "code": str(plan_code)},
        )
        after = await self.require(plan_code)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.PLAN_MAPPING_EDIT,
            subject_kind=PLAN_SUBJECT_KIND,
            subject_id=str(plan_code),
            before={
                "policy_by_call_role": {
                    r.value: str(p) for r, p in before.policy_by_call_role.items()
                }
            },
            after={"policy_by_call_role": rendered},
        )
        return after

    async def set_allowance(
        self,
        *,
        acting_principal: str,
        dimension: QuotaDimension | str,
        allowance: int,
        plan_code: PlanCode | str | None = None,
        internal: bool = False,
    ) -> AllowanceRecord:
        """Set one allowance, for a plan or for the internal subject.

        Both refusals ``specs/usage-limits`` names are here: a negative value, and a dimension the
        system does not have. The second is checked against the enum rather than against a list in
        this file, so adding a dimension does not mean remembering to update a validator.
        """
        if (plan_code is None) == (not internal):
            raise ValidationFailed(
                "An allowance belongs to a plan or to the internal subject, and to exactly one.",
                details={"field": "plan_code"},
            )
        try:
            resolved = QuotaDimension(str(dimension))
        except ValueError as unknown:
            raise ValidationFailed(
                f"{str(dimension)!r} is not a usage dimension. Known dimensions: "
                f"{sorted(item.value for item in QuotaDimension)}.",
                details={"field": "dimension", "dimension": str(dimension)},
            ) from unknown
        if allowance < 0:
            raise ValidationFailed(
                f"An allowance may not be negative, got {allowance}. Leave a dimension unset to "
                "mean unlimited; zero means nothing is permitted.",
                details={"field": "allowance", "allowance": allowance},
            )

        subject = INTERNAL_SUBJECT if internal else str(plan_code)
        if not internal:
            await self.require(str(plan_code))

        existing = await self._session.scalar(
            text(
                "SELECT allowance FROM usage_limits "
                " WHERE dimension = :dimension "
                "   AND ((CAST(:plan AS text) IS NULL AND internal_subject IS NOT NULL) "
                "        OR plan_code = CAST(:plan AS text))"
            ),
            {"dimension": resolved.value, "plan": None if internal else str(plan_code)},
        )

        await self._session.execute(
            text(
                "INSERT INTO usage_limits (id, plan_code, internal_subject, dimension, "
                "                          window_kind, allowance) "
                "VALUES (gen_random_uuid(), :plan, :internal, :dimension, :window, :allowance) "
                "ON CONFLICT ON CONSTRAINT usage_limits_pkey DO NOTHING"
            )
            if existing is None
            else text(
                "UPDATE usage_limits SET allowance = :allowance, updated_at = now() "
                " WHERE dimension = :dimension "
                "   AND ((CAST(:plan AS text) IS NULL AND internal_subject IS NOT NULL) "
                "        OR plan_code = CAST(:plan AS text))"
            ),
            {
                "plan": None if internal else str(plan_code),
                "internal": INTERNAL_SUBJECT if internal else None,
                "dimension": resolved.value,
                "window": resolved.window.value,
                "allowance": allowance,
            },
        )

        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.ALLOWANCE_SET,
            subject_kind=ALLOWANCE_SUBJECT_KIND,
            subject_id=f"{subject}:{resolved.value}",
            before=None if existing is None else {"allowance": int(existing)},
            after={"allowance": allowance},
        )
        return AllowanceRecord(
            plan_code=None if internal else PlanCode(str(plan_code)),
            internal_subject=INTERNAL_SUBJECT if internal else None,
            dimension=resolved,
            window_kind=resolved.window,
            allowance=allowance,
        )

    async def choose(self, plan_code: PlanCode | str, *, subject: str) -> PlanRecord:
        """Put the acting person on a tier they chose for themselves.

        **The subject is not trusted, and does not need to be.** It is written into the row, but
        `0015`'s policies carry ``WITH CHECK (user_id::text = weathra_current_user_id())`` on both
        ``INSERT`` and ``UPDATE``, and the session this runs under is bound to the validated token.
        So a subject that is not the caller's own does not write somebody else's row — it writes no
        row at all, and Postgres raises. The check is the database's rather than this function's on
        purpose: an ownership rule upheld by a Python argument is upheld by whoever remembers it.

        **The plan is validated against the catalogue first**, so an unknown code is a structured
        ``RecordNotFound`` naming the field rather than a foreign-key violation from three layers
        down. ``subscription_plans`` stays authoritative: this function knows no tier names.

        **Nothing else changes.** Usage counters, recorded events, conversations, saved locations
        and watches are untouched — a tier is what a person is allowed, not what they have already
        done, and `specs/usage-limits` counts consumption per window regardless of plan. The row's
        ``assigned_by`` is the person themselves, which is what distinguishes a self-selection from
        an administrative assignment when either is read back.
        """
        plan = await self.require(plan_code)
        await self._session.execute(
            text(
                "INSERT INTO user_plans (user_id, plan_code, assigned_by, assigned_at) "
                "VALUES (CAST(:user AS uuid), :plan, CAST(:user AS uuid), now()) "
                "ON CONFLICT (user_id) DO UPDATE "
                "   SET plan_code = excluded.plan_code, "
                "       assigned_by = excluded.assigned_by, "
                "       assigned_at = excluded.assigned_at"
            ),
            {"user": subject, "plan": str(plan.plan_code)},
        )
        return plan

    async def assign(
        self, user_id: str, plan_code: PlanCode | str, *, acting_principal: str
    ) -> PlanRecord:
        """Put a person on a tier. Administrative, privileged, and recorded.

        One person changing another person's entitlement, run under the privileged connection:
        `user_plans` grants the request-serving role its own row and no other, so a caller cannot
        assign themselves one however the request is shaped (``specs/model-policy``).

        This is the operator's path — the bootstrap script, and anything else that already holds
        the privileged credential. The administrative *screen* cannot use it, because the container
        serving it is deliberately never given that credential; it calls
        ``assign_on_the_request_path`` below, which makes the same change and records it the same
        way.
        """
        plan = await self.require(plan_code)
        before = await self._session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = CAST(:user AS uuid)"),
            {"user": user_id},
        )
        await self._session.execute(
            text(
                "INSERT INTO user_plans (user_id, plan_code, assigned_by, assigned_at) "
                "VALUES (CAST(:user AS uuid), :plan, CAST(:by AS uuid), now()) "
                "ON CONFLICT (user_id) DO UPDATE "
                "   SET plan_code = excluded.plan_code, "
                "       assigned_by = excluded.assigned_by, "
                "       assigned_at = excluded.assigned_at"
            ),
            {"user": user_id, "plan": str(plan_code), "by": acting_principal},
        )
        await self._record_assignment(
            user_id, plan, acting_principal=acting_principal, before=before
        )
        return plan

    async def assign_on_the_request_path(
        self, user_id: str, plan_code: PlanCode | str, *, acting_principal: str
    ) -> PlanRecord:
        """The same assignment, made from the container that serves the administrative screen.

        **Why it is a second method rather than a flag.** The change is identical and the mechanism
        is not: `assign` above writes ``user_plans`` directly, which only a connection exempt from
        the policies can do for somebody else's row, and this one goes through `0019`'s
        ``weathra_admin_assign_plan`` — a ``SECURITY DEFINER`` function that opens by testing
        ``weathra_is_administrative()`` and refuses anybody else with ``insufficient_privilege``.
        A parameter switching between them would make the security-relevant difference the value of
        an argument somebody passes.

        **What it is not.** It is not a widening of ``user_plans``: `0015`'s self-service policies
        are untouched, so this session — an administrator's own — still cannot write another
        person's row by a statement of its own, and ``choose`` still writes only the caller's. The
        function's reach is one row of one table and the three columns an assignment consists of;
        usage counters and recorded events are not among them, so a tier change never resets what
        somebody has already consumed.

        **The record is the same record.** ``record_change`` writes ``admin_audit`` in this
        transaction through the ``INSERT`` `0017` already grants, so the trail does not learn that
        there are two ways to make this change — which is the point of having one place that writes
        it. The ``before`` state comes back from the function because reading it here would return
        null for anybody but the caller, and an audit row that misreports the previous tier is
        worse than one that omits it.
        """
        plan = await self.require(plan_code)
        before = await self._session.scalar(
            text("SELECT weathra_admin_assign_plan(:user, :plan, :by)"),
            {"user": user_id, "plan": str(plan.plan_code), "by": acting_principal},
        )
        await self._record_assignment(
            user_id, plan, acting_principal=acting_principal, before=before
        )
        return plan

    async def _record_assignment(
        self,
        user_id: str,
        plan: PlanRecord,
        *,
        acting_principal: str,
        before: str | None,
    ) -> None:
        """The audit row both assignment paths write, so neither can drift from the other."""
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.PLAN_ASSIGN,
            subject_kind=USER_PLAN_SUBJECT_KIND,
            subject_id=user_id,
            before=None if before is None else {"plan_code": before},
            after={"plan_code": str(plan.plan_code)},
        )
