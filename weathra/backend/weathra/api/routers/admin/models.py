"""Task 31.3 — administering the model catalog, the policies, and a plan's policy mapping.

Every route is a thin translation between HTTP and a group 27 store. That thinness is the design:
the stores hold the invariants `specs/model-catalog` and `specs/model-policy` require — the unique
catalog key, the unique gateway identity, the refusal to disable the last model serving a role, the
refusal of a dangling candidate, the pinned policy that may declare no fallback — and they write
`admin_audit` in the same transaction as the change. A route that reached for SQL would be a second
way to change a policy, with its own validation and its own chance of recording nothing.

**Every mutation invalidates this process's entitlement snapshot.** Not an invalidation protocol —
other instances converge on their own TTL, which is the documented staleness window (design.md
decision 23). It exists so the administrator who just disabled a model does not immediately see it
serve, which is the one case where the window is indefensible.
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Inference
from weathra.api.middleware import annotate
from weathra.api.routers.admin.deps import AdministrativeSession
from weathra.auth.deps import AdministrativePrincipal
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.policies import PolicyStore
from weathra.entitlements.records import (
    CapabilityTier,
    CatalogEntry,
    CatalogStatus,
    PolicyEligibility,
    PolicyRecord,
)

__all__ = ["router"]

logger = logging.getLogger("weathra.api.admin.models")

router = APIRouter(prefix="/admin", tags=["administration"])

CatalogKey = Annotated[str, Path(min_length=1, max_length=64, description="The catalog entry.")]
PolicyIdentifier = Annotated[str, Path(min_length=1, max_length=64, description="The policy.")]


# =========================================================================== bodies


class CatalogCreateRequest(BaseModel):
    """A new catalog entry, with every field the resolver and the cost estimator need.

    No default for pricing or for the date it was read: `specs/llm-telemetry` copies both onto every
    usage event so a re-pricing cannot rewrite history, and a default here would be a made-up price
    quietly attached to real calls.
    """

    model_config = ConfigDict(extra="forbid")

    catalog_key: str = Field(min_length=1, max_length=64)
    gateway_provider: str = Field(min_length=1, max_length=64)
    gateway_model: str = Field(min_length=1, max_length=200)
    display_name: str = Field(min_length=1, max_length=200)
    capability_roles: tuple[CallRole, ...] = Field(min_length=1)
    capability_tier: CapabilityTier
    supports_structured_output: bool
    context_window: int = Field(gt=0)
    input_price_per_million: Decimal = Field(ge=0)
    output_price_per_million: Decimal = Field(ge=0)
    pricing_recorded_on: date
    is_free_tier: bool
    price_currency: str = Field(default="USD", min_length=3, max_length=3)
    status: CatalogStatus = CatalogStatus.ENABLED


class CatalogEditRequest(BaseModel):
    """The editable half of an entry. ``status`` is deliberately absent.

    Enabling and disabling have their own routes because disabling carries a cross-row refusal —
    the last model serving a call role may not be withdrawn — and a generic field update would
    skip it.
    """

    model_config = ConfigDict(extra="forbid")

    gateway_provider: str | None = Field(default=None, min_length=1, max_length=64)
    gateway_model: str | None = Field(default=None, min_length=1, max_length=200)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    capability_roles: tuple[CallRole, ...] | None = None
    capability_tier: CapabilityTier | None = None
    supports_structured_output: bool | None = None
    context_window: int | None = Field(default=None, gt=0)
    input_price_per_million: Decimal | None = Field(default=None, ge=0)
    output_price_per_million: Decimal | None = Field(default=None, ge=0)
    price_currency: str | None = Field(default=None, min_length=3, max_length=3)
    pricing_recorded_on: date | None = None
    is_free_tier: bool | None = None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent.

        ``exclude_unset`` rather than ``exclude_none``: a field explicitly set to null is a caller
        saying something, and conflating it with a field they left alone is how a partial update
        silently clears a column.
        """
        supplied = self.model_dump(exclude_unset=True)
        if "capability_roles" in supplied and supplied["capability_roles"] is not None:
            supplied["capability_roles"] = [str(role) for role in supplied["capability_roles"]]
        return supplied


class PolicyCreateRequest(BaseModel):
    """A new policy: a name, an ordered candidate list, and who may resolve it."""

    model_config = ConfigDict(extra="forbid")

    policy_id: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=200)
    candidate_catalog_keys: tuple[str, ...] = Field(min_length=1)
    applicable_call_roles: tuple[CallRole, ...] = Field(min_length=1)
    eligibility: PolicyEligibility
    fallback_policy_id: str | None = None
    failover_enabled: bool = True


class PolicyCandidatesRequest(BaseModel):
    """A re-pointed candidate list — a model promotion, in practice.

    ``cited_comparison_run_ids`` is design.md decision 26's discipline: a promotion names the
    comparison runs that justified it, so the audit trail carries the evidence rather than a
    recollection of it.
    """

    model_config = ConfigDict(extra="forbid")

    candidate_catalog_keys: tuple[str, ...] = Field(min_length=1)
    cited_comparison_run_ids: tuple[str, ...] = ()


class PolicyFallbackRequest(BaseModel):
    """The declared fallback, or null to clear it."""

    model_config = ConfigDict(extra="forbid")

    fallback_policy_id: str | None = None


class PlanMappingRequest(BaseModel):
    """Which policy a plan resolves to, per call role."""

    model_config = ConfigDict(extra="forbid")

    policy_by_call_role: dict[CallRole, str] = Field(min_length=1)


class CatalogListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    entries: tuple[CatalogEntry, ...]


class PolicyListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    policies: tuple[PolicyRecord, ...]


# =========================================================================== the catalog


@router.get("/models", response_model=CatalogListResponse, summary="List the model catalog")
async def list_catalog(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    status: Annotated[CatalogStatus | None, Query(description="Narrow by status.")] = None,
    capability_role: Annotated[
        CallRole | None, Query(description="Narrow to entries fit for one call role.")
    ] = None,
) -> CatalogListResponse:
    """Every catalog entry, optionally narrowed by status and by capability role.

    Includes disabled entries, which is the point of the status filter: `specs/model-catalog`
    requires a withdrawn model to stay auditable rather than disappearing, so an administrator can
    still see what served last month.
    """
    annotate(request, acting_user_id=principal.user_id)
    entries = await CatalogStore(session).list(status=status, capability_role=capability_role)
    return CatalogListResponse(count=len(entries), entries=entries)


@router.post(
    "/models", response_model=CatalogEntry, status_code=201, summary="Add a model to the catalog"
)
async def create_catalog_entry(
    request: Request,
    body: CatalogCreateRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> CatalogEntry:
    annotate(request, acting_user_id=principal.user_id)
    entry = await CatalogStore(session).create(
        acting_principal=principal.user_id, **body.model_dump()
    )
    inference.snapshots.invalidate()
    return entry


@router.patch("/models/{catalog_key}", response_model=CatalogEntry, summary="Edit a catalog entry")
async def edit_catalog_entry(
    request: Request,
    catalog_key: CatalogKey,
    body: CatalogEditRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> CatalogEntry:
    annotate(request, acting_user_id=principal.user_id)
    entry = await CatalogStore(session).edit(
        catalog_key, body.changes(), acting_principal=principal.user_id
    )
    inference.snapshots.invalidate()
    return entry


@router.post(
    "/models/{catalog_key}/enable", response_model=CatalogEntry, summary="Enable a catalog entry"
)
async def enable_catalog_entry(
    request: Request,
    catalog_key: CatalogKey,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> CatalogEntry:
    annotate(request, acting_user_id=principal.user_id)
    entry = await CatalogStore(session).enable(catalog_key, acting_principal=principal.user_id)
    inference.snapshots.invalidate()
    return entry


@router.post(
    "/models/{catalog_key}/disable", response_model=CatalogEntry, summary="Disable a catalog entry"
)
async def disable_catalog_entry(
    request: Request,
    catalog_key: CatalogKey,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> CatalogEntry:
    """Withdraw a model from resolution.

    Refused when it is the last enabled entry serving a call role: `specs/model-catalog` requires
    the system to keep answering, and a disable that left routing with nothing to resolve would
    take the agent surface down from an administrative screen.
    """
    annotate(request, acting_user_id=principal.user_id)
    entry = await CatalogStore(session).disable(catalog_key, acting_principal=principal.user_id)
    inference.snapshots.invalidate()
    return entry


# =========================================================================== the policies


@router.get("/policies", response_model=PolicyListResponse, summary="List the model policies")
async def list_policies(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> PolicyListResponse:
    annotate(request, acting_user_id=principal.user_id)
    policies = await PolicyStore(session).list()
    return PolicyListResponse(count=len(policies), policies=policies)


@router.post(
    "/policies", response_model=PolicyRecord, status_code=201, summary="Create a model policy"
)
async def create_policy(
    request: Request,
    body: PolicyCreateRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> PolicyRecord:
    annotate(request, acting_user_id=principal.user_id)
    policy = await PolicyStore(session).create(
        acting_principal=principal.user_id, **body.model_dump()
    )
    inference.snapshots.invalidate()
    return policy


@router.put(
    "/policies/{policy_id}/candidates",
    response_model=PolicyRecord,
    summary="Re-point a policy's candidate list",
)
async def set_policy_candidates(
    request: Request,
    policy_id: PolicyIdentifier,
    body: PolicyCandidatesRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> PolicyRecord:
    annotate(request, acting_user_id=principal.user_id)
    policy = await PolicyStore(session).set_candidates(
        policy_id,
        list(body.candidate_catalog_keys),
        acting_principal=principal.user_id,
        cited_comparison_run_ids=body.cited_comparison_run_ids,
    )
    inference.snapshots.invalidate()
    return policy


@router.put(
    "/policies/{policy_id}/fallback",
    response_model=PolicyRecord,
    summary="Set or clear a policy's fallback",
)
async def set_policy_fallback(
    request: Request,
    policy_id: PolicyIdentifier,
    body: PolicyFallbackRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> PolicyRecord:
    annotate(request, acting_user_id=principal.user_id)
    policy = await PolicyStore(session).set_fallback(
        policy_id, body.fallback_policy_id, acting_principal=principal.user_id
    )
    inference.snapshots.invalidate()
    return policy


# =========================================================================== plan-to-policy


@router.put(
    "/plans/{plan_code}/policies",
    response_model=None,
    summary="Re-point a plan at different policies",
)
async def set_plan_policy_mapping(
    request: Request,
    plan_code: Annotated[PlanCode, Path(description="free, pro, or premium.")],
    body: PlanMappingRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
) -> dict[str, Any]:
    """Which policy each of a plan's call roles resolves to.

    The plan code is a ``PlanCode``, so a request naming ``plus`` is refused by validation before
    the handler runs: the retired tier is not a value this enum has, and no alias admits it.
    """
    annotate(request, acting_user_id=principal.user_id)
    plan = await PlanStore(session).set_policy_mapping(
        plan_code, body.policy_by_call_role, acting_principal=principal.user_id
    )
    inference.snapshots.invalidate()
    return plan.model_dump(mode="json")
