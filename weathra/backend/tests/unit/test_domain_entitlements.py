"""Task 26.1 — the entitlement vocabulary, and the one tier name that must not come back.

Three properties, in descending order of how expensive getting them wrong would be:

1. **The canonical plan codes are ``free``, ``pro``, ``premium`` and nothing else.** An earlier
   draft of the specs named the middle tier ``plus``; the product decision of 2026-09-09 replaced
   it and the specs were reconciled. A plan code reaches recorded usage events, `user_plans` rows
   and — later — an external billing product, so reintroducing a second name for a tier would mean
   two names to reconcile in data that is already written. The test below fails on ``plus``
   appearing anywhere in the enum, in either case, as a value or as a member name.
2. **Every type here is frozen.** These travel through the resolver, the telemetry writer and the
   evidence record; one of them being mutable would make "what served this call" a thing that can
   change after the fact.
3. **A policy identifier is validated, and open.** Policies are data — the whole point of the
   layer is that a new one is a row — so the type admits any well-formed identifier and refuses a
   malformed one.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from weathra.domain import entitlements as ent

# Every spelling of the retired tier a careless reintroduction would use.
RETIRED_TIER_SPELLINGS = ("plus", "PLUS", "Plus", "plus_tier", "weathra_plus")


# =========================================================================== plan codes


def test_the_canonical_plan_codes_are_free_pro_premium() -> None:
    assert [plan.value for plan in ent.PlanCode] == ["free", "pro", "premium"]


def test_the_product_plans_are_ordered_by_ascending_entitlement() -> None:
    """`specs/model-policy` forbids escalating above the caller's entitlement, which needs an
    order. A set would not have one."""
    assert ent.PRODUCT_PLAN_CODES == (ent.PlanCode.FREE, ent.PlanCode.PRO, ent.PlanCode.PREMIUM)


@pytest.mark.parametrize("spelling", RETIRED_TIER_SPELLINGS)
def test_no_plan_code_is_the_retired_plus_tier(spelling: str) -> None:
    """The regression guard. There is no `plus` tier and no alias to one, in either direction."""
    values = {plan.value.lower() for plan in ent.PlanCode}
    names = {plan.name.lower() for plan in ent.PlanCode}
    assert spelling.lower() not in values
    assert spelling.lower() not in names


@pytest.mark.parametrize("spelling", RETIRED_TIER_SPELLINGS)
def test_the_retired_tier_is_not_resolvable_as_a_plan_code(spelling: str) -> None:
    """Not merely absent from the listing — unconstructable, so no alias can be added quietly."""
    with pytest.raises(ValueError):
        ent.PlanCode(spelling)


def test_plan_codes_are_lowercase_identifiers() -> None:
    """They are persisted keys, so a capital would be a migration to fix rather than a rename."""
    for plan in ent.PlanCode:
        assert plan.value == plan.value.lower()
        assert plan.value.isalpha()


# =========================================================================== call roles


def test_the_call_roles_are_routing_synthesis_and_lab() -> None:
    assert {role.value for role in ent.CallRole} == {"routing", "synthesis", "lab"}


@pytest.mark.parametrize("invalid", ["", "planner", "ROUTING", "synthesis "])
def test_an_unknown_call_role_is_refused(invalid: str) -> None:
    with pytest.raises(ValueError):
        ent.CallRole(invalid)


# =========================================================================== policy identifiers


@pytest.mark.parametrize(
    "identifier", ["free_default", "balanced", "high_reasoning", "admin_experimental", "policy2"]
)
def test_a_well_formed_policy_identifier_is_accepted(identifier: str) -> None:
    assert ent.PolicyId(identifier) == identifier


@pytest.mark.parametrize(
    "identifier",
    ["", "Free_Default", "free-default", "2fast", "free default", "free;drop", "_leading"],
)
def test_a_malformed_policy_identifier_is_refused(identifier: str) -> None:
    with pytest.raises(ValueError, match="not a policy identifier"):
        ent.PolicyId(identifier)


def test_a_policy_identifier_is_immutable() -> None:
    """A ``str`` subclass with empty ``__slots__``: nothing can be attached to it or changed."""
    policy = ent.PolicyId("balanced")
    with pytest.raises(AttributeError):
        policy.value = "high_reasoning"  # type: ignore[attr-defined]


def test_the_shipped_policies_are_the_four_named_plus_the_pinned_evaluation_one() -> None:
    assert set(ent.SHIPPED_POLICY_IDS) == {
        "free_default",
        "balanced",
        "high_reasoning",
        "admin_experimental",
        "evaluation_fixed",
    }


def test_the_configured_fallback_indicator_is_not_a_policy() -> None:
    """`specs/model-policy`: the configured model's use is recorded as a fallback rather than as a
    policy resolution, so an aggregate can never report configuration as entitlement."""
    assert ent.CONFIGURED_FALLBACK_POLICY.is_reserved
    assert ent.CONFIGURED_FALLBACK_POLICY not in ent.SHIPPED_POLICY_IDS
    for policy in ent.SHIPPED_POLICY_IDS:
        assert not policy.is_reserved


# =========================================================================== resolution


def _resolution(**overrides: object) -> ent.Resolution:
    fields: dict[str, object] = {
        "policy_id": ent.FREE_DEFAULT_POLICY,
        "catalog_key": "economy-free-primary",
        "gateway_provider": "openrouter",
        "gateway_model": "vendor/model:free",
        "reason": "first enabled candidate of free_default",
        "call_role": ent.CallRole.SYNTHESIS,
    }
    fields.update(overrides)
    return ent.Resolution(**fields)


def test_a_resolution_is_frozen() -> None:
    resolution = _resolution()
    with pytest.raises(ValidationError):
        resolution.catalog_key = "frontier-reasoning"  # type: ignore[misc]


def test_a_resolution_refuses_an_unknown_field() -> None:
    """``extra='forbid'``: a misspelled field would otherwise be silently dropped, and the
    resolution would claim less than the caller thought it recorded."""
    with pytest.raises(ValidationError):
        _resolution(gateway_modle="vendor/model")


@pytest.mark.parametrize(
    "blank_field", ["catalog_key", "gateway_provider", "gateway_model", "reason"]
)
def test_a_resolution_refuses_a_blank_required_field(blank_field: str) -> None:
    with pytest.raises(ValidationError):
        _resolution(**{blank_field: ""})


def test_a_resolution_validates_a_bare_policy_identifier_at_the_boundary() -> None:
    """A row read back out of the database arrives as ``str``; it is validated, not trusted."""
    assert _resolution(policy_id="balanced").policy_id == ent.BALANCED_POLICY
    with pytest.raises(ValidationError):
        _resolution(policy_id="Not A Policy")


def test_a_configured_fallback_resolution_reports_itself_as_one() -> None:
    assert _resolution(policy_id=ent.CONFIGURED_FALLBACK_POLICY).is_configured_fallback
    assert not _resolution().is_configured_fallback


def test_an_override_is_recorded_with_the_principal_that_applied_it() -> None:
    """`specs/model-policy` requires an override to be recorded *as* an override and named."""
    plain = _resolution()
    assert not plain.was_overridden and plain.override_by is None

    overridden = _resolution(override_by="11111111-1111-1111-1111-111111111111")
    assert overridden.was_overridden
    assert overridden.override_by == "11111111-1111-1111-1111-111111111111"
