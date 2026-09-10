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
from weathra.domain.errors import ValidationFailed
from weathra.entitlements.audit import record_change, recorded_changes
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.policies import POLICY_SUBJECT_KIND, PolicyStore
from weathra.entitlements.records import (
    AdminAction,
    AuditEntry,
    CapabilityTier,
    CatalogEntry,
    CatalogStatus,
    PolicyEligibility,
    PolicyRecord,
)
from weathra.lab.promotion import GATING_CRITERIA, criteria_failures
from weathra.lab.records import LabRecords

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

    ``acknowledge_criteria_failure`` exists because the criteria gate has to be refusable by a
    person and not merely by a machine. `specs/evaluation` forbids promoting on cost or latency a
    candidate that failed structured reliability or groundedness; it does not forbid an
    administrator who has read the evidence from overriding that. What it must not be is silent —
    so the override is an explicit field, and the audit row records that it was used and which
    criteria it overrode.
    """

    model_config = ConfigDict(extra="forbid")

    candidate_catalog_keys: tuple[str, ...] = Field(min_length=1)
    cited_comparison_run_ids: tuple[str, ...] = ()
    acknowledge_criteria_failure: bool = Field(
        default=False,
        description="Promote a candidate that failed a gating criterion anyway. Recorded as such.",
    )


class PolicyFallbackRequest(BaseModel):
    """The declared fallback, or null to clear it."""

    model_config = ConfigDict(extra="forbid")

    fallback_policy_id: str | None = None


class PlanMappingRequest(BaseModel):
    """Which policy a plan resolves to, per call role."""

    model_config = ConfigDict(extra="forbid")

    policy_by_call_role: dict[CallRole, str] = Field(min_length=1)


class CatalogObservation(BaseModel):
    """What the lab last recorded about one model.

    `specs/model-catalog` asks the administrative listing to carry "the outcome of the most recent
    health or evaluation observation for that model, **where recorded**" — so a model nobody has
    evaluated is simply absent from the map rather than present with a null verdict, because
    "never measured" and "measured and inconclusive" are different facts about a model.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    gateway_model: str
    dataset_version: str
    passed: bool | None = None
    recorded_at: str | None = None
    criteria: dict[str, Any] = Field(default_factory=dict)


class CatalogListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    entries: tuple[CatalogEntry, ...]
    observations: dict[str, CatalogObservation] = Field(
        default_factory=dict,
        description="The most recent evaluation outcome per catalog entry, where one exists.",
    )


class PolicyListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    policies: tuple[PolicyRecord, ...]


class PolicyAuditResponse(BaseModel):
    """One policy's audit trail, and no other record's.

    Narrowed to the policy in the path rather than paging the whole of ``admin_audit``: what a
    candidate-list change needs to be readable is *its own* history — who changed this policy, from
    what to what, citing which comparison — and a listing that answered more than that would put a
    plan assignment and a role grant in front of a reader who asked about a policy.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    policy_id: str
    count: int = Field(ge=0, description="Entries returned, newest first.")
    entries: tuple[AuditEntry, ...]


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

    Each entry is accompanied by the most recent evaluation the lab recorded for it, where there
    is one. That is what makes the catalog *observable* rather than merely listable: a status says
    whether a model may serve, and an observation says how it did when it last served.
    """
    annotate(request, acting_user_id=principal.user_id)
    entries = await CatalogStore(session).list(status=status, capability_role=capability_role)
    observed = await LabRecords(session).latest_evaluations(
        [entry.catalog_key for entry in entries]
    )
    return CatalogListResponse(
        count=len(entries),
        entries=entries,
        observations={
            key: CatalogObservation(**observation) for key, observation in observed.items()
        },
    )


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


@router.get(
    "/policies/{policy_id}/audit",
    response_model=PolicyAuditResponse,
    summary="Read one policy's audit trail",
)
async def read_policy_audit(
    request: Request,
    policy_id: PolicyIdentifier,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    limit: Annotated[int, Query(ge=1, le=100, description="Newest first.")] = 20,
) -> PolicyAuditResponse:
    """What has been done to one policy, newest first, with the comparison runs each change cited.

    A read rather than a convenience: `specs/model-lab` requires a promotion to be "recorded with
    the acting principal, the change made, and the comparison run identifiers cited as its basis",
    and a record nothing can read back is a record only in name. The write side has existed since
    group 31; this is the side that lets somebody other than a database client confirm it.

    Unknown policy is a 404 rather than an empty list, because "this policy has no history" and
    "there is no such policy" are different answers and a reader acting on the first when the
    second is true would conclude a change had not been recorded.

    Every field comes from ``admin_audit``, which holds no prompt, completion, or weather content —
    the before and after are the policy row, and the acting principal is an auth subject.
    """
    annotate(request, acting_user_id=principal.user_id)
    await PolicyStore(session).require(policy_id)
    entries = await recorded_changes(
        session, subject_kind=POLICY_SUBJECT_KIND, subject_id=policy_id
    )
    kept = entries[:limit]
    return PolicyAuditResponse(policy_id=policy_id, count=len(kept), entries=kept)


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

    # `specs/evaluation`: a candidate failing structured JSON reliability or groundedness is not
    # promoted on the strength of being cheaper or faster. Checked against the *recorded* criteria
    # rather than against an opinion, and only where there are recorded criteria to check — a
    # model nobody has evaluated is not refused here, it is simply unevidenced, and refusing it
    # would make the lab a precondition for every catalog change rather than a basis for one.
    failures = await criteria_failures(session, body.candidate_catalog_keys)
    if failures and not body.acknowledge_criteria_failure:
        raise ValidationFailed(
            "A candidate that failed a gating criterion is not promoted on cost or latency "
            "alone. Read the evidence and set acknowledge_criteria_failure to override.",
            details={
                "field": "candidate_catalog_keys",
                "failed_criteria": failures,
                "gating_criteria": list(GATING_CRITERIA),
            },
        )

    policy = await PolicyStore(session).set_candidates(
        policy_id,
        list(body.candidate_catalog_keys),
        acting_principal=principal.user_id,
        cited_comparison_run_ids=body.cited_comparison_run_ids,
    )
    if failures:
        # The override is a fact about the decision, so it goes in the trail beside the change
        # rather than in a log line nobody correlates.
        await record_change(
            session,
            acting_principal=principal.user_id,
            action=AdminAction.POLICY_EDIT,
            subject_kind=POLICY_SUBJECT_KIND,
            subject_id=str(policy_id),
            before={"criteria_gate": "failed"},
            after={"criteria_gate": "overridden", "failed_criteria": failures},
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
