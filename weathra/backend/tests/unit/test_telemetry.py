"""Tasks 29.2, 29.3, 29.4 and 29.9 — cost, the instrumented wrapper, and the projection.

Most of what follows is about the difference between *unknown* and *zero*. A telemetry layer that
conflated them would look complete and report confidently wrong totals: a hundred calls whose
gateway sent no usage would read as a hundred free ones, and nobody would notice because the number
looks like a number.

The other recurring theme is that nothing here may derive a fact twice. Task 29.9's rule is that
telemetry projects what the run recorded, so several tests assert on where a value came *from*
rather than only on what it is.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from pydantic import BaseModel

from weathra.agents.llm.attempts import GatewayAttempt, GatewayAttemptLog
from weathra.agents.llm.base import Completion, LLMClient, Message
from weathra.agents.llm.instrumented import InstrumentedLLMClient
from weathra.domain.entitlements import (
    CONFIGURED_FALLBACK_POLICY,
    CallRole,
    PlanCode,
    PolicyId,
    Resolution,
)
from weathra.domain.errors import (
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    ValidationFailed,
)
from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.domain.usage import FailureClass, SubjectKind, UsageEvent, UsageStatus
from weathra.telemetry.context import CallContext
from weathra.telemetry.cost import estimate
from weathra.telemetry.projection import project_attempt, project_run

GATEWAY = "openrouter"
USER = "11111111-1111-1111-1111-111111111111"


def _resolution(**overrides: Any) -> Resolution:
    fields: dict[str, Any] = {
        "policy_id": PolicyId("balanced"),
        "catalog_key": "standard-general",
        "gateway_provider": GATEWAY,
        "gateway_model": "testvendor/standard",
        "reason": "plan=pro; policy=balanced; selected standard-general",
        "call_role": CallRole.SYNTHESIS,
    }
    fields.update(overrides)
    return Resolution(**fields)


def _context(**overrides: Any) -> CallContext:
    fields: dict[str, Any] = {
        "call_role": CallRole.SYNTHESIS,
        "resolution": _resolution(),
        "user_id": USER,
        "subject_kind": SubjectKind.USER,
        "plan": PlanCode.PRO,
        "agent_run_id": "22222222-2222-4222-8222-222222222222",
        "request_id": "req-1",
    }
    fields.update(overrides)
    return CallContext(**fields)


def _attempt(**overrides: Any) -> InferenceAttempt:
    fields: dict[str, Any] = {
        "stage": InferenceStage.SYNTHESIS,
        "attempt_number": 1,
        "status": InferenceStatus.SERVED,
        "provider": GATEWAY,
        "selected_model": "testvendor/standard",
        "served_model": "testvendor/standard",
        "catalog_key": "standard-general",
        "policy_id": "balanced",
        "plan": "pro",
        "resolution_reason": "plan=pro; policy=balanced",
        "latency_ms": 812.5,
    }
    fields.update(overrides)
    return InferenceAttempt(**fields)


# =========================================================================== 29.2 cost


def test_cost_is_the_deterministic_computation_over_tokens_and_price() -> None:
    """`specs/llm-telemetry`'s worked example: 1,200 prompt and 400 completion tokens."""
    result = estimate(
        prompt_tokens=1_200,
        completion_tokens=400,
        input_price_per_million=Decimal("0.037"),
        output_price_per_million=Decimal("0.170"),
        currency="USD",
    )
    assert result is not None
    # (1200 * 0.037 + 400 * 0.170) / 1_000_000
    expected = (Decimal(1200) * Decimal("0.037") + Decimal(400) * Decimal("0.170")) / Decimal(
        1_000_000
    )
    assert result.amount == expected
    assert result.currency == "USD"
    assert result.input_price_per_million == Decimal("0.037")


def test_cost_uses_decimal_and_not_binary_floating_point() -> None:
    """A monthly total is thousands of additions; `0.1 + 0.2 != 0.3` in binary would compound."""
    result = estimate(
        prompt_tokens=1_000_000,
        completion_tokens=0,
        input_price_per_million=Decimal("0.1"),
        output_price_per_million=Decimal("0.2"),
        currency="USD",
    )
    assert result is not None
    assert isinstance(result.amount, Decimal)
    assert result.amount == Decimal("0.1"), "exact, not 0.10000000000000000555"


@pytest.mark.parametrize(
    ("prompt", "completion"),
    [(None, 400), (1200, None), (None, None)],
)
def test_unknown_tokens_produce_no_cost_rather_than_zero(
    prompt: int | None, completion: int | None
) -> None:
    assert (
        estimate(
            prompt_tokens=prompt,
            completion_tokens=completion,
            input_price_per_million=Decimal("1"),
            output_price_per_million=Decimal("1"),
            currency="USD",
        )
        is None
    )


def test_a_missing_price_produces_no_cost() -> None:
    """A catalog entry priced after the fact leaves its earlier calls uncosted, not free."""
    assert (
        estimate(
            prompt_tokens=10,
            completion_tokens=10,
            input_price_per_million=None,
            output_price_per_million=Decimal("1"),
            currency="USD",
        )
        is None
    )


def test_a_missing_currency_produces_no_cost() -> None:
    assert (
        estimate(
            prompt_tokens=10,
            completion_tokens=10,
            input_price_per_million=Decimal("1"),
            output_price_per_million=Decimal("1"),
            currency=None,
        )
        is None
    )


def test_a_zero_price_is_a_measured_zero_and_not_an_absence() -> None:
    """A free-tier model genuinely costs nothing, and reporting 0.00 for it is a fact.

    This is the case a falsiness check would get wrong, which is why the estimator tests for
    ``None`` rather than for truthiness.
    """
    result = estimate(
        prompt_tokens=5_000,
        completion_tokens=5_000,
        input_price_per_million=Decimal("0"),
        output_price_per_million=Decimal("0"),
        currency="USD",
    )
    assert result is not None
    assert result.amount == Decimal("0")


def test_a_free_tier_product_plan_is_not_a_zero_price() -> None:
    """Entitlement and provider cost are separate concepts.

    A Free-plan caller can be served by a paid model, and the cost of that call is not zero. The
    estimator never sees a plan, which is what makes the confusion impossible here.
    """
    import inspect

    assert "plan" not in inspect.signature(estimate).parameters
    priced = estimate(
        prompt_tokens=1000,
        completion_tokens=1000,
        input_price_per_million=Decimal("0.5"),
        output_price_per_million=Decimal("1.5"),
        currency="USD",
    )
    assert priced is not None and priced.amount > 0


@pytest.mark.parametrize(
    ("prompt", "completion", "input_price", "output_price"),
    [(-1, 10, "1", "1"), (10, 10, "-1", "1"), (10, 10, "1", "-1")],
)
def test_a_negative_input_produces_no_cost_rather_than_a_negative_charge(
    prompt: int, completion: int, input_price: str, output_price: str
) -> None:
    assert (
        estimate(
            prompt_tokens=prompt,
            completion_tokens=completion,
            input_price_per_million=Decimal(input_price),
            output_price_per_million=Decimal(output_price),
            currency="USD",
        )
        is None
    )


def test_re_pricing_the_catalog_cannot_change_an_estimate_already_made() -> None:
    """The price is an argument, so an already-computed estimate holds its own basis.

    That is what makes a recorded event immune to a later re-price: the row carries the number and
    the price it came from, and nothing recomputes it.
    """
    before = estimate(
        prompt_tokens=1000,
        completion_tokens=1000,
        input_price_per_million=Decimal("1"),
        output_price_per_million=Decimal("1"),
        currency="USD",
    )
    after = estimate(
        prompt_tokens=1000,
        completion_tokens=1000,
        input_price_per_million=Decimal("99"),
        output_price_per_million=Decimal("99"),
        currency="USD",
    )
    assert before is not None and after is not None
    assert before.amount != after.amount
    assert before.input_price_per_million == Decimal("1"), "the basis travels with the estimate"


# =========================================================================== 29.9 the projection


def test_an_event_takes_every_resolution_fact_from_the_recorded_attempt() -> None:
    """Task 29.9: project, never re-derive. Each field is traced to where it came from."""
    attempt = _attempt(policy_id="high_reasoning", catalog_key="frontier-reasoning", plan="premium")
    event = project_attempt(attempt, _context())

    assert event is not None
    assert event.policy_id == "high_reasoning", "the attempt's policy, not the context's"
    assert event.catalog_key == "frontier-reasoning"
    assert event.plan is PlanCode.PREMIUM
    assert event.gateway_provider == GATEWAY
    assert event.call_role is CallRole.SYNTHESIS
    assert event.latency_ms == 812.5


def test_the_projection_reads_no_catalog_and_resolves_no_plan() -> None:
    """Structural: the function takes no session and no snapshot, so it cannot look anything up."""
    import inspect

    parameters = set(inspect.signature(project_attempt).parameters)
    assert "session" not in parameters
    assert "snapshot" not in parameters
    assert "resolver" not in parameters


def test_the_served_model_wins_over_the_selected_one() -> None:
    """A gateway that substituted a model is a fact worth recording rather than smoothing over."""
    event = project_attempt(
        _attempt(selected_model="testvendor/asked", served_model="testvendor/answered"),
        _context(),
    )
    assert event is not None
    assert event.gateway_model == "testvendor/answered"


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (InferenceStatus.TIMEOUT, FailureClass.TIMEOUT),
        (InferenceStatus.RATE_LIMITED, FailureClass.GATEWAY_RATE_LIMIT),
        (InferenceStatus.MODEL_UNAVAILABLE, FailureClass.TRANSPORT),
        (InferenceStatus.PROVIDER_ERROR, FailureClass.TRANSPORT),
        (InferenceStatus.INVALID_OUTPUT, FailureClass.SCHEMA_VALIDATION),
    ],
)
def test_each_outcome_maps_to_its_failure_classification(
    status: InferenceStatus, expected: FailureClass
) -> None:
    event = project_attempt(_attempt(status=status, error_code="x"), _context())
    assert event is not None
    assert event.status is UsageStatus.FAILURE
    assert event.failure_class is expected


def test_a_failed_attempt_has_null_tokens_rather_than_zero() -> None:
    event = project_attempt(_attempt(status=InferenceStatus.TIMEOUT), _context())
    assert event is not None
    assert event.prompt_tokens is None
    assert event.total_tokens is None
    assert event.estimated_cost is None


def test_an_attempt_that_never_reached_a_gateway_records_no_usage() -> None:
    """A run with no credential still records the attempt in its evidence, so the reader knows why
    the prose was code-written. There is no *usage* to account for, and a row would put a call that
    never happened into a call count."""
    assert (
        project_attempt(
            InferenceAttempt(stage=InferenceStage.SYNTHESIS, status=InferenceStatus.NOT_CONFIGURED),
            _context(),
        )
        is None
    )


def test_an_internal_event_carries_no_plan() -> None:
    """`specs/usage-limits`: internal work is never attributed to a product tier."""
    event = project_attempt(_attempt(), _context(subject_kind=SubjectKind.INTERNAL, plan=None))
    assert event is not None
    assert event.plan is None
    assert event.is_internal


def test_a_principal_less_call_records_a_null_subject_and_not_a_placeholder() -> None:
    event = project_attempt(
        _attempt(), _context(user_id=None, subject_kind=SubjectKind.INTERNAL, plan=None)
    )
    assert event is not None
    assert event.user_id is None
    assert event.is_internal


def test_a_run_projects_one_event_per_recorded_attempt_in_order() -> None:
    """A failover produces two rows, and the pair is what makes the outage legible afterwards."""
    attempts = (
        _attempt(
            stage=InferenceStage.ROUTING,
            status=InferenceStatus.TIMEOUT,
            catalog_key="standard-general",
        ),
        _attempt(
            stage=InferenceStage.ROUTING,
            attempt_number=2,
            catalog_key="economy-free-primary",
            served_model="testvendor/economy",
        ),
        _attempt(),
    )
    events = project_run(attempts, _context())

    assert [event.call_role for event in events] == [
        CallRole.ROUTING,
        CallRole.ROUTING,
        CallRole.SYNTHESIS,
    ]
    assert [event.catalog_key for event in events] == [
        "standard-general",
        "economy-free-primary",
        "standard-general",
    ]
    assert [event.status for event in events] == [
        UsageStatus.FAILURE,
        UsageStatus.SUCCESS,
        UsageStatus.SUCCESS,
    ]
    assert [event.attempt for event in events] == [1, 2, 1]


def test_a_configured_fallback_records_the_reserved_indicator_and_not_a_policy() -> None:
    event = project_attempt(_attempt(policy_id=None), _context())
    assert event is not None
    assert event.policy_id == CONFIGURED_FALLBACK_POLICY
    assert event.policy_id.is_reserved


def test_an_event_carries_the_run_and_request_correlation() -> None:
    event = project_attempt(_attempt(), _context())
    assert event is not None
    assert event.agent_run_id == "22222222-2222-4222-8222-222222222222"
    assert event.request_id == "req-1"


def test_the_event_type_refuses_conversation_content() -> None:
    """`extra='forbid'` is what makes "no content in telemetry" structural rather than a habit."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        UsageEvent(
            event_id="e",
            user_id=USER,
            catalog_key="c",
            gateway_provider=GATEWAY,
            gateway_model="m",
            policy_id=PolicyId("balanced"),
            plan=PlanCode.FREE,
            call_role=CallRole.SYNTHESIS,
            latency_ms=1.0,
            status=UsageStatus.SUCCESS,
            created_at=datetime.now(UTC),
            prompt_text="what is the weather in Berlin",  # type: ignore[call-arg]
        )


# =========================================================================== 29.3 the wrapper


class _Scripted:
    """A client that answers, or raises, and optionally reports gateway attempts."""

    def __init__(
        self,
        *,
        outcome: Exception | Completion | None = None,
        log: GatewayAttemptLog | None = None,
        reports: Sequence[GatewayAttempt] = (),
        delay: float = 0.0,
    ) -> None:
        self.provider_id = GATEWAY
        self.model_id = "testvendor/standard"
        self._outcome = outcome
        self._log = log
        self._reports = list(reports)
        self._delay = delay

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        import asyncio

        if self._delay:
            await asyncio.sleep(self._delay)
        for report in self._reports:
            assert self._log is not None
            self._log.record(report)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome or Completion(
            text="warm", provider_id=self.provider_id, model_id=self.model_id
        )

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        for report in self._reports:
            assert self._log is not None
            self._log.record(report)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return schema.model_validate({})


def _instrumented(
    inner: Any, *, log: GatewayAttemptLog | None = None
) -> tuple[InstrumentedLLMClient, list[UsageEvent]]:
    recorded: list[UsageEvent] = []
    client = InstrumentedLLMClient(
        inner, context=_context(), recorder=recorded.extend, attempts=log
    )
    return client, recorded


def test_the_wrapper_satisfies_the_client_contract() -> None:
    client, _events = _instrumented(_Scripted())
    assert isinstance(client, LLMClient)
    assert client.provider_id == GATEWAY
    assert client.model_id == "testvendor/standard"


async def test_a_served_call_records_one_event() -> None:
    client, events = _instrumented(_Scripted())
    await client.complete(system="s", messages=[Message.user("q")])

    assert len(events) == 1
    assert events[0].status is UsageStatus.SUCCESS
    assert events[0].policy_id == "balanced"
    assert events[0].plan is PlanCode.PRO


async def test_the_recorded_latency_measures_the_inner_call() -> None:
    """`specs/llm-telemetry`: latency measures the gateway call and excludes the recording."""
    client, events = _instrumented(_Scripted(delay=0.05))
    await client.complete(system="s", messages=[Message.user("q")])

    assert events[0].latency_ms >= 50.0
    assert events[0].latency_ms < 5_000.0, "and is the call, not the whole test"


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (ProviderTimeout("slow"), FailureClass.TIMEOUT),
        (ProviderRateLimited("429", details={"status": 429}), FailureClass.GATEWAY_RATE_LIMIT),
        (ProviderUnavailable("gone", details={"status": 404}), FailureClass.TRANSPORT),
        (ProviderUnavailable("broken", details={"status": 502}), FailureClass.TRANSPORT),
        (ValidationFailed("bad json"), FailureClass.SCHEMA_VALIDATION),
    ],
)
async def test_a_failed_call_records_its_classification_and_still_raises(
    failure: Exception, expected: FailureClass
) -> None:
    client, events = _instrumented(_Scripted(outcome=failure))
    with pytest.raises(type(failure)):
        await client.complete(system="s", messages=[Message.user("q")])

    assert len(events) == 1, "a failure is recorded, not discarded"
    assert events[0].status is UsageStatus.FAILURE
    assert events[0].failure_class is expected
    assert events[0].prompt_tokens is None


async def test_gateway_reported_tokens_reach_the_event() -> None:
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[
            GatewayAttempt(
                attempt_number=1,
                status=InferenceStatus.SERVED,
                served_model="testvendor/standard",
                latency_ms=120.0,
                prompt_tokens=1_200,
                completion_tokens=400,
                total_tokens=1_600,
            )
        ],
    )
    client, events = _instrumented(inner, log=log)
    await client.complete(system="s", messages=[Message.user("q")])

    assert len(events) == 1
    assert (events[0].prompt_tokens, events[0].completion_tokens) == (1_200, 400)
    assert events[0].total_tokens == 1_600


async def test_a_gateway_that_reports_no_usage_leaves_the_tokens_null() -> None:
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[GatewayAttempt(attempt_number=1, status=InferenceStatus.SERVED, latency_ms=10.0)],
    )
    client, events = _instrumented(inner, log=log)
    await client.complete(system="s", messages=[Message.user("q")])

    assert events[0].prompt_tokens is None
    assert events[0].total_tokens is None
    assert events[0].estimated_cost is None


async def test_a_genuine_zero_token_count_is_recorded_as_zero() -> None:
    """Unknown and zero are different, and a gateway that says zero is saying something."""
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[
            GatewayAttempt(
                attempt_number=1,
                status=InferenceStatus.SERVED,
                latency_ms=10.0,
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
            )
        ],
    )
    client, events = _instrumented(inner, log=log)
    await client.complete(system="s", messages=[Message.user("q")])

    assert events[0].prompt_tokens == 0
    assert events[0].total_tokens == 0


# =========================================================================== 29.4 retries


async def test_a_schema_retry_emits_its_own_event_linked_to_the_one_it_retried() -> None:
    """The reliability criterion of `specs/evaluation`: two tries is two events, not one outcome."""
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[
            GatewayAttempt(
                attempt_number=1,
                status=InferenceStatus.INVALID_OUTPUT,
                error_code="validation_failed",
                latency_ms=90.0,
            ),
            GatewayAttempt(
                attempt_number=2,
                status=InferenceStatus.SERVED,
                served_model="testvendor/standard",
                latency_ms=110.0,
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
            ),
        ],
    )

    class _Empty(BaseModel):
        pass

    client, events = _instrumented(inner, log=log)
    await client.complete_json(system="s", messages=[Message.user("q")], schema=_Empty)

    assert len(events) == 2
    first, second = events
    assert first.status is UsageStatus.FAILURE
    assert first.failure_class is FailureClass.SCHEMA_VALIDATION
    assert second.status is UsageStatus.SUCCESS
    assert second.attempt == 2
    assert second.retried_event_id == first.event_id, "the pair reconstructs 'needed two tries'"


async def test_each_reported_attempt_carries_its_own_latency() -> None:
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[
            GatewayAttempt(
                attempt_number=1, status=InferenceStatus.INVALID_OUTPUT, latency_ms=90.0
            ),
            GatewayAttempt(attempt_number=2, status=InferenceStatus.SERVED, latency_ms=110.0),
        ],
    )

    class _Empty(BaseModel):
        pass

    client, events = _instrumented(inner, log=log)
    await client.complete_json(system="s", messages=[Message.user("q")], schema=_Empty)

    assert [event.latency_ms for event in events] == [90.0, 110.0]


async def test_the_attempt_log_is_cleared_between_calls() -> None:
    """A call that raised before draining must not leave entries for the next one to claim."""
    log = GatewayAttemptLog()
    inner = _Scripted(
        log=log,
        reports=[GatewayAttempt(attempt_number=1, status=InferenceStatus.SERVED, latency_ms=5.0)],
    )
    client, events = _instrumented(inner, log=log)

    await client.complete(system="s", messages=[Message.user("one")])
    await client.complete(system="s", messages=[Message.user("two")])

    assert len(events) == 2, "two calls, two events — not one call's entries counted twice"
    assert len(log) == 0
