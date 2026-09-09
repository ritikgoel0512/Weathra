"""Tasks 27.1 and 27.2 — the catalog, policy, plan and allowance repositories.

The reads are exercised because the snapshot and the resolver will depend on their exact shape;
the refusals are exercised because they *are* the requirements. ``specs/model-catalog`` and
``specs/usage-limits`` both describe their administrative surfaces almost entirely in terms of what
must be refused, and a repository that accepted a negative price would satisfy every read test.

Two properties get more attention than the rest:

* **The last-model-for-a-role refusal.** No CHECK constraint can express it — it is a statement
  about the catalog and the policies together — so this layer is the only thing that enforces it,
  and it is tested with the acknowledgement and without.
* **The dangling reference.** ``specs/model-policy`` requires a policy naming a missing catalog key
  to be refused *at write time*. PostgreSQL cannot: the candidates are an ordered `text[]`. Without
  this check the typo is found by the first request that walks the list.

Every write runs under the privileged session, because that is the only connection these tables
grant writes to. Tests that assert the *restricted* role cannot write them live in
`test_saas_rls.py`, where the rest of the isolation lives.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import new_user_id
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.errors import (
    ModelRoleWouldBeUnavailable,
    RecordNotFound,
    ValidationFailed,
)
from weathra.domain.usage import QuotaDimension
from weathra.entitlements.audit import recorded_changes
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.policies import PolicyStore
from weathra.entitlements.records import (
    AdminAction,
    CapabilityTier,
    CatalogStatus,
    PolicyEligibility,
)

pytestmark = pytest.mark.db

ADMIN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

# A catalog entry that is valid in every respect, so a test can make exactly one thing wrong.
# The gateway strings here are deliberately fictional: this is test data, and naming a real vendor
# model would put one in application-adjacent source for the confinement test to find.
VALID_ENTRY: dict[str, Any] = {
    "catalog_key": "test-economy-alpha",
    "gateway_provider": "testgateway",
    "gateway_model": "testvendor/alpha-1",
    "display_name": "Test economy alpha",
    "capability_roles": (CallRole.ROUTING, CallRole.SYNTHESIS),
    "capability_tier": CapabilityTier.ECONOMY,
    "supports_structured_output": True,
    "context_window": 128_000,
    "input_price_per_million": Decimal("0.10"),
    "output_price_per_million": Decimal("0.40"),
    "pricing_recorded_on": date(2026, 9, 9),
    "is_free_tier": False,
}


@pytest.fixture
async def catalog(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> AsyncIterator[CatalogStore]:
    """A privileged session over the seeded catalog.

    ``seeded_reference_data`` is what makes these tests safe to write: they disable models, narrow
    capability roles and add entries, and every one of those changes is put back afterwards. The
    four seeded tables survive ``clean_database`` on purpose, so without it a test that reordered a
    candidate list would silently change what every later test was asserting against.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        yield CatalogStore(session)


@pytest.fixture
async def stores(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> AsyncIterator[tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession]]:
    """Catalog, policy and plan stores sharing one privileged transaction."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        yield CatalogStore(session), PolicyStore(session), PlanStore(session), session


# =========================================================================== 27.1 catalog reads


async def test_the_seeded_catalog_reads_back_with_every_field(catalog: CatalogStore) -> None:
    entry = await catalog.require("economy-free-primary")
    assert entry.catalog_key == "economy-free-primary"
    assert entry.gateway_provider and entry.gateway_model
    assert entry.capability_roles
    assert entry.context_window > 0
    assert entry.input_price_per_million >= 0
    assert entry.price_currency == "USD"
    assert entry.is_enabled


async def test_an_unknown_catalog_key_reads_as_absent_and_requires_as_not_found(
    catalog: CatalogStore,
) -> None:
    assert await catalog.get("no-such-entry") is None
    with pytest.raises(RecordNotFound, match="no-such-entry"):
        await catalog.require("no-such-entry")


async def test_the_catalog_lists_filtered_by_status_and_by_capability_role(
    catalog: CatalogStore,
) -> None:
    """`specs/model-catalog`: listable filtered by status and by capability role."""
    everything = await catalog.list()
    enabled = await catalog.list(status=CatalogStatus.ENABLED)
    assert enabled and set(enabled) <= set(everything)
    assert all(entry.is_enabled for entry in enabled)

    routing = await catalog.list(capability_role=CallRole.ROUTING)
    assert routing
    assert all(entry.serves(CallRole.ROUTING) for entry in routing)


async def test_a_disabled_entry_is_still_readable_but_leaves_the_enabled_set(
    catalog: CatalogStore,
) -> None:
    """Disabling changes availability, not existence — history must stay attributable."""
    await catalog.disable("standard-general", acting_principal=ADMIN)

    entry = await catalog.require("standard-general")
    assert entry.status is CatalogStatus.DISABLED

    enabled = {item.catalog_key for item in await catalog.list(status=CatalogStatus.ENABLED)}
    assert "standard-general" not in enabled
    assert "standard-general" in {item.catalog_key for item in await catalog.list()}


# =========================================================================== 27.1 catalog writes


async def test_a_valid_entry_is_created_and_recorded(catalog: CatalogStore) -> None:
    created = await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    assert created.catalog_key == "test-economy-alpha"
    assert created.is_enabled

    audit = await recorded_changes(
        catalog._session, subject_kind="model_catalog", subject_id="test-economy-alpha"
    )
    assert [entry.action for entry in audit] == [AdminAction.CATALOG_CREATE]
    assert audit[0].acting_principal == ADMIN
    assert audit[0].after is not None and audit[0].after["gateway_model"] == "testvendor/alpha-1"


async def test_a_duplicate_catalog_key_is_refused(catalog: CatalogStore) -> None:
    await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    with pytest.raises(ValidationFailed, match="already exists") as caught:
        await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    assert caught.value.details["field"] == "catalog_key"


async def test_a_duplicate_gateway_provider_and_model_pair_is_refused(
    catalog: CatalogStore,
) -> None:
    await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    with pytest.raises(ValidationFailed, match="already points at that gateway") as caught:
        await catalog.create(
            acting_principal=ADMIN, **{**VALID_ENTRY, "catalog_key": "test-economy-beta"}
        )
    assert caught.value.details["conflicting_catalog_key"] == "test-economy-alpha"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("input_price_per_million", Decimal("-0.01")),
        ("output_price_per_million", Decimal("-1")),
    ],
)
async def test_a_negative_price_is_refused_naming_the_field(
    catalog: CatalogStore, field: str, value: Decimal
) -> None:
    with pytest.raises(ValidationFailed, match="must not be negative") as caught:
        await catalog.create(acting_principal=ADMIN, **{**VALID_ENTRY, field: value})
    assert caught.value.details["field"] == field


@pytest.mark.parametrize("window", [0, -1])
async def test_a_non_positive_context_window_is_refused(catalog: CatalogStore, window: int) -> None:
    with pytest.raises(ValidationFailed, match="positive number of tokens") as caught:
        await catalog.create(acting_principal=ADMIN, **{**VALID_ENTRY, "context_window": window})
    assert caught.value.details["field"] == "context_window"


async def test_an_entry_with_no_capability_role_is_refused(catalog: CatalogStore) -> None:
    with pytest.raises(ValidationFailed, match="at least one capability role") as caught:
        await catalog.create(acting_principal=ADMIN, **{**VALID_ENTRY, "capability_roles": ()})
    assert caught.value.details["field"] == "capability_roles"


async def test_a_missing_pricing_date_is_refused(catalog: CatalogStore) -> None:
    with pytest.raises(ValidationFailed, match="date it was read") as caught:
        await catalog.create(acting_principal=ADMIN, **{**VALID_ENTRY, "pricing_recorded_on": None})
    assert caught.value.details["field"] == "pricing_recorded_on"


async def test_a_gateway_rename_is_a_one_row_edit_that_keeps_the_key(
    catalog: CatalogStore,
) -> None:
    """The key/vendor split earning its keep: the handle every policy references does not move."""
    await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    renamed = await catalog.edit(
        "test-economy-alpha", {"gateway_model": "testvendor/alpha-2"}, acting_principal=ADMIN
    )
    assert renamed.catalog_key == "test-economy-alpha"
    assert renamed.gateway_model == "testvendor/alpha-2"

    audit = await recorded_changes(
        catalog._session, subject_kind="model_catalog", subject_id="test-economy-alpha"
    )
    edit = next(entry for entry in audit if entry.action is AdminAction.CATALOG_EDIT)
    assert edit.before is not None and edit.before["gateway_model"] == "testvendor/alpha-1"
    assert edit.after is not None and edit.after["gateway_model"] == "testvendor/alpha-2"


async def test_an_edit_cannot_reach_a_state_a_create_would_have_refused(
    catalog: CatalogStore,
) -> None:
    """Validation runs over the merged result, not the changed fields alone."""
    await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    with pytest.raises(ValidationFailed, match="must not be negative"):
        await catalog.edit(
            "test-economy-alpha",
            {"input_price_per_million": Decimal("-1")},
            acting_principal=ADMIN,
        )


async def test_the_catalog_key_is_not_an_editable_field(catalog: CatalogStore) -> None:
    await catalog.create(acting_principal=ADMIN, **VALID_ENTRY)
    for unreachable in ({"catalog_key": "test-renamed"}, {"status": "disabled"}):
        with pytest.raises(ValidationFailed, match="Not an editable catalog field"):
            await catalog.edit("test-economy-alpha", unreachable, acting_principal=ADMIN)


# ================================================== 27.1 the last model for a required role


async def _make_the_only_lab_capable_entry(catalog: CatalogStore) -> None:
    """Arrange a catalog where exactly one enabled entry can serve the lab role.

    The seeded four each declare every call role, so a newly added entry is never the last one for
    anything — the right shape for a real deployment and the wrong shape for this test. Narrowing
    the seeded entries to routing and synthesis is an ordinary administrative edit, and it leaves
    the shipped `admin_experimental` policy — which applies to the lab role — requiring a role only
    the new entry can serve.
    """
    for existing in await catalog.list():
        if existing.catalog_key.startswith("test-"):
            continue
        await catalog.edit(
            existing.catalog_key,
            {"capability_roles": [CallRole.ROUTING.value, CallRole.SYNTHESIS.value]},
            acting_principal=ADMIN,
        )
    await catalog.create(
        acting_principal=ADMIN, **{**VALID_ENTRY, "capability_roles": (CallRole.LAB,)}
    )


async def test_disabling_the_last_model_for_a_required_role_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """`specs/model-catalog`'s cross-row refusal, which no constraint can express.

    Built rather than assumed: the arrangement leaves exactly one enabled entry able to serve a
    role a shipped policy requires, so disabling that entry would strand it.
    """
    catalog, _policies, _plans, _session = stores
    await _make_the_only_lab_capable_entry(catalog)

    stranded = await catalog.roles_left_without_a_model("test-economy-alpha")
    assert CallRole.LAB in stranded

    with pytest.raises(ModelRoleWouldBeUnavailable) as caught:
        await catalog.disable("test-economy-alpha", acting_principal=ADMIN)
    assert caught.value.details["roles"] == ["lab"]
    assert caught.value.details["acknowledgement_required"] == "acknowledge_role_unavailability"
    assert (await catalog.require("test-economy-alpha")).is_enabled, "the refusal must not write"


async def test_the_same_disable_proceeds_when_the_administrator_acknowledges_it(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """The other half: it is a decision to be recorded, not one to be prevented."""
    catalog, _policies, _plans, session = stores
    await _make_the_only_lab_capable_entry(catalog)

    disabled = await catalog.disable(
        "test-economy-alpha", acting_principal=ADMIN, acknowledge_role_unavailability=True
    )
    assert disabled.status is CatalogStatus.DISABLED

    audit = await recorded_changes(
        session, subject_kind="model_catalog", subject_id="test-economy-alpha"
    )
    assert any(entry.action is AdminAction.CATALOG_DISABLE for entry in audit)


async def test_disabling_a_model_a_role_has_alternatives_for_needs_no_acknowledgement(
    catalog: CatalogStore,
) -> None:
    """The refusal is about stranding a role, not about disabling. The seeded catalog has several
    entries per role, so this must simply work."""
    assert await catalog.roles_left_without_a_model("standard-general") == frozenset()
    disabled = await catalog.disable("standard-general", acting_principal=ADMIN)
    assert disabled.status is CatalogStatus.DISABLED


async def test_enabling_is_never_refused_and_restores_availability(catalog: CatalogStore) -> None:
    await catalog.disable("standard-general", acting_principal=ADMIN)
    restored = await catalog.enable("standard-general", acting_principal=ADMIN)
    assert restored.is_enabled


# =========================================================================== 27.2 policies


async def test_a_policy_is_created_with_its_ordered_candidates(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, policies, _plans, _session = stores
    created = await policies.create(
        acting_principal=ADMIN,
        policy_id="test_ordered",
        display_name="Test ordered",
        candidate_catalog_keys=["standard-general", "economy-free-primary"],
        applicable_call_roles=[CallRole.SYNTHESIS],
        eligibility=PolicyEligibility.PLAN,
    )
    assert created.candidate_catalog_keys == ("standard-general", "economy-free-primary")

    read_back = await policies.require("test_ordered")
    assert read_back.candidate_catalog_keys == ("standard-general", "economy-free-primary"), (
        "candidate order is the resolution order and must survive a round trip exactly"
    )


async def test_a_policy_referencing_a_missing_catalog_key_is_refused_at_write_time(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """`specs/model-policy`, and the reason this module exists: PostgreSQL cannot check an array
    element against another table, so without this the typo reaches a request."""
    _catalog, policies, _plans, _session = stores
    with pytest.raises(ValidationFailed, match="do not exist") as caught:
        await policies.create(
            acting_principal=ADMIN,
            policy_id="test_dangling",
            display_name="Test dangling",
            candidate_catalog_keys=["economy-free-primary", "no-such-model"],
            applicable_call_roles=[CallRole.ROUTING],
            eligibility=PolicyEligibility.PLAN,
        )
    assert caught.value.details["missing_catalog_keys"] == ["no-such-model"]
    assert await policies.get("test_dangling") is None, "the refusal must not write"


async def test_repointing_a_policy_at_a_missing_key_is_refused_too(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """The edit path, not only the create path — a promotion is where this typo actually happens."""
    _catalog, policies, _plans, _session = stores
    before = await policies.require("balanced")
    with pytest.raises(ValidationFailed, match="do not exist"):
        await policies.set_candidates("balanced", ["ghost-model"], acting_principal=ADMIN)
    assert (
        await policies.require("balanced")
    ).candidate_catalog_keys == before.candidate_catalog_keys


async def test_a_promotion_records_the_comparison_runs_it_cited(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """Decision 26: promotion is an administrative write citing the evidence it rests on."""
    _catalog, policies, _plans, session = stores
    run_id = "11111111-2222-4333-8444-555555555555"
    await policies.set_candidates(
        "balanced",
        ["economy-free-primary", "standard-general"],
        acting_principal=ADMIN,
        cited_comparison_run_ids=(run_id,),
    )
    audit = await recorded_changes(session, subject_kind="model_policy", subject_id="balanced")
    assert audit[0].cited_comparison_run_ids == (run_id,)
    assert audit[0].before != audit[0].after


async def test_a_pinned_policy_refuses_a_second_candidate_and_a_fallback(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """`specs/evaluation`: the fixed-model policy attempts no candidate but the pinned one."""
    _catalog, policies, _plans, _session = stores
    assert (await policies.require("evaluation_fixed")).is_pinned

    with pytest.raises(ValidationFailed, match="exactly one candidate"):
        await policies.set_candidates(
            "evaluation_fixed",
            ["economy-free-primary", "standard-general"],
            acting_principal=ADMIN,
        )
    with pytest.raises(ValidationFailed, match="may declare no fallback"):
        await policies.set_fallback("evaluation_fixed", "free_default", acting_principal=ADMIN)


async def test_a_duplicated_candidate_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, policies, _plans, _session = stores
    with pytest.raises(ValidationFailed, match="more than once"):
        await policies.set_candidates(
            "balanced", ["economy-free-primary", "economy-free-primary"], acting_principal=ADMIN
        )


async def test_an_unknown_fallback_policy_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, policies, _plans, _session = stores
    with pytest.raises(ValidationFailed, match="does not exist"):
        await policies.set_fallback("balanced", "no_such_policy", acting_principal=ADMIN)


# =========================================================================== 27.2 plans


async def test_the_three_canonical_plans_read_back_in_entitlement_order(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    listed = await plans.list()
    assert [plan.plan_code for plan in listed] == [PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM]
    assert [plan.rank for plan in listed] == sorted(plan.rank for plan in listed)
    for plan in listed:
        assert plan.policy_for(CallRole.ROUTING) is not None
        assert plan.policy_for(CallRole.SYNTHESIS) is not None


async def test_no_plan_named_plus_can_be_read_or_required(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """The retired tier, at the repository boundary as well as in the table."""
    _catalog, _policies, plans, _session = stores
    assert await plans.get("plus") is None
    with pytest.raises(RecordNotFound):
        await plans.require("plus")
    assert {plan.plan_code.value for plan in await plans.list()} == {"free", "pro", "premium"}


async def test_a_plan_mapping_change_takes_effect_with_no_code_change(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """`specs/model-policy`: re-point the Pro plan and subsequent reads resolve the new policy."""
    _catalog, _policies, plans, session = stores
    before = await plans.require(PlanCode.PRO)
    assert before.policy_for(CallRole.SYNTHESIS) == "balanced"

    await plans.set_policy_mapping(
        PlanCode.PRO,
        {CallRole.ROUTING: "balanced", CallRole.SYNTHESIS: "high_reasoning"},
        acting_principal=ADMIN,
    )

    after = await plans.require(PlanCode.PRO)
    assert after.policy_for(CallRole.SYNTHESIS) == "high_reasoning"
    assert after.policy_for(CallRole.ROUTING) == "balanced"

    audit = await recorded_changes(session, subject_kind="subscription_plan", subject_id="pro")
    assert audit[0].action is AdminAction.PLAN_MAPPING_EDIT
    assert audit[0].before is not None and audit[0].after is not None


async def test_a_plan_mapping_naming_a_missing_policy_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    with pytest.raises(ValidationFailed, match="do not exist") as caught:
        await plans.set_policy_mapping(
            PlanCode.FREE, {CallRole.ROUTING: "imaginary_policy"}, acting_principal=ADMIN
        )
    assert caught.value.details["missing_policy_ids"] == ["imaginary_policy"]
    assert (await plans.require(PlanCode.FREE)).policy_for(CallRole.ROUTING) == "free_default"


# =========================================================================== 27.2 allowances


async def test_the_seeded_allowances_read_back_per_plan_and_for_the_internal_subject(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    free = await plans.allowances(plan_code=PlanCode.FREE)
    assert {row.dimension for row in free} >= {
        QuotaDimension.REQUESTS_PER_DAY,
        QuotaDimension.TOKENS_PER_MONTH,
    }
    assert all(row.subject == "free" for row in free)

    internal = await plans.allowances(internal=True)
    assert internal and all(row.subject == "internal" for row in internal)


async def test_an_allowance_change_takes_effect_and_is_recorded(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, session = stores
    written = await plans.set_allowance(
        acting_principal=ADMIN,
        plan_code=PlanCode.PRO,
        dimension=QuotaDimension.REQUESTS_PER_DAY,
        allowance=999,
    )
    assert written.allowance == 999

    read_back = await plans.allowances(plan_code=PlanCode.PRO)
    daily = next(row for row in read_back if row.dimension is QuotaDimension.REQUESTS_PER_DAY)
    assert daily.allowance == 999

    audit = await recorded_changes(session, subject_kind="usage_limit")
    assert audit[0].action is AdminAction.ALLOWANCE_SET
    assert audit[0].after == {"allowance": 999}


async def test_a_negative_allowance_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    with pytest.raises(ValidationFailed, match="may not be negative") as caught:
        await plans.set_allowance(
            acting_principal=ADMIN,
            plan_code=PlanCode.FREE,
            dimension=QuotaDimension.REQUESTS_PER_DAY,
            allowance=-1,
        )
    assert caught.value.details["field"] == "allowance"


async def test_an_unknown_allowance_dimension_is_refused(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    with pytest.raises(ValidationFailed, match="not a usage dimension") as caught:
        await plans.set_allowance(
            acting_principal=ADMIN,
            plan_code=PlanCode.FREE,
            dimension="requests_per_fortnight",
            allowance=10,
        )
    assert caught.value.details["dimension"] == "requests_per_fortnight"


async def test_an_allowance_must_name_a_plan_or_the_internal_subject_and_not_both(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    _catalog, _policies, plans, _session = stores
    with pytest.raises(ValidationFailed, match="exactly one"):
        await plans.set_allowance(
            acting_principal=ADMIN,
            plan_code=PlanCode.FREE,
            internal=True,
            dimension=QuotaDimension.REQUESTS_PER_DAY,
            allowance=10,
        )
    with pytest.raises(ValidationFailed, match="exactly one"):
        await plans.set_allowance(
            acting_principal=ADMIN, dimension=QuotaDimension.REQUESTS_PER_DAY, allowance=10
        )


async def test_a_cost_budget_allowance_can_be_written_by_the_same_mechanism(
    stores: tuple[CatalogStore, PolicyStore, PlanStore, AsyncSession],
) -> None:
    """`specs/usage-limits` asks the model to admit one without restructuring. Nothing seeds it."""
    _catalog, _policies, plans, _session = stores
    written = await plans.set_allowance(
        acting_principal=ADMIN,
        plan_code=PlanCode.PREMIUM,
        dimension=QuotaDimension.ESTIMATED_COST_PER_MONTH,
        allowance=50,
    )
    assert written.dimension is QuotaDimension.ESTIMATED_COST_PER_MONTH
    assert written.window_kind.value == "month"


# =========================================================================== 27.2 assignment


async def test_a_plan_assignment_is_privileged_and_recorded(
    engines: Engines, clean_database: None
) -> None:
    """`user_plans` grants the request role SELECT only, so this is the only path onto a tier."""
    from sqlalchemy import text

    from tests.db_support import insert_profile

    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        plans = PlanStore(session)
        await plans.assign(user_id, PlanCode.PRO, acting_principal=ADMIN)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assigned = await session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = CAST(:u AS uuid)"),
            {"u": user_id},
        )
        audit = await recorded_changes(session, subject_kind="user_plan", subject_id=user_id)
    assert assigned == "pro"
    assert audit[0].action is AdminAction.PLAN_ASSIGN
    assert audit[0].after == {"plan_code": "pro"}


async def test_reassigning_records_the_previous_tier(
    engines: Engines, clean_database: None
) -> None:
    from tests.db_support import insert_profile

    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        plans = PlanStore(session)
        await plans.assign(user_id, PlanCode.PRO, acting_principal=ADMIN)
        await plans.assign(user_id, PlanCode.PREMIUM, acting_principal=ADMIN)
        audit = await recorded_changes(session, subject_kind="user_plan", subject_id=user_id)

    latest = audit[0]
    assert latest.before == {"plan_code": "pro"}
    assert latest.after == {"plan_code": "premium"}


async def test_assigning_a_tier_that_does_not_exist_is_refused(
    engines: Engines, clean_database: None
) -> None:
    from tests.db_support import insert_profile

    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        with pytest.raises(RecordNotFound, match="plus"):
            await PlanStore(session).assign(user_id, "plus", acting_principal=ADMIN)
