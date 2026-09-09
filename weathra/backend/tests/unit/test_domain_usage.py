"""Task 26.1 — the usage event and the quota vocabulary.

The validators are the substance here. A usage event is written on a background task outside the
answer path (design.md decision 24), so a malformed one raises nothing where it was produced and
turns up much later as an aggregate that does not add up. Every rejection below is for a
combination that is *plausible* rather than absurd — zero tokens standing in for unknown ones, an
internal event carrying a plan, a failure with no classification.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from weathra.domain import usage as u
from weathra.domain.entitlements import CallRole, PlanCode, PolicyId

UTC_MOMENT = datetime(2026, 9, 9, 22, 30, tzinfo=UTC)


def _event(**overrides: object) -> u.UsageEvent:
    fields: dict[str, object] = {
        "event_id": "aaaaaaaa-0000-0000-0000-000000000001",
        "user_id": "11111111-1111-1111-1111-111111111111",
        "catalog_key": "economy-free-primary",
        "gateway_provider": "openrouter",
        "gateway_model": "vendor/model:free",
        "policy_id": PolicyId("free_default"),
        "plan": PlanCode.FREE,
        "call_role": CallRole.SYNTHESIS,
        "latency_ms": 812.5,
        "status": u.UsageStatus.SUCCESS,
        "created_at": UTC_MOMENT,
    }
    fields.update(overrides)
    return u.UsageEvent(**fields)


# =========================================================================== the record itself


def test_a_usage_event_is_frozen() -> None:
    event = _event()
    with pytest.raises(ValidationError):
        event.status = u.UsageStatus.FAILURE  # type: ignore[misc]


def test_a_usage_event_refuses_an_unknown_field() -> None:
    """``extra='forbid'`` is what stops a prompt or a completion being attached to a record that
    is required to hold no conversation content."""
    with pytest.raises(ValidationError):
        _event(prompt_text="what is the weather in Berlin")


def test_a_complete_successful_event_records_every_dimension() -> None:
    """The provenance `specs/llm-telemetry` requires: who, which model, which policy, which plan,
    which role, what it cost, and how long it took."""
    event = _event(
        prompt_tokens=1200,
        completion_tokens=400,
        total_tokens=1600,
        estimated_cost=Decimal("0.00012"),
        cost_currency="USD",
    )
    assert event.user_id == "11111111-1111-1111-1111-111111111111"
    assert event.catalog_key == "economy-free-primary"
    assert event.gateway_model == "vendor/model:free"
    assert event.policy_id == "free_default"
    assert event.plan is PlanCode.FREE
    assert event.call_role is CallRole.SYNTHESIS
    assert not event.is_internal


# =========================================================================== failure recording


def test_a_failure_must_carry_a_classification() -> None:
    with pytest.raises(ValidationError, match="failure classification"):
        _event(status=u.UsageStatus.FAILURE)


def test_a_success_must_not_carry_a_classification() -> None:
    with pytest.raises(ValidationError, match="must not carry a failure classification"):
        _event(failure_class=u.FailureClass.TIMEOUT)


def test_an_unclassified_failure_says_so_explicitly() -> None:
    """ "It failed somehow" is a value, not an empty column."""
    event = _event(status=u.UsageStatus.FAILURE, failure_class=u.FailureClass.UNCLASSIFIED)
    assert event.failure_class is u.FailureClass.UNCLASSIFIED


def test_only_transport_and_timeout_are_infrastructure_failures() -> None:
    """The classification that decides whether a call may move to another candidate. A gateway
    rate limit is a property of the account, and a schema failure is a judgement about output —
    `specs/model-policy` forbids either from selecting a model."""
    infrastructure = {cls for cls in u.FailureClass if cls.is_infrastructure}
    assert infrastructure == {u.FailureClass.TRANSPORT, u.FailureClass.TIMEOUT}
    assert not u.FailureClass.GATEWAY_RATE_LIMIT.is_infrastructure
    assert not u.FailureClass.SCHEMA_VALIDATION.is_infrastructure


def test_a_retry_names_the_event_it_retried_and_its_attempt_number() -> None:
    retry = _event(
        event_id="aaaaaaaa-0000-0000-0000-000000000002",
        attempt=2,
        retried_event_id="aaaaaaaa-0000-0000-0000-000000000001",
    )
    assert retry.attempt == 2
    assert retry.retried_event_id == "aaaaaaaa-0000-0000-0000-000000000001"


def test_a_retry_cannot_be_a_first_attempt() -> None:
    with pytest.raises(ValidationError, match="attempt 2 or later"):
        _event(retried_event_id="aaaaaaaa-0000-0000-0000-000000000009")


def test_an_event_cannot_be_its_own_retry() -> None:
    with pytest.raises(ValidationError, match="its own retry"):
        _event(attempt=2, retried_event_id="aaaaaaaa-0000-0000-0000-000000000001")


# =========================================================================== ownership


def test_an_event_with_no_principal_is_internal_rather_than_ownerless() -> None:
    """`specs/llm-telemetry`: a call with no principal records a null subject and never a
    placeholder. Decision 27 classifies exactly that row as internal."""
    event = _event(user_id=None, subject_kind=u.SubjectKind.INTERNAL, plan=None)
    assert event.user_id is None
    assert event.is_internal


def test_a_user_subject_event_needs_its_owner() -> None:
    with pytest.raises(ValidationError, match="needs the acting principal"):
        _event(user_id=None, plan=None)


def test_an_administrator_on_a_product_path_is_internal_and_carries_no_plan() -> None:
    """`specs/usage-limits`: administrative work is accounted against the internal allowance even
    when the principal is a perfectly ordinary user with a plan."""
    event = _event(subject_kind=u.SubjectKind.INTERNAL, plan=None)
    assert event.user_id is not None
    assert event.is_internal


def test_an_internal_event_may_not_be_attributed_to_a_plan() -> None:
    with pytest.raises(ValidationError, match="never be attributed to a product plan"):
        _event(subject_kind=u.SubjectKind.INTERNAL, plan=PlanCode.PRO)


def test_a_product_event_must_record_the_plan_in_effect() -> None:
    with pytest.raises(ValidationError, match="must record the plan"):
        _event(plan=None)


def test_the_internal_subject_can_never_be_mistaken_for_an_auth_subject() -> None:
    """A Supabase subject is a UUID; the reserved internal subject deliberately is not, which is
    what makes every owner policy deny the internal rows without a clause of its own."""
    import uuid

    with pytest.raises(ValueError):
        uuid.UUID(u.INTERNAL_SUBJECT)


# =========================================================================== tokens and cost


def test_token_counts_must_add_up() -> None:
    with pytest.raises(ValidationError, match="must be prompt_tokens"):
        _event(prompt_tokens=1200, completion_tokens=400, total_tokens=1500)


def test_unknown_token_counts_are_null_and_not_zero() -> None:
    event = _event(status=u.UsageStatus.FAILURE, failure_class=u.FailureClass.TIMEOUT)
    assert event.prompt_tokens is None
    assert event.total_tokens is None
    assert event.estimated_cost is None


def test_cost_cannot_be_claimed_without_token_counts() -> None:
    """Cost is a deterministic function of counts and price. With no counts there is no cost, and
    zero would be a claim rather than the absence of one."""
    with pytest.raises(ValidationError, match="cannot be computed without token counts"):
        _event(estimated_cost=Decimal("0.001"), cost_currency="USD")


def test_a_cost_and_its_currency_are_recorded_together() -> None:
    with pytest.raises(ValidationError, match="recorded together or not at all"):
        _event(prompt_tokens=1, completion_tokens=1, total_tokens=2, estimated_cost=Decimal("0.5"))


@pytest.mark.parametrize(
    "field", ["prompt_tokens", "completion_tokens", "total_tokens", "estimated_cost", "latency_ms"]
)
def test_a_negative_measurement_is_refused(field: str) -> None:
    with pytest.raises(ValidationError):
        _event(**{field: -1})


# =========================================================================== quota dimensions


def test_every_dimension_the_spec_names_is_present() -> None:
    assert {dimension.value for dimension in u.QuotaDimension} == {
        "requests_per_day",
        "requests_per_month",
        "tokens_per_month",
        "concurrent_runs",
        "estimated_cost_per_month",
    }


def test_a_cost_budget_dimension_is_representable_without_restructuring() -> None:
    """`specs/usage-limits` requires the allowance model to admit one. It does — the dimension
    exists and carries a window like any other. Nothing seeds an allowance for it, because this
    change ships no billing and an estimate is the wrong thing to refuse a request on."""
    cost = u.QuotaDimension.ESTIMATED_COST_PER_MONTH
    assert cost.window is u.QuotaWindow.MONTH
    assert not cost.is_reservable


def test_each_dimension_declares_the_window_it_is_counted_over() -> None:
    assert u.QuotaDimension.REQUESTS_PER_DAY.window is u.QuotaWindow.DAY
    assert u.QuotaDimension.REQUESTS_PER_MONTH.window is u.QuotaWindow.MONTH
    assert u.QuotaDimension.TOKENS_PER_MONTH.window is u.QuotaWindow.MONTH
    assert u.QuotaDimension.CONCURRENT_RUNS.window is u.QuotaWindow.CONCURRENT


def test_only_the_countable_up_front_dimensions_are_reservable() -> None:
    """A token count is not known until the call returns, so it is pre-checked and settled
    afterwards — the bounded overshoot decision 25 states rather than hides."""
    reservable = {dimension for dimension in u.QuotaDimension if dimension.is_reservable}
    assert reservable == {
        u.QuotaDimension.REQUESTS_PER_DAY,
        u.QuotaDimension.REQUESTS_PER_MONTH,
        u.QuotaDimension.CONCURRENT_RUNS,
    }


# =========================================================================== window keys


def test_a_day_key_is_the_local_calendar_date() -> None:
    assert u.WindowKey.for_window(u.QuotaWindow.DAY, UTC_MOMENT, UTC) == "2026-09-09"


def test_a_month_key_is_the_local_year_and_month() -> None:
    assert u.WindowKey.for_window(u.QuotaWindow.MONTH, UTC_MOMENT, UTC) == "2026-09"


def test_the_window_is_computed_in_the_configured_zone_and_not_the_servers() -> None:
    """22:30 UTC on the 9th is already the 10th in Auckland. A day boundary that depended on where
    the process happened to run would let two instances disagree about someone's remaining
    allowance."""
    auckland = ZoneInfo("Pacific/Auckland")
    assert u.WindowKey.for_window(u.QuotaWindow.DAY, UTC_MOMENT, auckland) == "2026-09-10"
    assert u.WindowKey.for_window(u.QuotaWindow.DAY, UTC_MOMENT, UTC) == "2026-09-09"


def test_a_month_boundary_is_also_resolved_in_the_configured_zone() -> None:
    last_moment = datetime(2026, 9, 30, 23, 30, tzinfo=UTC)
    assert u.WindowKey.for_window(u.QuotaWindow.MONTH, last_moment, UTC) == "2026-09"
    assert (
        u.WindowKey.for_window(u.QuotaWindow.MONTH, last_moment, ZoneInfo("Pacific/Auckland"))
        == "2026-10"
    )


def test_concurrency_has_a_fixed_key_because_it_has_no_window() -> None:
    """It is a live gauge, not a calendar period — but the column is part of a uniqueness
    constraint, and a NULL there would stop two rows being duplicates in PostgreSQL."""
    key = u.WindowKey.for_dimension(u.QuotaDimension.CONCURRENT_RUNS, UTC_MOMENT, UTC)
    assert key == "current"


def test_a_naive_instant_is_refused_rather_than_guessed_at() -> None:
    with pytest.raises(ValueError, match="aware instant"):
        u.WindowKey.for_window(u.QuotaWindow.DAY, datetime(2026, 9, 9, 22, 30), UTC)


def test_a_window_key_is_immutable_and_never_blank() -> None:
    key = u.WindowKey("2026-09")
    with pytest.raises(AttributeError):
        key.value = "2026-10"  # type: ignore[attr-defined]
    with pytest.raises(ValueError, match="cannot be blank"):
        u.WindowKey("   ")


def test_the_key_for_a_dimension_matches_the_key_for_its_window() -> None:
    for dimension in u.QuotaDimension:
        assert u.WindowKey.for_dimension(dimension, UTC_MOMENT, UTC) == u.WindowKey.for_window(
            dimension.window, UTC_MOMENT, UTC
        )
