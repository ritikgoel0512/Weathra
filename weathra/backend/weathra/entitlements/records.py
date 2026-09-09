"""The read views the stores return, and the audit record every administrative write leaves.

Frozen views rather than ORM rows, for two reasons that both matter more than they look.

**A row is bound to a session; a view is not.** The TTL snapshot of design.md decision 23 holds
catalog, policy and plan state in a process-local object that outlives the transaction that read
it. Handing out `ModelCatalogEntry` instances would mean holding detached ORM objects whose lazy
attributes raise, which is the kind of bug that appears under load and nowhere else.

**A view can refuse to carry what callers must not have.** These are the types the resolver reads,
and the resolver's whole job is to hand back a catalog *key*. So the gateway strings live here —
they have to, something eventually calls the gateway — but they arrive attached to an entry a
caller had to look up by key, rather than floating free where a node could name one.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.entitlements import CallRole, PlanCode, PolicyId
from weathra.domain.usage import QuotaDimension, QuotaWindow

__all__ = [
    "AdminAction",
    "AllowanceRecord",
    "AuditEntry",
    "CapabilityTier",
    "CatalogEntry",
    "CatalogStatus",
    "PlanRecord",
    "PolicyEligibility",
    "PolicyRecord",
]


class CatalogStatus(StrEnum):
    """Whether an entry may be resolved at all.

    ``specs/model-catalog`` treats a disabled entry as unavailable everywhere — no policy resolves
    it, no override accepts it, no lab selection offers it — while its recorded history stays
    readable and attributed. Disabling is therefore the sanctioned response to a model that has
    stopped working, and is why nothing in this package deletes a catalog row.
    """

    ENABLED = "enabled"
    DISABLED = "disabled"


class CapabilityTier(StrEnum):
    """What a policy orders candidates by. Weathra's own judgement, never a vendor's marketing."""

    ECONOMY = "economy"
    STANDARD = "standard"
    FRONTIER = "frontier"


class PolicyEligibility(StrEnum):
    """Who may resolve a policy at all — checked before a plan mapping is even consulted.

    ``ADMINISTRATIVE`` and ``INTERNAL_EVALUATION`` are the two that carry weight: the first is
    gated on the acting principal's role rather than on any plan row, so no plan mapping can grant
    it, and the second keeps the pinned evaluation policy out of every product path so a plan
    change cannot alter what a run measures.
    """

    PUBLIC = "public"
    PLAN = "plan"
    ADMINISTRATIVE = "administrative"
    INTERNAL_EVALUATION = "internal_evaluation"


class CatalogEntry(BaseModel):
    """One model Weathra is allowed to use, as the stores hand it out."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str = Field(
        min_length=1, description="The stable internal handle. Never a vendor name."
    )
    gateway_provider: str = Field(min_length=1)
    gateway_model: str = Field(
        min_length=1, description="The vendor string. Mutable; a rename is one row."
    )
    display_name: str = Field(min_length=1)
    capability_roles: tuple[CallRole, ...] = Field(min_length=1)
    capability_tier: CapabilityTier
    supports_structured_output: bool
    context_window: int = Field(gt=0)
    input_price_per_million: Decimal = Field(ge=0)
    output_price_per_million: Decimal = Field(ge=0)
    price_currency: str = Field(min_length=3, max_length=3)
    pricing_recorded_on: date
    status: CatalogStatus
    is_free_tier: bool

    @property
    def is_enabled(self) -> bool:
        return self.status is CatalogStatus.ENABLED

    def serves(self, role: CallRole) -> bool:
        """Whether this entry is fit for *role*. Enablement is a separate question, asked apart."""
        return role in self.capability_roles


class PolicyRecord(BaseModel):
    """A named, ordered candidate list, as stored."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    policy_id: PolicyId
    display_name: str = Field(min_length=1)
    candidate_catalog_keys: tuple[str, ...] = Field(
        min_length=1, description="Ordered. The first enabled catalog entry wins."
    )
    applicable_call_roles: tuple[CallRole, ...] = Field(min_length=1)
    eligibility: PolicyEligibility
    fallback_policy_id: PolicyId | None = None
    failover_enabled: bool = True

    @property
    def is_pinned(self) -> bool:
        """Whether this policy is fixed to its single candidate and may not fail over.

        The fixed evaluation policy of ``specs/evaluation``. The table already refuses a row that
        claims to be pinned while declaring a second candidate, so this reads a settled fact rather
        than arbitrating one.
        """
        return not self.failover_enabled

    def applies_to(self, role: CallRole) -> bool:
        return role in self.applicable_call_roles


class PlanRecord(BaseModel):
    """A product tier, its rank, and the policy it maps each call role to."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    plan_code: PlanCode
    display_name: str = Field(min_length=1)
    rank: int = Field(
        ge=0, description="Ascending entitlement. What 'never escalate above' compares."
    )
    policy_by_call_role: dict[CallRole, PolicyId] = Field(default_factory=dict)
    external_subscription_ref: str | None = Field(
        default=None, description="Unused. Where a billing provider's id would later land."
    )

    def policy_for(self, role: CallRole) -> PolicyId | None:
        """The policy this plan maps *role* to, or ``None`` where it maps none.

        ``None`` is a real answer and not an error: a plan that maps no policy for a role has no
        entitlement for it, and the resolver reports that rather than inventing one.
        """
        return self.policy_by_call_role.get(role)


class AllowanceRecord(BaseModel):
    """One allowance: a subject, a dimension, a window, a number."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    plan_code: PlanCode | None = None
    internal_subject: str | None = None
    dimension: QuotaDimension
    window_kind: QuotaWindow
    allowance: int = Field(ge=0)

    @property
    def subject(self) -> str:
        """Whose allowance this is — a plan code, or the reserved internal subject."""
        if self.plan_code is not None:
            return self.plan_code.value
        assert self.internal_subject is not None  # the table's CHECK guarantees exactly one
        return self.internal_subject


class AdminAction(StrEnum):
    """What an administrative write did. The verb half of an audit row."""

    CATALOG_CREATE = "catalog_create"
    CATALOG_EDIT = "catalog_edit"
    CATALOG_ENABLE = "catalog_enable"
    CATALOG_DISABLE = "catalog_disable"
    POLICY_CREATE = "policy_create"
    POLICY_EDIT = "policy_edit"
    PLAN_MAPPING_EDIT = "plan_mapping_edit"
    ALLOWANCE_SET = "allowance_set"
    PLAN_ASSIGN = "plan_assign"


class AuditEntry(BaseModel):
    """One administrative change, as it is recorded.

    Every write in this package produces one. The before and after are the whole point: "who
    changed the candidate list" is answerable without it, and "what did it used to be" is not.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    acting_principal: str = Field(min_length=1)
    action: AdminAction
    subject_kind: str = Field(min_length=1, description="Which kind of record changed.")
    subject_id: str = Field(min_length=1)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    cited_comparison_run_ids: tuple[str, ...] = ()
    created_at: datetime | None = None
