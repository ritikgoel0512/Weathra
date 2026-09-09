"""What a call was made *for*: the identity, correlation and entitlement facts around it.

`CallContext` of design.md decision 24. It carries the parts of a usage event that come from the
request rather than from the gateway — who is acting, which run and request it belongs to, and the
resolution the model policy layer produced.

**Every field is copied from something that already decided it.** The plan came from `user_plans`
by way of the resolver, the policy and catalog key came from the resolution, the subject kind came
from how the run was invoked. Nothing here derives an entitlement fact, and nothing here can: it
holds no session and no snapshot, so there is nothing to derive one from.

**Why the resolution is held rather than its pieces.** A context built from loose strings could be
assembled with a policy from one call and a model from another. Taking the `Resolution` means the
three facts travel together and came from one decision.
"""

from __future__ import annotations

from dataclasses import dataclass

from weathra.domain.entitlements import CallRole, PlanCode, Resolution
from weathra.domain.identity import Principal
from weathra.domain.usage import SubjectKind

__all__ = ["CallContext"]


@dataclass(frozen=True, slots=True)
class CallContext:
    """The request-side half of a usage event."""

    call_role: CallRole
    resolution: Resolution
    user_id: str | None = None
    subject_kind: SubjectKind = SubjectKind.USER
    plan: PlanCode | None = None
    agent_run_id: str | None = None
    request_id: str | None = None

    @classmethod
    def for_run(
        cls,
        *,
        role: CallRole,
        resolution: Resolution,
        principal: Principal | None,
        plan: PlanCode | None,
        agent_run_id: str | None = None,
        request_id: str | None = None,
        internal: bool = False,
    ) -> CallContext:
        """The context for one call role within one run.

        ``internal`` covers the lab, evaluation and administrative paths. It is a parameter rather
        than something inferred from the principal because an administrator asking a product
        question as themselves is internal traffic with a perfectly ordinary user id — the caller
        knows which path it is on, and guessing from the identity would get exactly that case
        wrong (`specs/usage-limits`).
        """
        subject = SubjectKind.INTERNAL if internal or principal is None else SubjectKind.USER
        return cls(
            call_role=role,
            resolution=resolution,
            user_id=principal.user_id if principal else None,
            subject_kind=subject,
            # An internal event carries no plan; `UsageEvent` refuses one, and this is where that
            # becomes true rather than where it is discovered.
            plan=None if subject is SubjectKind.INTERNAL else (plan or PlanCode.FREE),
            agent_run_id=agent_run_id,
            request_id=request_id,
        )

    @property
    def catalog_key(self) -> str:
        return self.resolution.catalog_key

    @property
    def gateway_model(self) -> str:
        return self.resolution.gateway_model

    @property
    def gateway_provider(self) -> str:
        return self.resolution.gateway_provider
