"""Tasks 26.6 and 26.8 — the seeded catalog, policies, plans and allowances.

What a fresh deployment actually gets, asserted against the database rather than against the
literals that produced it — with one deliberate exception, the idempotency test, which re-applies
the seed and checks that nothing moved.

The two properties worth stating plainly:

* **A fresh migrated database can resolve a model.** ``specs/model-catalog`` requires at least one
  enabled entry for every capability role a shipped policy needs, and no policy may reference a
  catalog key that is not there. A dangling candidate would surface as ``NoEligibleModel`` on the
  first question somebody asked, which is a poor moment to discover a typo in a migration.
* **The evaluation policy is unreachable by every product plan.** ``specs/evaluation`` pins it to
  one model precisely so that a change to a plan, a policy or a candidate pool cannot change what
  a run measures. That guarantee is only worth anything if no plan can wander into it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import PRODUCT_PLAN_CODES, SHIPPED_POLICY_IDS, CallRole, PlanCode
from weathra.domain.usage import INTERNAL_SUBJECT, QuotaDimension

pytestmark = pytest.mark.db

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SEED_MIGRATION = (
    BACKEND_ROOT / "weathra" / "db" / "migrations" / "versions" / "0008_seed_model_policy_data.py"
)

# The identifier a plan must never carry again, in the spellings a reintroduction would use.
RETIRED_TIER = ("plus", "PLUS", "Plus")


@pytest.fixture(scope="module")
def seed_module() -> ModuleType:
    """The seed migration, loaded by path.

    Alembic loads revision files by path because ``0008_seed_model_policy_data`` is not an
    importable module name, and this test needs the same thing for the same reason: the declared
    data and the ``seed`` function are what the assertions below are about.
    """
    spec = importlib.util.spec_from_file_location("weathra_seed_0008", SEED_MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# =========================================================================== 26.6 the catalog


async def test_the_catalog_is_seeded_and_every_entry_is_enabled(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text("SELECT catalog_key, status, gateway_provider, gateway_model FROM model_catalog")
    )
    entries = {row[0]: row for row in rows}
    assert entries, "a fresh migrated database has an empty catalog and can resolve nothing"
    for key, row in entries.items():
        assert row[1] == "enabled", f"{key} is seeded disabled, so nothing can resolve it"
        assert row[2] and row[3], f"{key} does not name a gateway to call"


async def test_every_capability_role_a_shipped_policy_needs_has_an_enabled_entry(
    privileged: AsyncSession,
) -> None:
    """`specs/model-catalog`: "a fresh deployment applies migrations, therefore the catalog contains
    at least one enabled entry for each capability role a shipped policy requires"."""
    required = await privileged.execute(
        text("SELECT DISTINCT unnest(applicable_call_roles) FROM model_policies")
    )
    needed = {row[0] for row in required}
    assert needed, "no policy declares a call role"

    for role in sorted(needed):
        available = await privileged.scalar(
            text(
                "SELECT count(*) FROM model_catalog "
                "WHERE status = 'enabled' AND :role = ANY(capability_roles)"
            ),
            {"role": role},
        )
        assert available, f"no enabled catalog entry can serve the {role} role"


async def test_no_shipped_policy_references_a_missing_catalog_key(
    privileged: AsyncSession,
) -> None:
    """A dangling candidate is invisible until the first request walks the list and finds nothing."""
    dangling = await privileged.execute(
        text(
            "SELECT policy.policy_id, candidate "
            "FROM model_policies AS policy, unnest(policy.candidate_catalog_keys) AS candidate "
            "WHERE NOT EXISTS (SELECT 1 FROM model_catalog WHERE catalog_key = candidate)"
        )
    )
    missing = [(row[0], row[1]) for row in dangling]
    assert not missing, f"policies reference catalog keys that do not exist: {missing}"


async def test_a_catalog_key_carries_no_vendor_naming(privileged: AsyncSession) -> None:
    """`specs/model-catalog` requires the internal key to be independent of vendor naming, which is
    what makes a gateway rename a one-row update rather than a migration across every policy."""
    rows = await privileged.execute(
        text("SELECT catalog_key, gateway_provider, gateway_model FROM model_catalog")
    )
    for catalog_key, provider, gateway_model in rows:
        vendor = gateway_model.split("/")[0].lower()
        assert vendor not in catalog_key.lower(), (
            f"catalog key {catalog_key!r} names the vendor {vendor!r}"
        )
        assert provider.lower() not in catalog_key.lower()
        assert catalog_key == catalog_key.lower()
        assert " " not in catalog_key and "_" not in catalog_key, "catalog keys are kebab-case"


async def test_every_price_is_recorded_with_its_currency_and_basis(
    privileged: AsyncSession,
) -> None:
    """Cost estimation is deterministic only if the price it used is known and dated."""
    rows = await privileged.execute(
        text(
            "SELECT catalog_key, input_price_per_million, output_price_per_million, "
            "price_currency, pricing_recorded_on, is_free_tier FROM model_catalog"
        )
    )
    for key, input_price, output_price, currency, recorded_on, is_free in rows:
        assert input_price >= 0 and output_price >= 0, f"{key} has a negative price"
        assert currency == "USD", f"{key} records no currency"
        assert recorded_on is not None, f"{key} records no pricing date"
        if is_free:
            assert input_price == 0 and output_price == 0, (
                f"{key} is classified free-tier and carries a price"
            )


# =========================================================================== 26.6 the policies


async def test_the_shipped_policies_are_present(privileged: AsyncSession) -> None:
    rows = await privileged.execute(text("SELECT policy_id FROM model_policies"))
    present = {row[0] for row in rows}
    assert set(SHIPPED_POLICY_IDS) <= present, (
        f"missing: {sorted(set(SHIPPED_POLICY_IDS) - present)}"
    )


async def test_every_policy_declares_candidates_call_roles_and_eligibility(
    privileged: AsyncSession,
) -> None:
    rows = await privileged.execute(
        text(
            "SELECT policy_id, candidate_catalog_keys, applicable_call_roles, eligibility "
            "FROM model_policies"
        )
    )
    for policy_id, candidates, roles, eligibility in rows:
        assert candidates, f"{policy_id} declares no candidate"
        assert roles, f"{policy_id} declares no call role"
        assert eligibility, f"{policy_id} declares no eligibility condition"
        assert set(roles) <= {role.value for role in CallRole}


async def test_a_declared_fallback_never_points_above_the_policy_that_declares_it(
    privileged: AsyncSession,
) -> None:
    """`specs/model-policy` forbids falling *up*: an outage must not become a free upgrade.

    "Above" is read off the plan that maps to each policy, which is the only ordering that means
    anything here — a policy no plan maps to cannot be escalated into by a product caller.
    """
    rank_rows = await privileged.execute(
        text(
            "SELECT value #>> '{}', plan.rank "
            "FROM subscription_plans AS plan, jsonb_each(plan.policy_by_call_role) AS mapping(key, value)"
        )
    )
    rank_of: dict[str, int] = {}
    for policy_id, rank in rank_rows:
        rank_of[policy_id] = max(rank, rank_of.get(policy_id, rank))

    rows = await privileged.execute(
        text(
            "SELECT policy_id, fallback_policy_id FROM model_policies WHERE fallback_policy_id IS NOT NULL"
        )
    )
    for policy_id, fallback in rows:
        if policy_id in rank_of and fallback in rank_of:
            assert rank_of[fallback] <= rank_of[policy_id], (
                f"{policy_id} falls back to {fallback}, which a higher plan maps to"
            )


async def test_the_free_policy_is_the_only_one_an_unauthenticated_call_may_reach(
    privileged: AsyncSession,
) -> None:
    """`specs/model-policy`: with no validated token, only `free_default` may be resolved."""
    public = await privileged.execute(
        text("SELECT policy_id FROM model_policies WHERE eligibility = 'public'")
    )
    assert {row[0] for row in public} == {"free_default"}


async def test_the_administrative_policy_is_gated_on_a_role_and_not_on_a_plan(
    privileged: AsyncSession,
) -> None:
    eligibility = await privileged.scalar(
        text("SELECT eligibility FROM model_policies WHERE policy_id = 'admin_experimental'")
    )
    assert eligibility == "administrative"

    mapped = await privileged.scalar(
        text(
            "SELECT count(*) FROM subscription_plans "
            "WHERE policy_by_call_role::text LIKE '%admin_experimental%'"
        )
    )
    assert mapped == 0, "a product plan maps to the administrative policy"


# =========================================================================== 26.6 plans, allowances


async def test_the_three_canonical_plans_are_seeded_with_their_mappings(
    privileged: AsyncSession,
) -> None:
    """`specs/usage-limits`: Free, Pro and Premium present, each with a code, a display name,
    policy mappings and allowances."""
    rows = await privileged.execute(
        text(
            "SELECT plan_code, display_name, rank, policy_by_call_role, external_subscription_ref "
            "FROM subscription_plans ORDER BY rank"
        )
    )
    plans = list(rows)
    assert [row[0] for row in plans] == [plan.value for plan in PRODUCT_PLAN_CODES]

    for plan_code, display_name, _rank, mapping, external_ref in plans:
        assert display_name, f"{plan_code} has no display name"
        assert set(mapping) == {CallRole.ROUTING.value, CallRole.SYNTHESIS.value}, (
            f"{plan_code} does not map both call roles"
        )
        assert external_ref is None, (
            "the external subscription reference must stay null; this change ships no billing"
        )


async def test_every_plan_maps_only_to_policies_that_exist(privileged: AsyncSession) -> None:
    dangling = await privileged.execute(
        text(
            "SELECT plan.plan_code, mapping.value #>> '{}' "
            "FROM subscription_plans AS plan, "
            "     jsonb_each(plan.policy_by_call_role) AS mapping(key, value) "
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM model_policies WHERE policy_id = mapping.value #>> '{}')"
        )
    )
    missing = [(row[0], row[1]) for row in dangling]
    assert not missing, f"plans map to policies that do not exist: {missing}"


async def test_each_plan_and_the_internal_subject_carry_allowances(
    privileged: AsyncSession,
) -> None:
    rows = await privileged.execute(
        text("SELECT coalesce(plan_code, internal_subject), dimension, allowance FROM usage_limits")
    )
    by_subject: dict[str, dict[str, int]] = {}
    for subject, dimension, allowance in rows:
        by_subject.setdefault(subject, {})[dimension] = allowance

    enforced = {
        QuotaDimension.REQUESTS_PER_DAY.value,
        QuotaDimension.REQUESTS_PER_MONTH.value,
        QuotaDimension.TOKENS_PER_MONTH.value,
        QuotaDimension.CONCURRENT_RUNS.value,
    }
    for subject in [plan.value for plan in PRODUCT_PLAN_CODES] + [INTERNAL_SUBJECT]:
        assert subject in by_subject, f"{subject} has no allowances"
        assert enforced <= set(by_subject[subject]), f"{subject} is missing a dimension"


async def test_the_allowances_rise_with_the_tier(privileged: AsyncSession) -> None:
    """Not a formality: a Free allowance above Pro's would make the tiers meaningless while every
    structural test still passed."""
    rows = await privileged.execute(
        text(
            "SELECT limit_row.plan_code, limit_row.dimension, limit_row.allowance "
            "FROM usage_limits AS limit_row WHERE limit_row.plan_code IS NOT NULL"
        )
    )
    by_dimension: dict[str, dict[str, int]] = {}
    for plan_code, dimension, allowance in rows:
        by_dimension.setdefault(dimension, {})[plan_code] = allowance

    for dimension, allowances in by_dimension.items():
        ordered = [
            allowances[plan.value] for plan in PRODUCT_PLAN_CODES if plan.value in allowances
        ]
        assert ordered == sorted(ordered), f"{dimension} does not rise with the tier: {allowances}"


async def test_no_cost_budget_allowance_is_enforced(privileged: AsyncSession) -> None:
    """`specs/usage-limits` asks for the dimension to be *representable*, not enforced. An estimate
    is the wrong thing to refuse a request on, and this change ships no billing."""
    seeded = await privileged.scalar(
        text("SELECT count(*) FROM usage_limits WHERE dimension = 'estimated_cost_per_month'")
    )
    assert seeded == 0


async def test_the_cost_budget_dimension_is_writable_even_though_none_is_seeded(
    engines: Engines,
) -> None:
    """The other half: expressible by the same mechanism, with no restructuring."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_limits (id, plan_code, dimension, window_kind, allowance) "
                "VALUES (gen_random_uuid(), 'premium', 'estimated_cost_per_month', 'month', 50)"
            )
        )
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            written = await session.scalar(
                text(
                    "SELECT allowance FROM usage_limits "
                    "WHERE dimension = 'estimated_cost_per_month'"
                )
            )
        assert written == 50
    finally:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("DELETE FROM usage_limits WHERE dimension = 'estimated_cost_per_month'")
            )


# =========================================================================== 26.6 idempotency


async def test_the_seed_is_deterministic(seed_module: ModuleType) -> None:
    """The allowance identifiers are derived, not random, which is what lets a re-run conflict with
    the row it already wrote rather than insert a second one."""
    first = seed_module.allowance_id("free", "requests_per_day")
    again = seed_module.allowance_id("free", "requests_per_day")
    assert first == again
    assert first != seed_module.allowance_id("pro", "requests_per_day")
    assert first != seed_module.allowance_id("free", "requests_per_month")


async def test_applying_the_seed_twice_changes_nothing(
    engines: Engines, seed_module: ModuleType
) -> None:
    """Re-running the migration on a seeded database must be a no-op — and, more importantly, must
    not undo an administrator's later change. Both are asserted: the row counts do not move, and a
    deliberately disabled entry stays disabled."""

    async def snapshot() -> dict[str, list[tuple[object, ...]]]:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            return {
                "catalog": [
                    tuple(row)
                    for row in await session.execute(
                        text(
                            "SELECT catalog_key, status, gateway_model FROM model_catalog ORDER BY 1"
                        )
                    )
                ],
                "policies": [
                    tuple(row)
                    for row in await session.execute(
                        text(
                            "SELECT policy_id, candidate_catalog_keys, fallback_policy_id, "
                            "failover_enabled FROM model_policies ORDER BY 1"
                        )
                    )
                ],
                "plans": [
                    tuple(row)
                    for row in await session.execute(
                        text("SELECT plan_code, rank FROM subscription_plans ORDER BY 1")
                    )
                ],
                "limits": [
                    tuple(row)
                    for row in await session.execute(
                        text(
                            "SELECT id, coalesce(plan_code, internal_subject), dimension, allowance "
                            "FROM usage_limits ORDER BY 2, 3"
                        )
                    )
                ],
            }

    # An administrator disables an entry after the seed ran, which is exactly the state a re-seed
    # must not trample.
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "UPDATE model_catalog SET status = 'disabled' WHERE catalog_key = 'standard-general'"
            )
        )
    try:
        before = await snapshot()
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.run_sync(lambda sync: seed_module.seed(sync.connection()))
        after = await snapshot()

        assert after == before, "re-applying the seed changed the database"
        assert ("standard-general", "disabled", "openai/gpt-oss-120b") in after["catalog"], (
            "the re-seed re-enabled a model an administrator had disabled"
        )
    finally:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "UPDATE model_catalog SET status = 'enabled' "
                    "WHERE catalog_key = 'standard-general'"
                )
            )


async def test_the_policy_identifiers_are_stable(
    privileged: AsyncSession, seed_module: ModuleType
) -> None:
    """The database, the migration's declared data and the domain constants name the same policies.

    A policy id reaches recorded usage events and comparison results, so a rename is a data
    migration rather than an edit — which is worth a test that would catch one being attempted.
    """
    declared = {policy_id for policy_id, *_ in seed_module.POLICIES}
    rows = await privileged.execute(text("SELECT policy_id FROM model_policies"))
    stored = {row[0] for row in rows}

    assert declared == stored
    assert declared == set(SHIPPED_POLICY_IDS)


# =========================================================================== 26.8 the plan codes


async def test_free_pro_and_premium_each_exist(privileged: AsyncSession) -> None:
    rows = await privileged.execute(text("SELECT plan_code FROM subscription_plans"))
    stored = {row[0] for row in rows}
    assert {"free", "pro", "premium"} <= stored
    assert stored == {plan.value for plan in PlanCode}


async def test_no_plan_code_named_plus_exists(privileged: AsyncSession) -> None:
    """The retired tier. There is no Plus plan and no alias to one."""
    found = await privileged.scalar(
        text("SELECT count(*) FROM subscription_plans WHERE lower(plan_code) LIKE '%plus%'")
    )
    assert found == 0


@pytest.mark.parametrize("spelling", RETIRED_TIER)
async def test_the_retired_tier_cannot_be_reintroduced(engines: Engines, spelling: str) -> None:
    """The regression guard the product owner asked for, at the level that actually holds.

    Not "no row happens to say plus" — no row *can*. The CHECK constraint pins the plan code to the
    canonical three, so reintroducing the tier would take a deliberate migration rather than an
    INSERT somebody ran during an incident.
    """
    from sqlalchemy.exc import DBAPIError

    with pytest.raises(DBAPIError) as caught:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "INSERT INTO subscription_plans (plan_code, display_name, rank) "
                    "VALUES (:code, 'Plus', 9)"
                ),
                {"code": spelling},
            )
    assert "ck_subscription_plans_canonical_code" in str(caught.value)


async def test_a_plan_assignment_cannot_name_a_tier_that_does_not_exist(engines: Engines) -> None:
    """The foreign key, which is the same guarantee one table further along: a `user_plans` row
    naming `plus` is refused because there is no such plan to point at."""
    from sqlalchemy.exc import DBAPIError

    from tests.db_support import insert_profile, new_user_id

    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)

    with pytest.raises(DBAPIError) as caught:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("INSERT INTO user_plans (user_id, plan_code) VALUES (:u, 'plus')"),
                {"u": user_id},
            )
    assert "fk_user_plans_plan" in str(caught.value)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(text("DELETE FROM profiles WHERE user_id = :u"), {"u": user_id})


# =========================================================================== 26.8 the pinned policy


async def test_the_evaluation_policy_declares_exactly_one_candidate(
    privileged: AsyncSession,
) -> None:
    row = (
        await privileged.execute(
            text(
                "SELECT candidate_catalog_keys, fallback_policy_id, failover_enabled, eligibility "
                "FROM model_policies WHERE policy_id = 'evaluation_fixed'"
            )
        )
    ).one()
    candidates, fallback, failover, eligibility = row

    assert len(candidates) == 1, f"the pinned policy declares {len(candidates)} candidates"
    assert fallback is None, "the pinned policy declares a fallback, so it is not pinned"
    assert failover is False, "the pinned policy would fail over, so a run could measure two models"
    assert eligibility == "internal_evaluation"


async def test_the_evaluation_policy_is_unreachable_by_every_product_plan(
    privileged: AsyncSession,
) -> None:
    """`specs/evaluation`: a live run resolves its pinned model through this policy rather than
    through the evaluation test user's subscription plan, so that a change to a plan, a policy or a
    candidate pool cannot change what a run measures.

    Checked three ways, because there are three ways in: a direct mapping, a fallback chain from a
    mapped policy, and the eligibility condition itself.
    """
    mappings = await privileged.execute(
        text(
            "SELECT plan.plan_code, mapping.value #>> '{}' "
            "FROM subscription_plans AS plan, "
            "     jsonb_each(plan.policy_by_call_role) AS mapping(key, value)"
        )
    )
    reachable = {row[1] for row in mappings}
    assert "evaluation_fixed" not in reachable, "a product plan maps to the pinned policy"

    # And no mapped policy falls back into it, transitively.
    frontier = set(reachable)
    seen: set[str] = set()
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        fallback = await privileged.scalar(
            text("SELECT fallback_policy_id FROM model_policies WHERE policy_id = :id"),
            {"id": current},
        )
        if fallback:
            frontier.add(fallback)
    assert "evaluation_fixed" not in seen, (
        f"the pinned policy is reachable by a fallback chain from a product plan: {sorted(seen)}"
    )

    eligibility = await privileged.scalar(
        text("SELECT eligibility FROM model_policies WHERE policy_id = 'evaluation_fixed'")
    )
    assert eligibility not in {"public", "plan"}


async def test_the_pinned_candidate_is_an_enabled_catalog_entry(privileged: AsyncSession) -> None:
    """A pinned policy with a candidate that is not there cannot fail over to anything, so the run
    would abort — which `specs/evaluation` wants, but not because of a seeding mistake."""
    status = await privileged.scalar(
        text(
            "SELECT catalog.status FROM model_policies AS policy "
            "JOIN model_catalog AS catalog ON catalog.catalog_key = policy.candidate_catalog_keys[1] "
            "WHERE policy.policy_id = 'evaluation_fixed'"
        )
    )
    assert status == "enabled"
