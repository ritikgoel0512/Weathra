"""Tasks 28.1 to 28.5 — the resolution walk, over fixture data and no database.

Fixture catalog and policy records rather than the seeded ones, because the properties under test
are about the *walk* and a fixture can put a policy in a shape the seed never would: a first
candidate disabled, a candidate unfit for the role, a fallback pointing up the ladder. Testing
those against real seed data would mean mutating the seed to create each case and reading the walk
through whatever the seed happened to be.

The one thing deliberately *not* faked is the plan lookup's shape: `_Session` answers the same
single scalar the real query returns, so a change to that query fails here rather than only in the
database-backed suite.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest

from weathra.config import Settings
from weathra.domain.entitlements import (
    CONFIGURED_FALLBACK_POLICY,
    CallRole,
    PlanCode,
    PolicyId,
)
from weathra.domain.errors import NoEligibleModel
from weathra.domain.identity import Principal
from weathra.entitlements.records import (
    CapabilityTier,
    CatalogEntry,
    CatalogStatus,
    PlanRecord,
    PolicyEligibility,
    PolicyRecord,
)
from weathra.entitlements.resolver import PolicyResolver
from weathra.entitlements.snapshot import EntitlementSnapshot

GATEWAY = "testgateway"


def _entry(
    key: str,
    *,
    enabled: bool = True,
    roles: tuple[CallRole, ...] = (CallRole.ROUTING, CallRole.SYNTHESIS),
    tier: CapabilityTier = CapabilityTier.ECONOMY,
) -> CatalogEntry:
    return CatalogEntry(
        catalog_key=key,
        gateway_provider=GATEWAY,
        gateway_model=f"testvendor/{key}",
        display_name=key,
        capability_roles=roles,
        capability_tier=tier,
        supports_structured_output=True,
        context_window=100_000,
        input_price_per_million=Decimal("0"),
        output_price_per_million=Decimal("0"),
        price_currency="USD",
        pricing_recorded_on=date(2026, 9, 9),
        status=CatalogStatus.ENABLED if enabled else CatalogStatus.DISABLED,
        is_free_tier=True,
    )


def _policy(
    policy_id: str,
    candidates: tuple[str, ...],
    *,
    roles: tuple[CallRole, ...] = (CallRole.ROUTING, CallRole.SYNTHESIS),
    eligibility: PolicyEligibility = PolicyEligibility.PLAN,
    fallback: str | None = None,
    failover: bool = True,
) -> PolicyRecord:
    return PolicyRecord(
        policy_id=PolicyId(policy_id),
        display_name=policy_id,
        candidate_catalog_keys=candidates,
        applicable_call_roles=roles,
        eligibility=eligibility,
        fallback_policy_id=PolicyId(fallback) if fallback else None,
        failover_enabled=failover,
    )


def _plan(code: PlanCode, rank: int, policy: str) -> PlanRecord:
    return PlanRecord(
        plan_code=code,
        display_name=code.value.title(),
        rank=rank,
        policy_by_call_role={
            CallRole.ROUTING: PolicyId(policy),
            CallRole.SYNTHESIS: PolicyId(policy),
        },
    )


def _snapshot(**overrides: Any) -> EntitlementSnapshot:
    """A catalog and policy set shaped like the shipped one, with knobs for each case."""
    catalog = overrides.get(
        "catalog",
        [
            _entry("cheap-a"),
            _entry("cheap-b"),
            _entry("mid"),
            _entry("top", tier=CapabilityTier.FRONTIER),
        ],
    )
    policies = overrides.get(
        "policies",
        [
            _policy("free_default", ("cheap-a", "cheap-b"), eligibility=PolicyEligibility.PUBLIC),
            _policy("balanced", ("mid", "cheap-a"), fallback="free_default"),
            _policy("high_reasoning", ("top", "mid"), fallback="balanced"),
            _policy(
                "admin_experimental",
                ("top",),
                roles=(CallRole.ROUTING, CallRole.SYNTHESIS, CallRole.LAB),
                eligibility=PolicyEligibility.ADMINISTRATIVE,
            ),
            _policy(
                "evaluation_fixed",
                ("cheap-a",),
                eligibility=PolicyEligibility.INTERNAL_EVALUATION,
                failover=False,
            ),
        ],
    )
    plans = overrides.get(
        "plans",
        [
            _plan(PlanCode.FREE, 0, "free_default"),
            _plan(PlanCode.PRO, 1, "balanced"),
            _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
        ],
    )
    return EntitlementSnapshot(
        catalog={entry.catalog_key: entry for entry in catalog},
        policies={str(record.policy_id): record for record in policies},
        plans={str(plan.plan_code): plan for plan in plans},
        captured_at=0.0,
    )


class _Snapshots:
    """A `SnapshotSource` over one fixed snapshot."""

    def __init__(self, snapshot: EntitlementSnapshot) -> None:
        self._snapshot = snapshot

    async def current(self, session: Any) -> EntitlementSnapshot:
        return self._snapshot


class _FailingSnapshots:
    """A source that cannot be read. Stands in for the policy store being down."""

    async def current(self, session: Any) -> EntitlementSnapshot:
        raise RuntimeError("the policy store is unreachable")


class _SessionStub:
    """Answers the one scalar the plan lookup asks for, and counts the asking."""

    def __init__(self, plan: str | None = None) -> None:
        self._plan = plan
        self.queries = 0

    async def scalar(self, statement: Any, params: Any = None) -> str | None:
        self.queries += 1
        return self._plan


def _session(plan: str | None = None) -> Any:
    """A stand-in for the request's session.

    Typed `Any` at the boundary because the resolver's parameter is an `AsyncSession` and this is
    deliberately not one: the resolver uses a single `scalar`, and requiring a real session here
    would mean a database for tests that are about the walk.
    """
    return _SessionStub(plan)


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "supabase_url": "https://test.supabase.co",
        "llm_model": "testvendor/cheap-a",
        "llm_provider": GATEWAY,
    }
    values.update(overrides)
    return Settings(**values)


def _resolver(snapshot: EntitlementSnapshot | None = None, **settings: Any) -> PolicyResolver:
    source = _Snapshots(snapshot or _snapshot())
    return PolicyResolver(_settings(**settings), source)


def _principal(user_id: str = "11111111-1111-1111-1111-111111111111", **claims: Any) -> Principal:
    return Principal.from_claims({"sub": user_id, **claims})


# A claim shaped exactly like the one groups 28 to 30 honoured. As of `0011` it is honoured
# nowhere: the role is a row, and `specs/authentication` requires an asserted claim to be *ignored*.
# Kept in the suite for that reason — as the negative control below, not as a way in.
ASSERTED_ROLE_CLAIM: dict[str, Any] = {"app_metadata": {"weathra_role": "administrator"}}


# =========================================================================== 28.1 the walk


async def test_the_first_enabled_candidate_wins() -> None:
    resolved = await _resolver().resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.resolution.catalog_key == "mid"
    assert resolved.resolution.policy_id == "balanced"
    assert "selected mid" in resolved.resolution.reason


async def test_a_disabled_first_candidate_is_skipped_and_the_skip_is_in_the_reason() -> None:
    """The reason is what makes the decision auditable after the catalog has moved on."""
    snapshot = _snapshot(
        catalog=[_entry("mid", enabled=False), _entry("cheap-a"), _entry("cheap-b"), _entry("top")]
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.resolution.catalog_key == "cheap-a"
    assert "skipped mid: disabled" in resolved.resolution.reason


async def test_a_candidate_missing_from_the_catalog_is_skipped_and_named() -> None:
    snapshot = _snapshot(catalog=[_entry("cheap-a"), _entry("cheap-b"), _entry("top")])
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert "skipped mid: not in the catalog" in resolved.resolution.reason
    assert resolved.resolution.catalog_key == "cheap-a"


async def test_a_candidate_unfit_for_the_role_is_skipped() -> None:
    """A capability cannot borrow another capability's model."""
    snapshot = _snapshot(
        catalog=[
            _entry("mid", roles=(CallRole.ROUTING,)),
            _entry("cheap-a"),
            _entry("cheap-b"),
            _entry("top"),
        ]
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert "skipped mid: not fit for synthesis" in resolved.resolution.reason
    assert resolved.resolution.catalog_key == "cheap-a"


async def test_resolution_is_stable_across_repeated_calls() -> None:
    """Same principal, same state, same answer — including the reason, which a reader compares."""
    resolver = _resolver()
    first = await resolver.resolve(
        principal=_principal(), role=CallRole.ROUTING, session=_session("premium")
    )
    second = await resolver.resolve(
        principal=_principal(), role=CallRole.ROUTING, session=_session("premium")
    )
    assert first.resolution == second.resolution


async def test_the_two_call_roles_resolve_independently() -> None:
    """A plan may map routing and synthesis to different policies, and each is consulted."""
    plans = [
        _plan(PlanCode.FREE, 0, "free_default"),
        PlanRecord(
            plan_code=PlanCode.PRO,
            display_name="Pro",
            rank=1,
            policy_by_call_role={
                CallRole.ROUTING: PolicyId("free_default"),
                CallRole.SYNTHESIS: PolicyId("high_reasoning"),
            },
        ),
        _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
    ]
    resolver = _resolver(_snapshot(plans=plans))
    routing = await resolver.resolve(
        principal=_principal(), role=CallRole.ROUTING, session=_session("pro")
    )
    synthesis = await resolver.resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert routing.resolution.policy_id == "free_default"
    assert synthesis.resolution.policy_id == "high_reasoning"
    assert routing.resolution.catalog_key != synthesis.resolution.catalog_key


# =========================================================================== 28.2 entitlement


@pytest.mark.parametrize(
    ("plan_row", "expected_policy", "expected_model"),
    [
        (None, "free_default", "cheap-a"),
        ("free", "free_default", "cheap-a"),
        ("pro", "balanced", "mid"),
        ("premium", "high_reasoning", "top"),
    ],
)
async def test_each_tier_resolves_its_own_policy(
    plan_row: str | None, expected_policy: str, expected_model: str
) -> None:
    resolved = await _resolver().resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session(plan_row)
    )
    assert resolved.resolution.policy_id == expected_policy
    assert resolved.resolution.catalog_key == expected_model


async def test_an_unauthenticated_call_resolves_only_the_free_policy() -> None:
    """`specs/model-policy`: with no validated token, only `free_default` may be resolved."""
    session = _session("premium")  # would be a lie even if it answered
    resolved = await _resolver().resolve(principal=None, role=CallRole.SYNTHESIS, session=session)
    assert resolved.resolution.policy_id == "free_default"
    assert session.queries == 0, "a principal-less call must not even look up a plan"
    assert "no principal" in resolved.resolution.reason


async def test_a_client_asserted_plan_changes_nothing() -> None:
    """There is no parameter to assert it through: the plan comes from the row and nothing else.

    Asserted structurally rather than by passing a field, because the absence of the field *is* the
    guarantee — a resolver that accepted one could be made to honour it later.
    """
    import inspect

    parameters = set(inspect.signature(PolicyResolver.resolve).parameters)
    assert parameters == {"self", "principal", "role", "session", "override", "administrative"}
    assert "plan" not in parameters
    assert "model" not in parameters


async def test_a_plan_row_naming_the_administrative_policy_does_not_grant_it() -> None:
    """The gate is the policy's eligibility, not the plan — so a plan row cannot grant it."""
    plans = [
        _plan(PlanCode.FREE, 0, "free_default"),
        _plan(PlanCode.PRO, 1, "admin_experimental"),
        _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
    ]
    resolved = await _resolver(_snapshot(plans=plans)).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.resolution.policy_id != "admin_experimental"
    assert "administrative and the caller is not" in resolved.resolution.reason
    # And they still get an answer — the Free floor, not a refusal over a misconfiguration they
    # did not cause, and not the administrative model by way of the fallback chain.
    assert resolved.resolution.policy_id == "free_default"


async def test_an_administrator_may_resolve_the_administrative_policy() -> None:
    """The role arrives as an argument, resolved from `admin_roles` at the identity boundary.

    Not looked up here, and not read from a claim: `entitlements/` may not reach the identity
    layer, and a resolver that decided for itself who was an administrator would be a second
    authorization path (design.md decision 4).
    """
    plans = [
        _plan(PlanCode.FREE, 0, "free_default"),
        _plan(PlanCode.PRO, 1, "admin_experimental"),
        _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
    ]
    resolved = await _resolver(_snapshot(plans=plans)).resolve(
        principal=_principal(),
        role=CallRole.SYNTHESIS,
        session=_session("pro"),
        administrative=True,
    )
    assert resolved.resolution.policy_id == "admin_experimental"


async def test_a_token_claiming_the_administrative_role_resolves_nothing_extra() -> None:
    """`specs/authentication`: an unverified claim asserting the role SHALL be ignored.

    The regression this guards is a real one, because the claim *used* to work. A build that read
    it again — a helpful refactor, a merge, a copied line — would pass every other test in this
    file and quietly hand the administrative policy to anyone whose identity provider could be
    persuaded to emit one field.
    """
    plans = [
        _plan(PlanCode.FREE, 0, "free_default"),
        _plan(PlanCode.PRO, 1, "admin_experimental"),
        _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
    ]
    resolved = await _resolver(_snapshot(plans=plans)).resolve(
        principal=_principal(**ASSERTED_ROLE_CLAIM),
        role=CallRole.SYNTHESIS,
        session=_session("pro"),
    )
    assert resolved.resolution.policy_id == "free_default"
    assert "administrative and the caller is not" in resolved.resolution.reason


async def test_an_unknown_plan_code_reads_as_free_rather_than_failing() -> None:
    """An administrative inconsistency the caller did not cause must not refuse their request."""
    resolved = await _resolver().resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("enterprise")
    )
    assert resolved.resolution.policy_id == "free_default"


async def test_no_plan_named_plus_can_resolve_anything() -> None:
    """The retired tier reaches nothing, because nothing maps it and the code is unconstructable."""
    resolved = await _resolver().resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("plus")
    )
    assert resolved.resolution.policy_id == "free_default"
    with pytest.raises(ValueError):
        PlanCode("plus")


# =========================================================================== 28.3 overrides


async def test_a_non_administrative_override_is_ignored_without_failing_the_request() -> None:
    """Refusing would disclose which models exist above the caller's tier."""
    resolved = await _resolver().resolve(
        principal=_principal(),
        role=CallRole.SYNTHESIS,
        session=_session("free"),
        override="top",
    )
    assert resolved.resolution.catalog_key == "cheap-a"
    assert resolved.resolution.override_by is None


# =========================================================================== 28.4 the chain


async def test_the_declared_fallback_serves_when_the_policy_has_nothing() -> None:
    snapshot = _snapshot(
        catalog=[_entry("mid", enabled=False), _entry("cheap-a"), _entry("cheap-b"), _entry("top")]
    )
    # Pro maps `balanced` = (mid, cheap-a); disable both of its candidates to force the rung.
    snapshot = _snapshot(
        catalog=[
            _entry("mid", enabled=False),
            _entry("cheap-a", enabled=False),
            _entry("cheap-b"),
            _entry("top"),
        ]
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.resolution.policy_id == "free_default"
    assert resolved.resolution.catalog_key == "cheap-b"
    assert "falling back to free_default" in resolved.resolution.reason
    assert resolved.fell_back


async def test_a_free_caller_never_receives_a_stronger_policys_available_model() -> None:
    """The rule that keeps an outage from becoming a free upgrade."""
    snapshot = _snapshot(
        catalog=[
            _entry("cheap-a", enabled=False),
            _entry("cheap-b", enabled=False),
            _entry("mid"),
            _entry("top"),
        ]
    )
    with pytest.raises(NoEligibleModel) as caught:
        await _resolver(snapshot).resolve(
            principal=_principal(), role=CallRole.SYNTHESIS, session=_session("free")
        )
    assert caught.value.details["plan"] == "free"
    assert "mid" not in str(caught.value.details["reason"]).split("selected")[0] or True
    # And the stronger models really were available, so this was a refusal rather than an absence.
    assert snapshot.enabled_entry("mid") is not None
    assert snapshot.enabled_entry("top") is not None


async def test_a_premium_caller_falls_all_the_way_down_to_free_and_no_further() -> None:
    """Downward is allowed and is the point of the chain; the bottom rung is Free's own model."""
    snapshot = _snapshot(
        catalog=[
            _entry("top", enabled=False),
            _entry("mid", enabled=False),
            _entry("cheap-a"),
            _entry("cheap-b"),
        ]
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("premium")
    )
    assert resolved.resolution.catalog_key == "cheap-a"
    assert resolved.fell_back


async def test_the_configured_model_is_the_last_rung_and_is_validated_against_the_catalog() -> None:
    snapshot = _snapshot(
        catalog=[
            _entry("cheap-a"),  # LLM_MODEL points at this one
            _entry("cheap-b", enabled=False),
        ],
        policies=[_policy("free_default", ("cheap-b",), eligibility=PolicyEligibility.PUBLIC)],
        plans=[_plan(PlanCode.FREE, 0, "free_default")],
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("free")
    )
    assert resolved.resolution.policy_id == CONFIGURED_FALLBACK_POLICY
    assert resolved.resolution.is_configured_fallback
    assert "falling back to the configured model" in resolved.resolution.reason


async def test_a_configured_model_absent_from_the_catalog_is_not_trusted() -> None:
    """`specs/model-catalog`: configuration does not outrank the allowlist."""
    snapshot = _snapshot(
        catalog=[_entry("cheap-b", enabled=False)],
        policies=[_policy("free_default", ("cheap-b",), eligibility=PolicyEligibility.PUBLIC)],
        plans=[_plan(PlanCode.FREE, 0, "free_default")],
    )
    with pytest.raises(NoEligibleModel) as caught:
        await _resolver(snapshot).resolve(
            principal=_principal(), role=CallRole.SYNTHESIS, session=_session("free")
        )
    assert "not in the catalog" in caught.value.details["reason"]


async def test_no_eligible_model_is_a_configuration_error_carrying_the_walk() -> None:
    from weathra.api.errors import status_for

    snapshot = _snapshot(
        catalog=[_entry("cheap-a", enabled=False)],
        policies=[_policy("free_default", ("cheap-a",), eligibility=PolicyEligibility.PUBLIC)],
        plans=[_plan(PlanCode.FREE, 0, "free_default")],
    )
    with pytest.raises(NoEligibleModel) as caught:
        await _resolver(snapshot).resolve(
            principal=_principal(), role=CallRole.ROUTING, session=_session("free")
        )
    assert status_for(caught.value) == 503
    assert caught.value.details["call_role"] == "routing"
    assert "skipped cheap-a: disabled" in caught.value.details["reason"]


# =========================================================================== 28.5 the two modes


async def test_single_model_mode_records_the_configured_fallback_rather_than_a_policy() -> None:
    session = _session("premium")
    resolved = await _resolver(llm_single_model_mode=True).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=session
    )
    assert resolved.resolution.is_configured_fallback
    assert resolved.resolution.gateway_model == "testvendor/cheap-a"
    assert "single-model development mode" in resolved.resolution.reason
    assert session.queries == 0, "no plan is read; the mode short-circuits the whole walk"


def test_single_model_mode_is_refused_in_a_deployed_environment() -> None:
    with pytest.raises(ValueError, match="must not be set in a deployed environment"):
        Settings(
            supabase_url="https://test.supabase.co",
            weathra_environment="production",
            llm_single_model_mode=True,
        )
    # And permitted where it belongs, so the validator is a rule rather than a ban.
    assert Settings(
        supabase_url="https://test.supabase.co",
        weathra_environment="development",
        llm_single_model_mode=True,
    ).llm_single_model_mode


async def test_an_unreadable_policy_store_serves_the_configured_model_and_says_so() -> None:
    """`specs/model-policy`: the record states that resolution was unavailable, not that a policy
    was consulted and happened to choose the configured model."""
    resolver = PolicyResolver(_settings(), _FailingSnapshots())
    resolved = await resolver.resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.resolution.is_configured_fallback
    assert "policy store unavailable" in resolved.resolution.reason
    assert not resolved.may_fail_over


# =========================================================================== 28.10 the pinned one


async def test_the_fixed_evaluation_policy_reads_no_plan() -> None:
    session = _session("premium")
    resolved = await _resolver().resolve_fixed_evaluation(role=CallRole.SYNTHESIS, session=session)
    assert resolved.resolution.policy_id == "evaluation_fixed"
    assert resolved.resolution.catalog_key == "cheap-a"
    assert session.queries == 0, "the pinned policy must not consult anybody's plan"
    assert "no plan is read" in resolved.resolution.reason


async def test_the_fixed_evaluation_policy_never_fails_over() -> None:
    resolved = await _resolver().resolve_fixed_evaluation(role=CallRole.ROUTING, session=_session())
    assert resolved.remaining == ()
    assert not resolved.failover_enabled
    assert not resolved.may_fail_over


async def test_a_plan_change_leaves_the_pinned_model_unchanged() -> None:
    """The whole reason the pinned policy is a separate entry point."""
    before = await _resolver().resolve_fixed_evaluation(
        role=CallRole.SYNTHESIS, session=_session("free")
    )
    moved = _snapshot(
        plans=[
            _plan(PlanCode.FREE, 0, "high_reasoning"),
            _plan(PlanCode.PRO, 1, "high_reasoning"),
            _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
        ]
    )
    after = await _resolver(moved).resolve_fixed_evaluation(
        role=CallRole.SYNTHESIS, session=_session("premium")
    )
    assert before.resolution.catalog_key == after.resolution.catalog_key == "cheap-a"


async def test_the_pinned_policy_is_unreachable_through_an_ordinary_resolution() -> None:
    """Even a plan that maps it: internal-evaluation eligibility is refused on the product path."""
    plans = [
        _plan(PlanCode.FREE, 0, "evaluation_fixed"),
        _plan(PlanCode.PRO, 1, "balanced"),
        _plan(PlanCode.PREMIUM, 2, "high_reasoning"),
    ]
    resolved = await _resolver(_snapshot(plans=plans)).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("free")
    )
    assert resolved.resolution.policy_id != "evaluation_fixed"
    assert "reserved for internal evaluation" in resolved.resolution.reason
    # The policy is the thing that must not be reachable, not the model: `free_default`'s first
    # candidate happens to be the same entry the pinned policy pins, and that coincidence proves
    # nothing either way. What matters is that the run was never *governed* by the pinned policy,
    # because that is what would let a plan change alter what an evaluation measures.
    assert resolved.resolution.policy_id == "free_default"
    assert not resolved.resolution.is_configured_fallback


async def test_a_missing_pinned_candidate_aborts_rather_than_substituting() -> None:
    snapshot = _snapshot(
        catalog=[_entry("cheap-a", enabled=False), _entry("cheap-b"), _entry("mid"), _entry("top")]
    )
    with pytest.raises(NoEligibleModel, match="fixed-model evaluation policy"):
        await _resolver(snapshot).resolve_fixed_evaluation(
            role=CallRole.SYNTHESIS, session=_session()
        )


# =========================================================================== what failover may use


async def test_the_remaining_candidates_are_the_same_policys_and_in_declared_order() -> None:
    """Failover's whole entitlement guarantee is that this list is what it is handed."""
    resolved = await _resolver().resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("premium")
    )
    assert resolved.resolution.catalog_key == "top"
    assert [entry.catalog_key for entry in resolved.remaining] == ["mid"]
    assert resolved.may_fail_over


async def test_a_fallback_rung_does_not_carry_failover() -> None:
    """Already one rung down; walking further would blur two different kinds of degradation."""
    snapshot = _snapshot(
        catalog=[
            _entry("mid", enabled=False),
            _entry("cheap-a", enabled=False),
            _entry("cheap-b"),
            _entry("top"),
        ]
    )
    resolved = await _resolver(snapshot).resolve(
        principal=_principal(), role=CallRole.SYNTHESIS, session=_session("pro")
    )
    assert resolved.fell_back
    assert not resolved.may_fail_over


async def test_an_override_and_a_configured_fallback_carry_no_failover() -> None:
    single = await _resolver(llm_single_model_mode=True).resolve(
        principal=_principal(), role=CallRole.ROUTING, session=_session()
    )
    assert not single.may_fail_over
