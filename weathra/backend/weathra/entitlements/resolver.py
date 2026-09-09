"""The one place a model is chosen (design.md decision 22, `specs/model-policy`).

Everything above this module asks for a *call role* and gets a client; everything below it stores
data. No supervisor, node, or route picks a model, and the way that is kept true is structural
rather than conventional: `agents/nodes/` may not import this package at all, the read API returns
catalog *keys*, and the vendor-identifier confinement scan fails on a model name in application
logic.

**The order of the walk is the security argument**, so it is written out here in the order it runs:

1. **Principal to plan.** From `user_plans`, keyed by the validated auth subject, defaulting to
   Free where there is no row. Nothing in the request contributes. A `None` principal is Free and
   can never be anything else.
2. **Plan and role to policy**, from `subscription_plans`. `admin_experimental` is reachable only
   when the principal holds the administrative role, and the check is on the *policy's eligibility*
   rather than on the plan, so no plan row can grant it even if one names it.
3. **Policy to the first available candidate**, walking the declared order and taking the first
   entry present in the catalog, enabled, and fit for the role. Every skip is appended to `reason`.
4. **Nothing available, so the fallback chain**: the policy's declared fallback, then the plan's
   default policy, then `LLM_MODEL` validated against the catalog. Never a stronger policy's model
   — falling *up* would turn an outage into a free upgrade.
5. **Still nothing** raises `NoEligibleModel`, a configuration error. No answer is produced from an
   unentitled model and no figure is invented.

An administrative override is checked against the catalog **before any of this** and refused
outright if absent or disabled. It is a shortcut through steps 2 to 4, never past step 1's identity
and never past the allowlist.

**`reason` is not decoration.** It is what makes "why did this caller get that model" answerable
from the evidence record without re-running a resolution against catalog state that has since moved
on, and it is what the resolution tests assert against.

**The resolver never opens a connection.** It is handed the session the request is already using —
the restricted one, with Row Level Security in force — so a resolution reads `user_plans` under the
same policies as everything else. There is no privileged path through here, and the group 26 scan
that proves it covers this package.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.domain.entitlements import (
    CONFIGURED_FALLBACK_POLICY,
    EVALUATION_FIXED_POLICY,
    FREE_DEFAULT_POLICY,
    CallRole,
    PlanCode,
    Resolution,
)
from weathra.domain.errors import ModelNotAllowlisted, NoEligibleModel, PolicyUnavailable
from weathra.domain.identity import Principal
from weathra.entitlements.administration import is_administrative
from weathra.entitlements.records import CatalogEntry, PolicyEligibility, PolicyRecord
from weathra.entitlements.snapshot import (
    EntitlementSnapshot,
    SnapshotSource,
    validate_override_against_database,
)

__all__ = ["ModelPolicyResolver", "PolicyResolver", "ResolvedCall"]

logger = logging.getLogger("weathra.entitlements.resolver")

# The plan a principal has when nothing says otherwise, and the only plan a principal with no
# validated token can ever have.
DEFAULT_PLAN = PlanCode.FREE


@dataclass(frozen=True, slots=True)
class ResolvedCall:
    """What the resolver decided, plus what failover is allowed to try next.

    ``resolution`` is the record — it goes into the evidence record and, later, the usage event.
    ``remaining`` is operational: the *same policy's* still-eligible candidates after the selected
    one, in declared order, which is the only set the infrastructure failover loop may walk.

    Keeping them in one object is what makes "never escalate above the caller's entitlement" a
    property of the data rather than a rule the failover loop has to remember: the loop is handed
    the candidates it may use and has no way to ask for others.
    """

    resolution: Resolution
    remaining: tuple[CatalogEntry, ...] = ()
    failover_enabled: bool = True
    plan: PlanCode | None = None
    """The plan in effect for the call.

    Alongside the resolution rather than inside it: design.md decision 22 fixes `Resolution`'s
    shape, and the plan is what the *caller* was on rather than part of what was resolved. The
    evidence record wants both.
    """
    fell_back: bool = False
    """Whether the selected model came from a fallback rung rather than the mapped policy."""

    @property
    def may_fail_over(self) -> bool:
        return self.failover_enabled and bool(self.remaining)


class ModelPolicyResolver(Protocol):
    """The contract the graph depends on. One method, so nothing above can reach further."""

    async def resolve(
        self,
        *,
        principal: Principal | None,
        role: CallRole,
        session: AsyncSession,
        override: str | None = None,
    ) -> ResolvedCall:
        """Decide which model serves one call, and say why."""
        ...


class PolicyResolver:
    """The concrete resolver. Stateless apart from the snapshot cache it reads through."""

    __slots__ = ("_settings", "_snapshots")

    def __init__(self, settings: Settings, snapshots: SnapshotSource) -> None:
        self._settings = settings
        self._snapshots = snapshots

    # ---------------------------------------------------------------- the walk

    async def resolve(
        self,
        *,
        principal: Principal | None,
        role: CallRole,
        session: AsyncSession,
        override: str | None = None,
    ) -> ResolvedCall:
        if self._settings.llm_single_model_mode:
            return self._configured_fallback(
                role, reason="single-model development mode: LLM_MODEL serves every call"
            )

        administrative = is_administrative(principal)

        # An override is checked against the database before anything else, so an administrator
        # never acts on a snapshot up to one TTL old. A non-administrative caller's override is
        # dropped here and the request continues — refusing it would disclose which models exist
        # above the caller's tier (`specs/model-policy`).
        if override and administrative:
            return await self._administrative_override(override, role, principal, session)
        if override:
            logger.info("ignoring a model override from a non-administrative principal")

        try:
            snapshot = await self._snapshots.current(session)
        except Exception:
            # The store is unreachable. `specs/model-policy` wants the configured model to serve
            # the call and the record to say resolution was unavailable — not an outage, and not a
            # silent pretence that a policy was consulted.
            logger.warning("policy store unavailable; falling back to the configured model")
            return self._configured_fallback(
                role, reason="policy store unavailable: resolution could not be performed"
            )

        plan = await self._plan_for(principal, session, snapshot)
        trail = [f"plan={plan.value}"]
        if principal is None:
            trail.append("no principal: only free_default is reachable")

        policy = self._policy_for(plan, role, snapshot, administrative, trail)
        if policy is not None:
            selected = self._first_available(policy, role, snapshot, trail)
            if selected is not None:
                return self._resolved(selected, policy, role, trail, snapshot, plan=plan)

        return await self._fall_back(plan, role, policy, snapshot, trail, administrative)

    # ---------------------------------------------------------------- step 1: principal to plan

    async def _plan_for(
        self, principal: Principal | None, session: AsyncSession, snapshot: EntitlementSnapshot
    ) -> PlanCode:
        """The acting principal's effective plan, from backend state and nothing else.

        Read under the session the request already holds, so Row Level Security applies: the owner
        policy on `user_plans` means this query can only ever see the acting principal's own row,
        whatever the predicate says.
        """
        if principal is None:
            return DEFAULT_PLAN

        assigned = await session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = CAST(:subject AS uuid)"),
            {"subject": principal.user_id},
        )
        if assigned is None:
            return DEFAULT_PLAN
        if snapshot.plan(assigned) is None:
            # A plan code the store no longer carries. Free is the safe reading — the alternative
            # is refusing the request over an administrative inconsistency the caller did not cause.
            logger.warning(
                "plan row names %r, which is not a known plan; treating as free", assigned
            )
            return DEFAULT_PLAN
        return PlanCode(assigned)

    # -------------------------------------------------------------- step 2: plan and role to policy

    def _policy_for(
        self,
        plan: PlanCode,
        role: CallRole,
        snapshot: EntitlementSnapshot,
        administrative: bool,
        trail: list[str],
    ) -> PolicyRecord | None:
        record = snapshot.plan(plan)
        if record is None:
            trail.append(f"no plan record for {plan.value}")
            return None

        policy_id = record.policy_for(role)
        if policy_id is None:
            trail.append(f"{plan.value} maps no policy for {role.value}")
            return None

        policy = snapshot.policy(policy_id)
        if policy is None:
            trail.append(f"{plan.value} maps {role.value} to {policy_id}, which does not exist")
            return None
        if not self._eligible(policy, administrative, trail):
            return None

        trail.append(f"policy={policy_id}")
        return policy

    def _eligible(self, policy: PolicyRecord, administrative: bool, trail: list[str]) -> bool:
        """Whether the acting principal may resolve this policy at all.

        The check is on the policy's own eligibility rather than on the plan, which is what makes
        "no plan row can accidentally grant `admin_experimental`" true: a plan mapping naming it is
        simply not honoured for a caller without the role.
        """
        if policy.eligibility is PolicyEligibility.ADMINISTRATIVE and not administrative:
            trail.append(f"{policy.policy_id} is administrative and the caller is not")
            return False
        if policy.eligibility is PolicyEligibility.INTERNAL_EVALUATION:
            # Reached only through `resolve_fixed_evaluation`, never through a plan mapping.
            trail.append(f"{policy.policy_id} is reserved for internal evaluation")
            return False
        return True

    # ---------------------------------------------------------------- step 3: the candidate walk

    def _first_available(
        self,
        policy: PolicyRecord,
        role: CallRole,
        snapshot: EntitlementSnapshot,
        trail: list[str],
    ) -> CatalogEntry | None:
        """The first candidate present, enabled and fit for the role, recording each skip.

        Walked here rather than in the snapshot so the *reason* can name what was skipped and why;
        the snapshot's own filter answers the same question without the narration, and both take
        the policy's declared order.
        """
        for key in policy.candidate_catalog_keys:
            entry = snapshot.entry(key)
            if entry is None:
                trail.append(f"skipped {key}: not in the catalog")
                continue
            if not entry.is_enabled:
                trail.append(f"skipped {key}: disabled")
                continue
            if not entry.serves(role):
                trail.append(f"skipped {key}: not fit for {role.value}")
                continue
            return entry
        return None

    # ---------------------------------------------------------------- steps 4 and 5: the chain

    async def _fall_back(
        self,
        plan: PlanCode,
        role: CallRole,
        policy: PolicyRecord | None,
        snapshot: EntitlementSnapshot,
        trail: list[str],
        administrative: bool,
    ) -> ResolvedCall:
        """The declared fallback, then the plan's default, then the configured model, then refuse.

        **Every rung is re-checked for eligibility**, and that is not belt-and-braces. Without it
        the chain undoes step 2: a plan row mapping `admin_experimental` is refused at the mapping
        and then handed straight back by the plan-default rung, because the plan default *is* the
        mapping. The same hole would return the pinned evaluation policy to a product caller. The
        gate has to be applied wherever a policy is chosen, not only the first time.

        Each rung is also tried only downward. `_no_higher_than` enforces that: a fallback a
        stronger plan maps to is not attempted, because an outage on the Free tier must not hand a
        Free caller a Premium model.
        """
        ceiling = self._entitlement_ceiling(plan, snapshot)
        attempted: set[str] = set() if policy is None else {str(policy.policy_id)}

        if policy is not None and policy.fallback_policy_id is not None:
            declared = snapshot.policy(policy.fallback_policy_id)
            if declared is None:
                trail.append(f"declared fallback {policy.fallback_policy_id} does not exist")
            elif not self._eligible(declared, administrative, trail):
                pass  # `_eligible` has already said why in the trail.
            elif not self._no_higher_than(declared, ceiling, snapshot):
                trail.append(
                    f"declared fallback {declared.policy_id} is above {plan.value}; not attempted"
                )
            else:
                trail.append(f"falling back to {declared.policy_id}")
                attempted.add(str(declared.policy_id))
                selected = self._first_available(declared, role, snapshot, trail)
                if selected is not None:
                    return self._resolved(
                        selected, declared, role, trail, snapshot, plan=plan, fell_back=True
                    )

        default = self._plan_default_policy(plan, role, snapshot)
        if (
            default is not None
            and str(default.policy_id) not in attempted
            and self._eligible(default, administrative, trail)
        ):
            trail.append(f"falling back to the plan default {default.policy_id}")
            attempted.add(str(default.policy_id))
            selected = self._first_available(default, role, snapshot, trail)
            if selected is not None:
                return self._resolved(
                    selected, default, role, trail, snapshot, plan=plan, fell_back=True
                )

        # The documented floor. Every tier is entitled to Free's policy, so a plan whose own
        # mapping is unusable — misconfigured, or pointing at something it may not resolve — lands
        # here rather than skipping straight to configuration. Downward, and no further down.
        floor = snapshot.policy(FREE_DEFAULT_POLICY)
        if (
            floor is not None
            and str(floor.policy_id) not in attempted
            and self._eligible(floor, administrative, trail)
        ):
            trail.append(f"falling back to the {floor.policy_id} floor")
            selected = self._first_available(floor, role, snapshot, trail)
            if selected is not None:
                return self._resolved(
                    selected, floor, role, trail, snapshot, plan=plan, fell_back=True
                )

        configured = self._configured_entry(snapshot, trail)
        if configured is not None:
            trail.append("falling back to the configured model")
            return ResolvedCall(
                resolution=Resolution(
                    policy_id=CONFIGURED_FALLBACK_POLICY,
                    catalog_key=configured.catalog_key,
                    gateway_provider=configured.gateway_provider,
                    gateway_model=configured.gateway_model,
                    reason="; ".join(trail),
                    call_role=role,
                ),
                failover_enabled=False,
                plan=plan,
                fell_back=True,
            )

        raise NoEligibleModel(
            f"No eligible model for the {role.value} call role on the {plan.value} plan.",
            details={"plan": plan.value, "call_role": role.value, "reason": "; ".join(trail)},
        )

    def _entitlement_ceiling(self, plan: PlanCode, snapshot: EntitlementSnapshot) -> int:
        record = snapshot.plan(plan)
        return record.rank if record is not None else 0

    def _no_higher_than(
        self, policy: PolicyRecord, ceiling: int, snapshot: EntitlementSnapshot
    ) -> bool:
        """Whether *policy* is reachable from a plan at or below *ceiling*.

        A policy no plan maps to — the administrative one, the pinned evaluation one — has no rank
        and is never reachable this way, which is the answer that keeps both of them out of a
        product caller's fallback chain.
        """
        ranks = [
            plan.rank
            for plan in snapshot.plans.values()
            if policy.policy_id in plan.policy_by_call_role.values()
        ]
        return bool(ranks) and min(ranks) <= ceiling

    def _plan_default_policy(
        self, plan: PlanCode, role: CallRole, snapshot: EntitlementSnapshot
    ) -> PolicyRecord | None:
        """The plan's own mapping for the role, which is its default by definition.

        Free's is `free_default`, which is also the last policy rung for every tier: a Premium
        caller whose policies are all unavailable ends on Free's model, never above it.
        """
        record = snapshot.plan(plan)
        mapped = record.policy_for(role) if record is not None else None
        if mapped is not None and (policy := snapshot.policy(mapped)) is not None:
            return policy
        return snapshot.policy(FREE_DEFAULT_POLICY)

    def _configured_entry(
        self, snapshot: EntitlementSnapshot, trail: list[str]
    ) -> CatalogEntry | None:
        """`LLM_MODEL`, validated against the catalog rather than trusted.

        `specs/model-catalog`: a configured fallback absent from the catalog or disabled is treated
        as unavailable. Configuration does not outrank the allowlist.
        """
        configured = self._settings.llm_model
        for entry in snapshot.catalog.values():
            if entry.gateway_model == configured:
                if entry.is_enabled:
                    return entry
                trail.append("the configured model is in the catalog and disabled")
                return None
        trail.append("the configured model is not in the catalog")
        return None

    # ---------------------------------------------------------------- overrides and fallbacks

    async def _administrative_override(
        self, catalog_key: str, role: CallRole, principal: Principal | None, session: AsyncSession
    ) -> ResolvedCall:
        """An administrator naming a model, validated against the database and recorded as theirs.

        Raises `ModelNotAllowlisted` when the model is absent or disabled — before any gateway call
        — and the resolution carries the overriding principal, so the record says who did it. An
        override never changes what any other principal's concurrent run resolves: nothing here
        writes shared state.
        """
        entry = await validate_override_against_database(session, catalog_key)
        if not entry.serves(role):
            raise ModelNotAllowlisted(
                f"{catalog_key!r} is not fit for the {role.value} call role.",
                details={"catalog_key": catalog_key, "reason": "wrong_capability_role"},
            )
        subject = principal.user_id if principal else None
        return ResolvedCall(
            resolution=Resolution(
                policy_id=CONFIGURED_FALLBACK_POLICY,
                catalog_key=entry.catalog_key,
                gateway_provider=entry.gateway_provider,
                gateway_model=entry.gateway_model,
                reason=f"administrative override to {entry.catalog_key}",
                call_role=role,
                override_by=subject,
            ),
            failover_enabled=False,
        )

    def _configured_fallback(self, role: CallRole, *, reason: str) -> ResolvedCall:
        """A resolution that came from configuration rather than from a policy.

        Recorded under the reserved indicator so no aggregate can report configuration as
        entitlement, and with failover off: there is no candidate list to walk.
        """
        return ResolvedCall(
            resolution=Resolution(
                policy_id=CONFIGURED_FALLBACK_POLICY,
                catalog_key=CONFIGURED_FALLBACK_POLICY,
                gateway_provider=self._settings.llm_provider,
                gateway_model=self._settings.llm_model,
                reason=reason,
                call_role=role,
            ),
            failover_enabled=False,
        )

    def _resolved(
        self,
        entry: CatalogEntry,
        policy: PolicyRecord,
        role: CallRole,
        trail: list[str],
        snapshot: EntitlementSnapshot,
        *,
        plan: PlanCode | None = None,
        fell_back: bool = False,
    ) -> ResolvedCall:
        trail.append(f"selected {entry.catalog_key}")
        remaining = tuple(
            candidate
            for candidate in snapshot.enabled_candidates(str(policy.policy_id), role)
            if candidate.catalog_key != entry.catalog_key
        )
        return ResolvedCall(
            resolution=Resolution(
                policy_id=policy.policy_id,
                catalog_key=entry.catalog_key,
                gateway_provider=entry.gateway_provider,
                gateway_model=entry.gateway_model,
                reason="; ".join(trail),
                call_role=role,
            ),
            remaining=remaining,
            failover_enabled=policy.failover_enabled and not fell_back,
            plan=plan,
            fell_back=fell_back,
        )

    # ---------------------------------------------------------------- the pinned evaluation path

    async def resolve_fixed_evaluation(
        self, *, role: CallRole, session: AsyncSession
    ) -> ResolvedCall:
        """The fixed-model evaluation policy, resolved without reading anybody's plan.

        `specs/evaluation`: a live run resolves its pinned model through this policy rather than
        through the evaluation test user's subscription plan, "so that a change to a plan, a policy,
        or a candidate pool cannot change what an evaluation run measures". That is why this is a
        separate entry point rather than a flag on `resolve` — a flag would sit inside the walk
        that reads plans, and the guarantee is that the walk does not happen.

        Failover is off and there is no fallback chain: a provider failure aborts the run rather
        than substituting a candidate, because a run that measured a second model while claiming
        the first would be worse than a run that failed.
        """
        snapshot = await self._snapshots.current(session)
        policy = snapshot.policy(EVALUATION_FIXED_POLICY)
        if policy is None:
            raise PolicyUnavailable(
                "The fixed-model evaluation policy is missing from the policy store.",
                details={"policy_id": str(EVALUATION_FIXED_POLICY)},
            )

        trail = ["fixed-model evaluation policy: no plan is read"]
        selected = self._first_available(policy, role, snapshot, trail)
        if selected is None:
            raise NoEligibleModel(
                "The fixed-model evaluation policy has no available candidate.",
                details={
                    "policy_id": str(EVALUATION_FIXED_POLICY),
                    "call_role": role.value,
                    "reason": "; ".join(trail),
                },
            )
        trail.append(f"pinned to {selected.catalog_key}")
        return ResolvedCall(
            resolution=Resolution(
                policy_id=policy.policy_id,
                catalog_key=selected.catalog_key,
                gateway_provider=selected.gateway_provider,
                gateway_model=selected.gateway_model,
                reason="; ".join(trail),
                call_role=role,
            ),
            remaining=(),
            failover_enabled=False,
        )
