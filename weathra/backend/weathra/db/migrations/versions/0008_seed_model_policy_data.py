"""the initial catalog, the shipped policies, the three plans, and the allowances

The data that makes a fresh deployment resolve a model instead of raising ``NoEligibleModel``
(``specs/model-catalog``: "a fresh deployment applies migrations, therefore the catalog contains at
least one enabled entry for each capability role a shipped policy requires").

**Catalog keys carry no vendor naming, and that is the requirement rather than a preference.**
``specs/model-catalog`` asks for "a stable internal catalog key, kebab-case and independent of any
vendor naming", and every policy, evaluation and comparison result references only the key. So the
keys read ``economy-free-primary`` and ``frontier-reasoning`` — what the entry is *for* — and the
vendor string lives in ``gateway_model``, which is the one mutable half. A gateway renaming a model
is then a one-row update that breaks no policy, no recorded event and no comparison.

**The catalog entries and their prices are real.** Each row was taken from OpenRouter's public model
listing on 2026-09-09, including ``context_window`` and both prices, and ``pricing_recorded_on``
records that date so a later reader knows how stale the figure is. Nothing here is a placeholder,
because a placeholder in an allowlist is a row that 404s in production, and a made-up price would
quietly make every cost estimate wrong in a way nothing would catch.

**Idempotent by construction.** Every insert is ``ON CONFLICT DO NOTHING`` and the ``usage_limits``
identifiers are UUIDv5 derived from ``(subject, dimension)`` rather than random, so re-running this
migration writes nothing the second time and — more importantly — does not undo an administrator's
later change. Seeding establishes the initial state; administration owns it afterwards, and a seed
that reset a deliberate disable on every deploy would be worse than no seed at all.

**The estimated-cost dimension is deliberately unseeded.** ``specs/usage-limits`` asks for the
allowance model to *admit* a cost budget without restructuring, and it does — the dimension exists,
a row could express it. None is written, because this change ships no billing and an estimate is
the wrong thing to refuse a request on. A dimension with no row is unlimited, not zero.

**Downgrade removes exactly these rows.** If a real plan assignment or a recorded usage event
references them by then, the foreign keys refuse and the downgrade fails saying so. That is the
intended outcome: a downgrade is not entitled to delete somebody's plan or their usage history in
order to tidy up a seed.

Revision ID: 0008_seed_model_policy_data
Revises: 0007_model_lab_and_audit_tables
Create date: 2026-09-09
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import date
from decimal import Decimal

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008_seed_model_policy_data"
down_revision: str | None = "0007_model_lab_and_audit_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The day the pricing and context windows below were read from the gateway's public listing.
PRICING_RECORDED_ON = "2026-09-09"

# The reserved subject internal traffic is accounted against. Mirrors
# weathra.domain.usage.INTERNAL_SUBJECT; deliberately not UUID-shaped, so it can never collide
# with a real auth subject and the owner policies deny it to every caller by arithmetic.
INTERNAL_SUBJECT = "internal"

# --------------------------------------------------------------------------- the catalog
#
# catalog_key, gateway_provider, gateway_model, display name, capability roles, tier,
# structured output, context window, input $/M, output $/M, free-or-paid.
CATALOG: tuple[tuple[str, str, str, str, tuple[str, ...], str, bool, int, str, str, bool], ...] = (
    (
        "economy-free-primary",
        "openrouter",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "Economy (free tier), primary",
        ("routing", "synthesis", "lab"),
        "economy",
        True,
        262144,
        "0",
        "0",
        True,
    ),
    (
        "economy-free-secondary",
        "openrouter",
        "nex-agi/nex-n2.5-mini:free",
        "Economy (free tier), secondary",
        ("routing", "synthesis", "lab"),
        "economy",
        True,
        262144,
        "0",
        "0",
        True,
    ),
    (
        "standard-general",
        "openrouter",
        "openai/gpt-oss-120b",
        "Standard general-purpose",
        ("routing", "synthesis", "lab"),
        "standard",
        True,
        131072,
        "0.037",
        "0.170",
        False,
    ),
    (
        "frontier-reasoning",
        "openrouter",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "Frontier structured reasoning",
        ("routing", "synthesis", "lab"),
        "frontier",
        True,
        262144,
        "0.625",
        "3.125",
        False,
    ),
)

# --------------------------------------------------------------------------- the policies
#
# policy_id, display name, ordered candidates, applicable call roles, eligibility, declared
# fallback, failover enabled. Insertion order matters: a fallback is a foreign key to a policy that
# must already exist.
POLICIES: tuple[tuple[str, str, tuple[str, ...], tuple[str, ...], str, str | None, bool], ...] = (
    (
        "free_default",
        "Free default",
        ("economy-free-primary", "economy-free-secondary"),
        ("routing", "synthesis"),
        # The only policy an unauthenticated or plan-less call may resolve.
        "public",
        None,
        True,
    ),
    (
        "balanced",
        "Balanced",
        ("standard-general", "economy-free-primary"),
        ("routing", "synthesis"),
        "plan",
        "free_default",
        True,
    ),
    (
        "high_reasoning",
        "High reasoning",
        ("frontier-reasoning", "standard-general"),
        ("routing", "synthesis"),
        "plan",
        # Falls back *down*, never up: an outage must not become a free upgrade, and the reverse
        # direction is what `specs/model-policy` forbids outright.
        "balanced",
        True,
    ),
    (
        "admin_experimental",
        "Administrative experimental",
        ("frontier-reasoning", "standard-general", "economy-free-primary"),
        ("routing", "synthesis", "lab"),
        # Gated on the administrative role rather than on any plan row, so no plan mapping can
        # reach it even if one named it.
        "administrative",
        None,
        True,
    ),
    (
        # The fixed-model evaluation policy of `specs/evaluation`. Exactly one candidate, no
        # declared fallback, and failover off — so a provider failure fails the run honestly
        # rather than quietly measuring a different model than the one the run claims.
        "evaluation_fixed",
        "Fixed-model evaluation",
        ("economy-free-primary",),
        ("routing", "synthesis"),
        "internal_evaluation",
        None,
        False,
    ),
)

# --------------------------------------------------------------------------- the plans
#
# plan_code, display name, rank, per-call-role policy mapping. Free / Pro / Premium, ascending.
# There is no `plus`: the middle tier is Pro, per the product decision of 2026-09-09, and the
# table's own CHECK constraint makes any other code unwritable.
PLANS: tuple[tuple[str, str, int, dict[str, str]], ...] = (
    ("free", "Free", 0, {"routing": "free_default", "synthesis": "free_default"}),
    ("pro", "Pro", 1, {"routing": "balanced", "synthesis": "balanced"}),
    ("premium", "Premium", 2, {"routing": "high_reasoning", "synthesis": "high_reasoning"}),
)

# --------------------------------------------------------------------------- the allowances
#
# Deliberately conservative on Free and generous on Premium, with the intent of tuning from
# recorded usage rather than from a guess made before there was any (design.md's open question on
# initial allowances). These are rows, so tuning is an UPDATE and not a deployment.
#
# subject kind -> dimension -> allowance.
ALLOWANCES: dict[str, dict[str, int]] = {
    "free": {
        "requests_per_day": 25,
        "requests_per_month": 300,
        "tokens_per_month": 500_000,
        "concurrent_runs": 1,
    },
    "pro": {
        "requests_per_day": 250,
        "requests_per_month": 4_000,
        "tokens_per_month": 8_000_000,
        "concurrent_runs": 3,
    },
    "premium": {
        "requests_per_day": 1_000,
        "requests_per_month": 20_000,
        "tokens_per_month": 40_000_000,
        "concurrent_runs": 6,
    },
    # The internal allowance. Separate from every product plan by construction, so a lab or
    # evaluation run cannot consume a person's entitlement, and generous enough that a comparison
    # matrix is not throttled by the gate meant for a browser.
    INTERNAL_SUBJECT: {
        "requests_per_day": 2_000,
        "requests_per_month": 30_000,
        "tokens_per_month": 60_000_000,
        "concurrent_runs": 8,
    },
}

DIMENSION_WINDOW = {
    "requests_per_day": "day",
    "requests_per_month": "month",
    "tokens_per_month": "month",
    "concurrent_runs": "concurrent",
}

# A stable namespace for the derived allowance identifiers. Any fixed UUID would do; this one is
# written down so the derivation is reproducible by anyone reading the file.
_ALLOWANCE_NAMESPACE = uuid.UUID("6f6f1b8e-2a1f-5f7c-9d3a-7c1b0e5a4d20")


def allowance_id(subject: str, dimension: str) -> str:
    """The deterministic identifier for one allowance row.

    Derived rather than random so that re-running the seed conflicts with the row it already wrote
    instead of inserting a second one — the partial unique indexes would catch a duplicate, but a
    seed that *relies* on a constraint to fail is a seed that cannot be re-run cleanly.
    """
    return str(uuid.uuid5(_ALLOWANCE_NAMESPACE, f"weathra:usage_limit:{subject}:{dimension}"))


# Bind parameters are given explicit types rather than being cast in the SQL text. A PostgreSQL
# array *literal* (`{"a","b"}`) is accepted by the synchronous driver Alembic runs under and
# rejected by asyncpg, which infers the parameter type from the surrounding CAST and then finds a
# string where it wants a sequence. Typing the bind instead lets SQLAlchemy render each value the
# way the connected driver expects, so the same seed applies from a migration and from a test.
_TEXT_ARRAY = postgresql.ARRAY(sa.Text())


def seed(connection: sa.engine.Connection) -> None:
    """Write the initial data, skipping anything already present.

    A named function rather than the body of ``upgrade()`` so the idempotency this migration claims
    can actually be exercised: a test applies it a second time against an already-seeded database
    and asserts nothing changed. "Every statement says ON CONFLICT DO NOTHING" is a description of
    the code; running it twice is evidence.
    """
    pricing_date = date.fromisoformat(PRICING_RECORDED_ON)

    # ------------------------------------------------------------------ catalog
    catalog_insert = sa.text(
        """
        INSERT INTO model_catalog (
            catalog_key, gateway_provider, gateway_model, display_name,
            capability_roles, capability_tier, supports_structured_output,
            context_window, input_price_per_million, output_price_per_million,
            price_currency, pricing_recorded_on, status, is_free_tier
        ) VALUES (
            :catalog_key, :provider, :gateway_model, :display_name,
            :roles, :tier, :structured,
            :context_window, :input_price, :output_price,
            'USD', :pricing_recorded_on, 'enabled', :is_free
        )
        ON CONFLICT (catalog_key) DO NOTHING
        """
    ).bindparams(
        sa.bindparam("roles", type_=_TEXT_ARRAY),
        sa.bindparam("input_price", type_=sa.Numeric(14, 6)),
        sa.bindparam("output_price", type_=sa.Numeric(14, 6)),
        sa.bindparam("pricing_recorded_on", type_=sa.Date()),
    )
    for (
        catalog_key,
        provider,
        gateway_model,
        display_name,
        roles,
        tier,
        structured,
        context_window,
        input_price,
        output_price,
        is_free,
    ) in CATALOG:
        connection.execute(
            catalog_insert,
            {
                "catalog_key": catalog_key,
                "provider": provider,
                "gateway_model": gateway_model,
                "display_name": display_name,
                "roles": list(roles),
                "tier": tier,
                "structured": structured,
                "context_window": context_window,
                "input_price": Decimal(input_price),
                "output_price": Decimal(output_price),
                "pricing_recorded_on": pricing_date,
                "is_free": is_free,
            },
        )

    # ------------------------------------------------------------------ policies
    policy_insert = sa.text(
        """
        INSERT INTO model_policies (
            policy_id, display_name, candidate_catalog_keys, applicable_call_roles,
            eligibility, fallback_policy_id, failover_enabled
        ) VALUES (
            :policy_id, :display_name, :candidates, :roles, :eligibility, :fallback, :failover
        )
        ON CONFLICT (policy_id) DO NOTHING
        """
    ).bindparams(
        sa.bindparam("candidates", type_=_TEXT_ARRAY),
        sa.bindparam("roles", type_=_TEXT_ARRAY),
    )
    for policy_id, display_name, candidates, roles, eligibility, fallback, failover in POLICIES:
        connection.execute(
            policy_insert,
            {
                "policy_id": policy_id,
                "display_name": display_name,
                "candidates": list(candidates),
                "roles": list(roles),
                "eligibility": eligibility,
                "fallback": fallback,
                "failover": failover,
            },
        )

    # ------------------------------------------------------------------ plans
    plan_insert = sa.text(
        """
        INSERT INTO subscription_plans (
            plan_code, display_name, rank, policy_by_call_role, external_subscription_ref
        ) VALUES (:plan_code, :display_name, :rank, :mapping, NULL)
        ON CONFLICT (plan_code) DO NOTHING
        """
    ).bindparams(sa.bindparam("mapping", type_=postgresql.JSONB()))
    for plan_code, display_name, rank, mapping in PLANS:
        connection.execute(
            plan_insert,
            {
                "plan_code": plan_code,
                "display_name": display_name,
                "rank": rank,
                "mapping": dict(mapping),
            },
        )

    # ------------------------------------------------------------------ allowances
    allowance_insert = sa.text(
        """
        INSERT INTO usage_limits (
            id, plan_code, internal_subject, dimension, window_kind, allowance
        ) VALUES (:id, :plan_code, :internal_subject, :dimension, :window_kind, :allowance)
        ON CONFLICT (id) DO NOTHING
        """
    ).bindparams(sa.bindparam("id", type_=postgresql.UUID(as_uuid=False)))
    for subject, dimensions in ALLOWANCES.items():
        internal = subject == INTERNAL_SUBJECT
        for dimension, allowance in dimensions.items():
            connection.execute(
                allowance_insert,
                {
                    "id": allowance_id(subject, dimension),
                    "plan_code": None if internal else subject,
                    "internal_subject": subject if internal else None,
                    "dimension": dimension,
                    "window_kind": DIMENSION_WINDOW[dimension],
                    "allowance": allowance,
                },
            )


def upgrade() -> None:
    seed(op.get_bind())


def downgrade() -> None:
    connection = op.get_bind()

    # Reverse dependency order. A foreign key refusing here means real data references the seed —
    # a plan somebody is assigned to, or a model something recorded usage against — and failing is
    # the right answer, because the alternative is deleting that data to remove a seed row.
    connection.execute(
        sa.text("DELETE FROM usage_limits WHERE id = ANY(:ids)").bindparams(
            sa.bindparam("ids", type_=postgresql.ARRAY(postgresql.UUID(as_uuid=False)))
        ),
        {
            "ids": [
                allowance_id(subject, dimension)
                for subject, dimensions in ALLOWANCES.items()
                for dimension in dimensions
            ]
        },
    )
    connection.execute(
        sa.text("DELETE FROM subscription_plans WHERE plan_code = ANY(:codes)").bindparams(
            sa.bindparam("codes", type_=_TEXT_ARRAY)
        ),
        {"codes": [plan_code for plan_code, *_ in PLANS]},
    )
    # Policies before the catalog they reference. The delete is set-based, so a policy and the
    # fallback it declares go in one statement and the self-referencing key never sees a
    # half-removed graph.
    connection.execute(
        sa.text("DELETE FROM model_policies WHERE policy_id = ANY(:ids)").bindparams(
            sa.bindparam("ids", type_=_TEXT_ARRAY)
        ),
        {"ids": [policy_id for policy_id, *_ in POLICIES]},
    )
    connection.execute(
        sa.text("DELETE FROM model_catalog WHERE catalog_key = ANY(:keys)").bindparams(
            sa.bindparam("keys", type_=_TEXT_ARRAY)
        ),
        {"keys": [catalog_key for catalog_key, *_ in CATALOG]},
    )
