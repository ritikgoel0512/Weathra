"""What a caller is entitled to, and what that resolved to (design.md decision 22).

The vocabulary the model policy layer is written in, and nothing else: no resolver, no store, no
client. The resolver lands in `entitlements/` above `db/`; these are the types it speaks, kept in
``domain/`` because telemetry, quota accounting, the lab and the evaluation runner all need the
same words and none of them may import each other.

Three kinds of name live here, and the difference between them is deliberate:

* **`CallRole` and `PlanCode` are closed enums.** A call role is a property of the graph — there
  are two of them plus the lab — and adding a third is a code change by definition. A plan code is
  a product decision that reaches contracts, pricing pages and support conversations, so an
  unrecognised one is a bug rather than an extension point.
* **`PolicyId` is an open, validated string.** Policies are *data*: ``specs/model-policy`` requires
  a policy to be addable and re-pointable with no code change and no redeployment, so an enum here
  would be exactly the coupling the spec forbids. The shipped four are named as constants because
  code legitimately refers to them — `admin_experimental` is gated on the administrative role, and
  the evaluation policy is pinned — but the type admits any well-formed identifier.
* **`Resolution` is a record of what happened**, carrying `reason` so "why did this caller get that
  model" is answerable from the evidence record without re-running the resolution.

**No vendor model identifier appears in this module, and none may.** A policy names catalog keys;
a catalog key names a row; the row holds the gateway string. That indirection is what makes
``specs/model-catalog``'s "business logic is decoupled from vendor model identifiers" mechanically
checkable rather than a matter of discipline (``tests/unit/test_no_vendor_coupling.py``).
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, GetCoreSchemaHandler
from pydantic_core import core_schema

__all__ = [
    "ADMIN_EXPERIMENTAL_POLICY",
    "BALANCED_POLICY",
    "CONFIGURED_FALLBACK_POLICY",
    "EVALUATION_FIXED_POLICY",
    "FREE_DEFAULT_POLICY",
    "HIGH_REASONING_POLICY",
    "LAB_COMPARISON_POLICY",
    "PRODUCT_PLAN_CODES",
    "SHIPPED_POLICY_IDS",
    "CallRole",
    "PlanCode",
    "PolicyId",
    "Resolution",
]


class CallRole(StrEnum):
    """The role a language model call serves, which is what a policy maps against.

    The role rather than the node (design.md decision 22): a fourth node needing a structured
    decision reuses ``ROUTING`` and no policy changes. ``LAB`` is separate because a comparison run
    is internal traffic accounted against the internal allowance, never a product plan's.
    """

    ROUTING = "routing"
    SYNTHESIS = "synthesis"
    LAB = "lab"


class PlanCode(StrEnum):
    """The canonical subscription plan codes.

    Three tiers, lowercase, stable enough to map to an external billing product later
    (``specs/usage-limits``' "room left for a later billing integration"). The display names live
    in ``subscription_plans`` as data, so renaming *Premium* on a pricing page is a row update; the
    code here is the identifier that must not move, because `user_plans` rows and recorded usage
    events both carry it.

    There is deliberately **no `plus`**. An earlier draft of the specs named the middle tier that
    way; the product decision of 2026-09-09 settled on Free / Pro / Premium and the specs were
    reconciled to match. No alias is provided in either direction — this foundation has never
    shipped, so there is no customer contract to be backward-compatible with, and an alias would
    only make two names for one tier that a later reader has to reconcile again.
    """

    FREE = "free"
    PRO = "pro"
    PREMIUM = "premium"


# The plans a paying or non-paying *person* can be on, in ascending order of entitlement. Ordered
# because "never escalate above the caller's entitlement" needs a comparison, and a set could not
# express it. Internal traffic is not on this ladder at all: it has its own subject and its own
# allowance (design.md decision 25), which is what keeps a lab run off a user's plan by
# construction rather than by a flag somebody has to remember to set.
PRODUCT_PLAN_CODES: tuple[PlanCode, ...] = (PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM)

# A policy identifier: lowercase, digits and underscores, starting with a letter. The dunder form
# is reserved for the one identifier that names something other than a stored policy.
_POLICY_ID = re.compile(r"^[a-z][a-z0-9_]*$")
_RESERVED_POLICY_ID = re.compile(r"^__[a-z][a-z0-9_]*__$")


class PolicyId(str):
    """A model policy's stable identifier — a validated string, not an enum.

    A ``str`` subclass rather than a wrapper because this value is a database key, a JSON field and
    a log token, and every wrapper would be unwrapped at each of those boundaries. It is frozen in
    the way a ``str`` is: ``__slots__`` is empty, so an instance carries no assignable attribute
    and the value itself cannot change.

    Validation is the point. ``specs/model-policy`` puts policy records under administrative
    control, and an identifier arriving from a request body or a catalog row that turns out to
    contain a quote, a space, or a capital is the kind of thing that is discovered much later and
    somewhere much worse.
    """

    __slots__ = ()

    def __new__(cls, value: str) -> Self:
        text = str(value)
        if not (_POLICY_ID.match(text) or _RESERVED_POLICY_ID.match(text)):
            raise ValueError(
                f"{value!r} is not a policy identifier. A policy id is lowercase letters, digits "
                "and underscores beginning with a letter, such as 'high_reasoning'."
            )
        return super().__new__(cls, text)

    def __repr__(self) -> str:
        return f"PolicyId({str(self)!r})"

    @classmethod
    def __get_pydantic_core_schema__(
        cls, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        """Validate through ``__new__`` wherever this appears on a pydantic model.

        Without this, pydantic cannot build a schema for a plain ``str`` subclass at all. With it,
        a bare string arriving from a database row or a JSON body is validated on the way in rather
        than trusted, and a bad one raises a ``ValidationError`` like any other field.
        """
        return core_schema.no_info_after_validator_function(cls, core_schema.str_schema())

    @property
    def is_reserved(self) -> bool:
        """Whether this names something other than a stored policy record.

        Exactly one identifier does — the configured-fallback indicator. A resolution carrying it
        did not resolve a policy at all, and every aggregate that groups by policy has to be able
        to tell the two apart (``specs/model-policy``: the configured model's use "SHALL be
        recorded as a fallback rather than as a policy resolution").
        """
        return bool(_RESERVED_POLICY_ID.match(self))


# The four shipped policies of `specs/model-policy`. Named because code refers to them by identity
# rather than by string: the administrative one is gated on a role, and the free one is the only
# policy an unauthenticated call may ever resolve.
FREE_DEFAULT_POLICY = PolicyId("free_default")
BALANCED_POLICY = PolicyId("balanced")
HIGH_REASONING_POLICY = PolicyId("high_reasoning")
ADMIN_EXPERIMENTAL_POLICY = PolicyId("admin_experimental")

# The fixed-model evaluation policy of `specs/evaluation`: exactly one candidate, no failover, no
# declared fallback, reachable only by the internal evaluation subject. It exists so that a change
# to a plan, a policy or a candidate pool cannot change what an evaluation run measures.
EVALUATION_FIXED_POLICY = PolicyId("evaluation_fixed")

SHIPPED_POLICY_IDS: tuple[PolicyId, ...] = (
    FREE_DEFAULT_POLICY,
    BALANCED_POLICY,
    HIGH_REASONING_POLICY,
    ADMIN_EXPERIMENTAL_POLICY,
    EVALUATION_FIXED_POLICY,
)

# Not a policy. Recorded as the `policy_id` of a resolution that came from `LLM_MODEL` because no
# policy could be resolved — a development single-model run, or a policy store that could not be
# read. Kept distinguishable from every real policy so an aggregate never reports configuration as
# entitlement.
CONFIGURED_FALLBACK_POLICY = PolicyId("__fallback_config__")

# Not a policy either. Recorded as the `policy_id` of a resolution the model lab pinned, because a
# comparison names its model directly rather than resolving one — `specs/model-lab` compares
# *named* models, and nothing in a lab run may select one. Distinguishable from every real policy
# for the same reason as the line above: an aggregate that counted lab traffic as entitlement
# would report a model as serving a plan it has never been mapped to.
LAB_COMPARISON_POLICY = PolicyId("__lab_comparison__")


class Resolution(BaseModel):
    """What the policy layer decided, and why (design.md decision 22).

    Returned by every resolution and recorded on the usage event and in the evidence record. The
    fields are the answer to three separate questions a reader will have later: *which policy*
    (``policy_id``), *which model actually* (``catalog_key`` with the gateway pair it denotes), and
    *why that one* (``reason``, and ``override_by`` where a person overrode it).

    ``reason`` is not decoration. It carries the ordered walk — which candidates were considered,
    which were skipped and for what, whether a caller's advisory preference was honoured within
    entitlement. Without it, "why did this caller get that model" is only answerable by re-running
    a resolution against catalog state that has since moved on.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    policy_id: PolicyId = Field(
        description="The resolved policy, or the configured-fallback indicator."
    )
    catalog_key: str = Field(
        min_length=1,
        description="The catalog entry that won. The stable internal handle, never a vendor name.",
    )
    gateway_provider: str = Field(
        min_length=1, description="The gateway the catalog row names, as configuration."
    )
    gateway_model: str = Field(
        min_length=1,
        description="The gateway's own model string, copied from the catalog row that won.",
    )
    reason: str = Field(
        min_length=1,
        description="The ordered, human-readable walk: what was considered and why this won.",
    )
    call_role: CallRole = Field(description="The role this resolution was made for.")
    override_by: str | None = Field(
        default=None,
        description="The administrative subject, where an override applied. Otherwise null.",
    )

    @property
    def is_configured_fallback(self) -> bool:
        """Whether the configured model served this, rather than a resolved policy.

        ``specs/model-policy`` requires the two to be distinguishable wherever a resolution is
        recorded, because presenting configuration as entitlement would misreport what a caller is
        actually entitled to.
        """
        return self.policy_id == CONFIGURED_FALLBACK_POLICY

    @property
    def was_overridden(self) -> bool:
        """Whether an administrative principal named this model rather than the policy walking."""
        return self.override_by is not None
