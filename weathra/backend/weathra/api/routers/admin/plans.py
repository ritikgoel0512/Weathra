"""Task 31.4 — administering plans, allowances, plan assignment, and the administrative role.

The plan half is the same shape as the model router: thin routes over the group 27 `PlanStore`,
which holds the refusals `specs/usage-limits` names — a negative allowance, an unknown dimension,
an allowance belonging to neither a plan nor the internal subject, a mapping naming a policy that
does not exist — and writes `admin_audit` in the same transaction.

**The role half is here rather than in its own router, and the reason is that it is the same
surface.** Putting a person on Pro and giving a person the administrative role are both
"administer this principal", both privileged writes to a table the request path may only read, and
both recorded with the same mechanism. `specs/authentication` requires the promotion to be
attributed, and 31.2 names it among the writes the audit must cover; splitting it across two
routers would leave a reader looking for it in the wrong one.

**Granting the role is the most consequential write here**, because it is the one that creates the
ability to make the others. It is therefore the one place this package refuses an operation on a
non-security ground: an administrator may not revoke their own role, because an estate with no
administrator left has no way back in short of the bootstrap script and a database credential.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.middleware import annotate
from weathra.api.routers.admin.deps import AdministrativeSession
from weathra.auth.deps import AdministrativePrincipal
from weathra.auth.roles import ADMINISTRATOR_ROLE, RoleStore
from weathra.domain.entitlements import PlanCode
from weathra.domain.errors import ValidationFailed
from weathra.domain.usage import QuotaDimension
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.records import AllowanceRecord, PlanRecord

__all__ = ["router"]

logger = logging.getLogger("weathra.api.admin.plans")

router = APIRouter(prefix="/admin", tags=["administration"])

Subject = Annotated[str, Path(min_length=1, max_length=64, description="An auth subject.")]


# =========================================================================== bodies


class AllowanceRequest(BaseModel):
    """One allowance, for a plan or for the internal subject.

    The value is bounded above as well as below. A negative allowance is refused because
    `specs/usage-limits` says so; an absurd one is refused because a typo that adds three zeroes to
    a monthly token budget is a bill, and there is no legitimate allowance near the ceiling.
    """

    model_config = ConfigDict(extra="forbid")

    dimension: QuotaDimension
    allowance: int = Field(ge=0, le=1_000_000_000_000)


class PlanAssignmentRequest(BaseModel):
    """Which tier a person is on.

    ``PlanCode`` and not a string, so a body naming ``plus`` is refused by validation before the
    handler runs. The retired tier is not a value this enum has and no alias admits it.
    """

    model_config = ConfigDict(extra="forbid")

    plan_code: PlanCode


class RoleGrantResponse(BaseModel):
    """One role grant, as an administrator sees it. No contact detail, because none is stored."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    subject_id: str
    role: str
    granted_by: str | None = Field(
        default=None, description="Null for the bootstrap grant, which has no granter to name."
    )
    granted_at: datetime


class PlanListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    plans: tuple[PlanRecord, ...]


class AllowanceListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    allowances: tuple[AllowanceRecord, ...]


class RoleListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    grants: tuple[RoleGrantResponse, ...]


# =========================================================================== plans


@router.get("/plans", response_model=PlanListResponse, summary="List the subscription plans")
async def list_plans(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> PlanListResponse:
    annotate(request, acting_user_id=principal.user_id)
    plans = await PlanStore(session).list()
    return PlanListResponse(count=len(plans), plans=plans)


@router.get("/allowances", response_model=AllowanceListResponse, summary="List the allowances")
async def list_allowances(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    plan_code: Annotated[PlanCode | None, Query(description="Narrow to one plan.")] = None,
    internal: Annotated[bool, Query(description="The internal allowance only.")] = False,
) -> AllowanceListResponse:
    """Every allowance, or one plan's, or the internal subject's.

    A dimension with no row is *unlimited*, and it is absent here rather than reported as a large
    number — filling it in would be reporting a limit nobody configured.
    """
    annotate(request, acting_user_id=principal.user_id)
    allowances = await PlanStore(session).allowances(plan_code=plan_code, internal=internal)
    return AllowanceListResponse(count=len(allowances), allowances=allowances)


@router.put(
    "/plans/{plan_code}/allowances",
    response_model=AllowanceRecord,
    summary="Set one of a plan's allowances",
)
async def set_plan_allowance(
    request: Request,
    plan_code: Annotated[PlanCode, Path(description="free, pro, or premium.")],
    body: AllowanceRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> AllowanceRecord:
    """Change one allowance. Takes effect for the remainder of the current window.

    Not cached anywhere: `entitlements/quotas.py` reads `usage_limits` fresh on every admission,
    precisely so "an allowance change takes effect without a code change" means *now* rather than
    within a staleness window.
    """
    annotate(request, acting_user_id=principal.user_id)
    return await PlanStore(session).set_allowance(
        acting_principal=principal.user_id,
        plan_code=plan_code,
        dimension=body.dimension,
        allowance=body.allowance,
    )


@router.put(
    "/allowances/internal",
    response_model=AllowanceRecord,
    summary="Set one of the internal allowances",
)
async def set_internal_allowance(
    request: Request,
    body: AllowanceRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> AllowanceRecord:
    """The allowance administrative, lab and evaluation traffic is accounted against.

    Its own route rather than a flag on the one above, because the internal subject is not a plan
    and a body field that switched between them would be one typo away from raising Free's
    allowance while meaning to raise the lab's.
    """
    annotate(request, acting_user_id=principal.user_id)
    return await PlanStore(session).set_allowance(
        acting_principal=principal.user_id,
        internal=True,
        dimension=body.dimension,
        allowance=body.allowance,
    )


# =========================================================================== principals


@router.put(
    "/principals/{subject_id}/plan",
    response_model=PlanRecord,
    summary="Assign a principal to a plan",
)
async def assign_plan(
    request: Request,
    subject_id: Subject,
    body: PlanAssignmentRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> PlanRecord:
    """Put a person on a tier.

    The only way an assignment happens: `user_plans` grants the request role `SELECT` and nothing
    else, so a caller cannot assign themselves one however the request is shaped.
    """
    annotate(request, acting_user_id=principal.user_id)
    return await PlanStore(session).assign(
        subject_id, body.plan_code, acting_principal=principal.user_id
    )


@router.get(
    "/principals/administrators",
    response_model=RoleListResponse,
    summary="List the administrative principals",
)
async def list_administrators(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> RoleListResponse:
    """Who holds the administrative role, and who granted it to them.

    Privileged, and only reachable here: the owner policy on `admin_roles` returns a request
    session exactly its own row, so this list cannot be assembled from the request path however
    the query is written.
    """
    annotate(request, acting_user_id=principal.user_id)
    grants = await RoleStore(session).holders(ADMINISTRATOR_ROLE)
    return RoleListResponse(
        count=len(grants),
        grants=tuple(
            RoleGrantResponse(
                subject_id=grant.user_id,
                role=grant.role,
                granted_by=grant.granted_by,
                granted_at=grant.granted_at,
            )
            for grant in grants
        ),
    )


@router.put(
    "/principals/{subject_id}/role",
    response_model=RoleGrantResponse,
    summary="Grant a principal the administrative role",
)
async def grant_role(
    request: Request,
    subject_id: Subject,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> RoleGrantResponse:
    """Promote a principal. Privileged, recorded, and idempotent.

    `specs/authentication` requires an administrative action to be attributed, and this is the
    action that most needs it: it is the one that creates the ability to perform every other one.
    """
    annotate(request, acting_user_id=principal.user_id)
    store = RoleStore(session)
    await store.grant(subject_id, ADMINISTRATOR_ROLE, acting_principal=principal.user_id)
    grant = next(
        item for item in await store.holders(ADMINISTRATOR_ROLE) if item.user_id == subject_id
    )
    return RoleGrantResponse(
        subject_id=grant.user_id,
        role=grant.role,
        granted_by=grant.granted_by,
        granted_at=grant.granted_at,
    )


@router.delete(
    "/principals/{subject_id}/role",
    status_code=204,
    summary="Revoke a principal's administrative role",
)
async def revoke_role(
    request: Request,
    subject_id: Subject,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> None:
    """Demote a principal — but never yourself.

    The self-revocation refusal is not paternalism about a mistake. An estate whose last
    administrator demotes themselves has no way back in except the bootstrap script and a database
    credential, and the person most likely to do it by accident is the one testing whether the
    endpoint works.
    """
    annotate(request, acting_user_id=principal.user_id)
    if subject_id == principal.user_id:
        raise ValidationFailed(
            "An administrator cannot revoke their own role. Ask another administrator, so the "
            "estate is never left without one.",
            details={"field": "subject_id"},
        )
    await RoleStore(session).revoke(
        subject_id, ADMINISTRATOR_ROLE, acting_principal=principal.user_id
    )
