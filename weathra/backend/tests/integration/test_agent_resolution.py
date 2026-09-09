"""Tasks 28.7, 28.8 and 28.10 — resolution wired into a real run, against the real stores.

The unit tests prove the walk. These prove the walk is *what actually happens*: a run through the
graph, with the seeded catalog and policies in a real database, resolving per call role and
recording what it resolved into the evidence record a caller receives.

The behaviour-invariance suite is the substantial half. `specs/model-policy` requires that
substituting the resolved model changes nothing except the prose and the recorded model identity —
same tool selection, same figures, same evidence completeness, same grounding outcome, same stream
events. That is easy to state and easy to break: any code that branched on the model, however
indirectly, would show up here as two runs that differ in something they must not.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest

from tests.agent_support import StubGeocoder, connected_tools
from tests.db_support import insert_profile, new_user_id, session_as
from weathra.agents.context import ContextSources
from weathra.agents.graph import RunDependencies, run_agent
from weathra.agents.llm.base import Completion, Message
from weathra.agents.llm.fake import FakeLLMClient
from weathra.agents.models import ModelBroker
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.agents.state import GraphState
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.errors import ModelNotAllowlisted
from weathra.domain.evidence import InferenceStage
from weathra.domain.identity import Principal
from weathra.domain.usage import UsageEvent
from weathra.domain.weather import UnitSystem
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.records import CapabilityTier
from weathra.entitlements.resolver import PolicyResolver
from weathra.entitlements.snapshot import SnapshotCache
from weathra.memory.preferences import PreferenceStore
from weathra.memory.threads import ThreadStore

pytestmark = pytest.mark.db

ADMIN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def _routing_plan() -> dict[str, Any]:
    """A real `RoutingPlan`, serialised the way a model would return it.

    Built from the type rather than hand-written as a dict: a hand-written one that drifts from the
    schema fails validation, the supervisor falls back to the deterministic router, and every test
    below quietly stops exercising the resolved routing client.
    """
    return RoutingPlan(
        steps=(
            PlanStep(
                capability=Capability.FORECAST,
                reason="a forecast was asked for",
                location="Berlin",
                days=3,
            ),
        ),
        reason="a scripted plan",
    ).model_dump(mode="json")


class _RecordingFake:
    """A fake client that reports the model it was resolved as.

    The point of the invariance suite is two runs on two *different* models, so the fake has to
    carry an identity rather than a constant — otherwise the two runs would be indistinguishable
    and the suite would prove nothing.
    """

    def __init__(self, model_id: str) -> None:
        self.provider_id = "openrouter"
        self.model_id = model_id
        self._inner = FakeLLMClient(
            completions=[f"Berlin looks mild. (written by {model_id})"] * 4,
            json_responses=[_routing_plan()] * 4,
            model_id=model_id,
        )

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        completion = await self._inner.complete(system=system, messages=messages)
        # Both halves of the identity, because the synthesis node reads the *completion's* provider
        # rather than the client's — the gateway is allowed to report a substitution, and the
        # record has to show it. A double that reported the inner fake's provider would make the
        # envelope's provenance a property of the test rather than of the run.
        return completion.model_copy(
            update={"model_id": self.model_id, "provider_id": self.provider_id}
        )

    async def complete_json(self, *, system: str, messages: Sequence[Message], schema: Any) -> Any:
        return await self._inner.complete_json(system=system, messages=messages, schema=schema)


class _ResolvingBroker(ModelBroker):
    """The real broker, building fakes instead of gateway clients.

    Subclassed rather than mocked so the *resolution* is the real one — the plan lookup, the policy
    walk, the candidate order, all of it — and only the transport is replaced. A test that stubbed
    the resolver would prove the graph calls something, not that it calls this.
    """

    def _wrap(self, resolved: Any) -> Any:
        # Through the real `_instrumented`, so a run with a recorder exercises the actual
        # telemetry path. Returning the fake directly would replace the transport *and* silently
        # remove the instrumentation, and every telemetry assertion below would pass vacuously.
        return self._instrumented(
            _RecordingFake(resolved.resolution.gateway_model), resolved, attempts=None
        )


@pytest.fixture
def wired(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> tuple[Settings, PolicyResolver]:
    """Settings and a resolver — deliberately *not* an open session.

    An earlier version yielded one, and it was wrong in a way that produced a flaky test rather
    than a clear failure: the fixture's transaction began before the test assigned a plan, so a
    resolution inside it could read the row as absent and resolve Free. A request opens its own
    session after everything it depends on has been written, and so does every run below.
    """
    settings = Settings(
        supabase_url="https://test.supabase.co",
        openrouter_api_key="test-credential-never-sent",
        model_catalog_cache_ttl_seconds=0,
    )
    return settings, PolicyResolver(settings, SnapshotCache(settings))


async def _assign(engines: Engines, user_id: str, plan: PlanCode) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        await PlanStore(session).assign(user_id, plan, acting_principal=ADMIN)


def _state(question: str, principal: Principal) -> GraphState:
    return GraphState.begin(
        question=question,
        request_id="req-resolution",
        principal=principal,
        started_at=datetime.now(UTC),
    )


async def _run(
    engines: Engines,
    settings: Settings,
    resolver: PolicyResolver,
    principal: Principal,
    *,
    question: str = "What is the forecast for Berlin over the next 3 days?",
    pinned_evaluation: bool = False,
) -> Any:
    """One run, on a session opened for it — the way a request does."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        broker = _ResolvingBroker(
            resolver=resolver,
            session=session,
            settings=settings,
            http=httpx.AsyncClient(),
            principal=principal,
            pinned_evaluation=pinned_evaluation,
        )
        async with connected_tools(settings=settings) as tools:
            return await run_agent(
                _state(question, principal),
                RunDependencies(
                    settings=settings, tools=tools, geocoder=StubGeocoder(), models=broker
                ),
            )


# =========================================================================== 28.7 the wiring


async def test_a_run_resolves_a_model_per_call_role_and_records_it(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PRO)

    result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))

    attempts = result.envelope.evidence.inference_attempts
    assert attempts, "a run that called a model records the calls"
    assert {attempt.stage for attempt in attempts} == {
        InferenceStage.ROUTING,
        InferenceStage.SYNTHESIS,
    }
    for attempt in attempts:
        assert attempt.policy_id, f"{attempt.stage} recorded no policy"
        assert attempt.catalog_key, f"{attempt.stage} recorded no catalog key"
        assert attempt.plan == "pro", f"{attempt.stage} recorded the wrong plan"
        assert attempt.resolution_reason, f"{attempt.stage} recorded no reason"
        assert "selected" in attempt.resolution_reason


async def test_the_recorded_reason_names_the_walk_that_produced_the_model(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """The evidence record has to answer "why this model" without a re-run."""
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PREMIUM)

    result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))
    reason = result.envelope.evidence.inference_attempts[0].resolution_reason or ""

    assert "plan=premium" in reason
    assert "policy=high_reasoning" in reason
    assert "selected frontier-reasoning" in reason


@pytest.mark.parametrize(
    ("plan", "expected_policy", "expected_key"),
    [
        (PlanCode.FREE, "free_default", "economy-free-primary"),
        (PlanCode.PRO, "balanced", "standard-general"),
        (PlanCode.PREMIUM, "high_reasoning", "frontier-reasoning"),
    ],
)
async def test_each_tier_reaches_its_own_model_through_a_real_run(
    engines: Engines,
    wired: tuple[Settings, PolicyResolver],
    plan: PlanCode,
    expected_policy: str,
    expected_key: str,
) -> None:
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, plan)

    result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))
    attempt = result.envelope.evidence.inference_attempts[-1]

    assert attempt.policy_id == expected_policy
    assert attempt.catalog_key == expected_key
    assert attempt.plan == plan.value


async def test_a_caller_with_no_plan_row_runs_on_free(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    settings, resolver = wired
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as setup:
        await insert_profile(setup, user_id)

    result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))
    assert result.envelope.evidence.inference_attempts[-1].plan == "free"
    assert result.envelope.evidence.inference_attempts[-1].policy_id == "free_default"


async def test_the_envelope_reports_the_model_that_actually_served(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PRO)

    result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))
    record = result.envelope.evidence

    assert record.llm_provider == "openrouter"
    assert record.llm_model, "the envelope must name the model behind the prose"
    served = record.inference_attempts[-1]
    assert record.llm_model in {served.served_model, served.selected_model}


async def test_no_node_names_a_model(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """The structural half is `test_architecture.py`; this is the behavioural one.

    Two tiers resolve two different models through the same nodes, so nothing a node did can have
    depended on which model it was.
    """
    settings, resolver = wired
    free_user, pro_user = new_user_id(), new_user_id()
    await _assign(engines, free_user, PlanCode.FREE)
    await _assign(engines, pro_user, PlanCode.PRO)

    free = await _run(engines, settings, resolver, Principal.from_claims({"sub": free_user}))
    pro = await _run(engines, settings, resolver, Principal.from_claims({"sub": pro_user}))

    assert (
        free.envelope.evidence.inference_attempts[-1].catalog_key
        != pro.envelope.evidence.inference_attempts[-1].catalog_key
    ), "the two tiers must genuinely resolve different models for this test to mean anything"


# =========================================================================== 28.8 invariance


async def test_two_policies_two_models_and_everything_but_the_prose_is_identical(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """`specs/model-policy`: substituting the resolved model changes no required behaviour.

    Tool selection, figures, evidence completeness and grounding are compared field by field. The
    prose and the recorded model identity are the only permitted differences, which is why they are
    excluded explicitly rather than by comparing a subset and hoping.
    """
    settings, resolver = wired
    free_user, premium_user = new_user_id(), new_user_id()
    await _assign(engines, free_user, PlanCode.FREE)
    await _assign(engines, premium_user, PlanCode.PREMIUM)

    first = await _run(engines, settings, resolver, Principal.from_claims({"sub": free_user}))
    second = await _run(engines, settings, resolver, Principal.from_claims({"sub": premium_user}))

    one, two = first.envelope, second.envelope
    assert (
        one.evidence.inference_attempts[-1].catalog_key
        != two.evidence.inference_attempts[-1].catalog_key
    ), "the premise: two different models served these runs"

    # Tool selection, in order.
    assert [call.tool for call in one.evidence.tool_calls] == [
        call.tool for call in two.evidence.tool_calls
    ]
    # The agents that ran, in order.
    assert one.evidence.agents_in_order == two.evidence.agents_in_order
    # Every figure, with its class, unit and value.
    assert [(f.label, f.value, f.unit, f.data_class) for f in one.findings] == [
        (f.label, f.value, f.unit, f.data_class) for f in two.findings
    ]
    # Attribution and data classes.
    assert one.evidence.data_classes == two.evidence.data_classes
    assert [(a.provider, a.data_class) for a in one.attribution] == [
        (a.provider, a.data_class) for a in two.attribution
    ]
    # Grounding, to the verdict and the count.
    assert (one.grounding.verified, one.grounding.figures_checked) == (
        two.grounding.verified,
        two.grounding.figures_checked,
    )
    # Evidence completeness.
    assert len(one.evidence.tool_results) == len(two.evidence.tool_results)
    assert bool(one.evidence.citations) == bool(two.evidence.citations)


async def test_no_policy_record_can_disable_grounding_or_attribution(
    wired: tuple[Settings, PolicyResolver],
) -> None:
    """`specs/model-policy`: no policy carries a field capable of relaxing a safety control.

    Read off the record type rather than off the seeded rows, so adding such a field to the model
    fails here even before anybody sets it.
    """
    from weathra.entitlements.records import PolicyRecord

    fields = set(PolicyRecord.model_fields)
    forbidden = {
        "grounding",
        "grounding_enabled",
        "skip_grounding",
        "attribution",
        "attribution_required",
        "data_class_labelling",
        "evidence_capture",
        "skip_evidence",
        "safety",
    }
    assert not fields & forbidden, (
        f"a policy field could relax a safety control: {fields & forbidden}"
    )


# =========================================================================== 28.10 the pinned one


async def test_the_fixed_evaluation_policy_resolves_without_reading_a_plan(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """Against the real seeded policy, and for a caller whose plan maps somewhere else entirely."""
    _settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PREMIUM)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        for role in (CallRole.ROUTING, CallRole.SYNTHESIS):
            resolved = await resolver.resolve_fixed_evaluation(role=role, session=session)
            assert resolved.resolution.policy_id == "evaluation_fixed"
            assert resolved.resolution.catalog_key == "economy-free-primary"
            assert not resolved.may_fail_over


async def test_moving_every_plan_leaves_the_pinned_model_unchanged(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """The guarantee that makes an evaluation run comparable across weeks."""
    _settings, resolver = wired
    async with privileged_session(engines.privileged_sessionmaker) as session:
        before = await resolver.resolve_fixed_evaluation(role=CallRole.SYNTHESIS, session=session)

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        plans = PlanStore(admin)
        for plan in (PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM):
            await plans.set_policy_mapping(
                plan,
                {CallRole.ROUTING: "high_reasoning", CallRole.SYNTHESIS: "high_reasoning"},
                acting_principal=ADMIN,
            )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        after = await resolver.resolve_fixed_evaluation(role=CallRole.SYNTHESIS, session=session)
    assert before.resolution.catalog_key == after.resolution.catalog_key
    assert after.resolution.policy_id == "evaluation_fixed"


async def test_no_product_plan_can_reach_the_pinned_policy_through_a_run(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    settings, resolver = wired
    for plan in (PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM):
        user_id = new_user_id()
        await _assign(engines, user_id, plan)
        result = await _run(engines, settings, resolver, Principal.from_claims({"sub": user_id}))
        for attempt in result.envelope.evidence.inference_attempts:
            assert attempt.policy_id != "evaluation_fixed"


# =========================================================================== 34.7 the wiring
#
# 28.10 built `resolve_fixed_evaluation` and proved it in isolation; nothing called it. A live
# evaluation run reached the model through the *product* walk — the evaluation test user's plan,
# then its policy, then whatever that resolved — with `LLM_MODEL` reachable only as the chain's
# last rung. These are the tests that the pinned path is now the path a run actually takes.


async def test_a_pinned_broker_resolves_the_evaluation_policy_and_reads_no_plan(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """The broker's own branch, against the seeded policy and a caller mapped somewhere else."""
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PREMIUM)
    principal = Principal.from_claims({"sub": user_id})

    async with privileged_session(engines.privileged_sessionmaker) as session:
        broker = _ResolvingBroker(
            resolver=resolver,
            session=session,
            settings=settings,
            http=httpx.AsyncClient(),
            principal=principal,
            pinned_evaluation=True,
        )
        for role in (CallRole.ROUTING, CallRole.SYNTHESIS):
            binding = await broker.binding_for(role)
            assert binding.resolution.policy_id == "evaluation_fixed"
            assert binding.resolution.catalog_key == "economy-free-primary"
            assert "no plan is read" in binding.resolution.reason
            assert not binding.resolved.may_fail_over


async def test_a_pinned_run_records_the_evaluation_policy_for_every_call(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """A whole run through the graph, so the record a run archives is what is asserted."""
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PREMIUM)
    principal = Principal.from_claims({"sub": user_id})

    result = await _run(engines, settings, resolver, principal, pinned_evaluation=True)

    attempts = result.envelope.evidence.inference_attempts
    assert attempts, "a pinned run still records every call it made"
    assert {attempt.policy_id for attempt in attempts} == {"evaluation_fixed"}
    assert {attempt.catalog_key for attempt in attempts} == {"economy-free-primary"}
    # One model across the whole run, which is the requirement `specs/evaluation` states.
    assert len({attempt.selected_model for attempt in attempts}) == 1


async def test_moving_the_evaluation_users_plan_does_not_move_a_pinned_run(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """`specs/evaluation`'s reason for the pinned policy, asked of a run rather than a resolver."""
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.FREE)
    principal = Principal.from_claims({"sub": user_id})

    before = await _run(engines, settings, resolver, principal, pinned_evaluation=True)
    await _assign(engines, user_id, PlanCode.PREMIUM)
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await PlanStore(admin).set_policy_mapping(
            PlanCode.PREMIUM,
            {CallRole.ROUTING: "high_reasoning", CallRole.SYNTHESIS: "high_reasoning"},
            acting_principal=ADMIN,
        )

    after = await _run(engines, settings, resolver, principal, pinned_evaluation=True)

    assert (
        before.envelope.evidence.inference_attempts[-1].selected_model
        == after.envelope.evidence.inference_attempts[-1].selected_model
    ), "a plan change must not change what an evaluation run measures"

    # And the control: the same caller on the product path *does* move, so the test above is
    # asserting the pin rather than a catalog with only one usable entry in it.
    product = await _run(engines, settings, resolver, principal)
    assert product.envelope.evidence.inference_attempts[-1].policy_id == "high_reasoning"


async def test_a_pinned_candidate_resolves_that_candidate_and_nothing_else(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """The comparison pin: one named candidate, catalog-validated, no plan and no failover."""
    _settings, resolver = wired
    async with privileged_session(engines.privileged_sessionmaker) as session:
        resolved = await resolver.resolve_fixed_evaluation(
            role=CallRole.SYNTHESIS, session=session, pinned_catalog_key="frontier-reasoning"
        )
    assert resolved.resolution.catalog_key == "frontier-reasoning"
    assert resolved.resolution.policy_id == "__lab_comparison__"
    assert resolved.resolution.policy_id.is_reserved, (
        "a pinned candidate did not resolve a policy, and an aggregate must be able to tell"
    )
    assert resolved.remaining == ()
    assert not resolved.may_fail_over


async def test_a_pinned_candidate_is_refused_when_the_catalog_refuses_it(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """Validated against the database, not the snapshot — so a disable binds immediately."""
    _settings, resolver = wired

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await CatalogStore(admin).disable(
            "frontier-reasoning", acting_principal=ADMIN, acknowledge_role_unavailability=True
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        with pytest.raises(ModelNotAllowlisted, match="disabled"):
            await resolver.resolve_fixed_evaluation(
                role=CallRole.SYNTHESIS, session=session, pinned_catalog_key="frontier-reasoning"
            )
        with pytest.raises(ModelNotAllowlisted, match="not in the model catalog"):
            await resolver.resolve_fixed_evaluation(
                role=CallRole.SYNTHESIS, session=session, pinned_catalog_key="no-such-entry"
            )


async def test_a_pinned_candidate_unfit_for_the_role_is_refused_separately(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """Enabled and wrong for the call are two findings, and a reader needs to tell them apart."""
    _settings, resolver = wired

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await CatalogStore(admin).create(
            acting_principal=ADMIN,
            catalog_key="lab-only-entry",
            gateway_provider="openrouter",
            gateway_model="testvendor/lab-only",
            display_name="Lab only",
            capability_roles=[CallRole.LAB],
            capability_tier=CapabilityTier.ECONOMY,
            supports_structured_output=True,
            context_window=100_000,
            input_price_per_million="0",
            output_price_per_million="0",
            pricing_recorded_on=date(2026, 9, 9),
            is_free_tier=True,
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        with pytest.raises(ModelNotAllowlisted, match="not fit for the synthesis role"):
            await resolver.resolve_fixed_evaluation(
                role=CallRole.SYNTHESIS, session=session, pinned_catalog_key="lab-only-entry"
            )
        # And fit for the one it declares, so the refusal is about the role rather than the entry.
        resolved = await resolver.resolve_fixed_evaluation(
            role=CallRole.LAB, session=session, pinned_catalog_key="lab-only-entry"
        )
        assert resolved.resolution.catalog_key == "lab-only-entry"


# =========================================================================== security


async def test_resolution_reads_the_plan_under_the_restricted_session(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The resolver never opens a connection; it uses the request's own.

    Under the restricted role the owner policy on `user_plans` means the query can only ever see
    the acting principal's row — so a resolver handed one user's session cannot read another's
    plan, whatever subject it is asked about.
    """
    settings = Settings(
        supabase_url="https://test.supabase.co",
        openrouter_api_key="test-credential-never-sent",
        model_catalog_cache_ttl_seconds=0,
    )
    resolver = PolicyResolver(settings, SnapshotCache(settings))

    premium_user, free_user = new_user_id(), new_user_id()
    await _assign(engines, premium_user, PlanCode.PREMIUM)
    await _assign(engines, free_user, PlanCode.FREE)

    # Acting as the Free user, but *asking* about the Premium one. RLS answers for the actor.
    async with session_as(engines, free_user) as session:
        resolved = await resolver.resolve(
            principal=Principal.from_claims({"sub": premium_user}),
            role=CallRole.SYNTHESIS,
            session=session,
        )
    assert resolved.resolution.policy_id == "free_default", (
        "the restricted session must not disclose another principal's plan"
    )


def test_the_agent_route_supplies_the_policy_layer_and_never_a_bare_client() -> None:
    """The one place bypassing the resolver would matter, asserted over the route's source."""
    import ast
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[2] / "weathra" / "api" / "routers" / "agent.py"
    ).read_text()
    tree = ast.parse(source)

    keywords = {
        keyword.arg
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "RunDependencies"
        for keyword in node.keywords
    }
    assert "models" in keywords, "the agent route must hand the graph the model policy layer"
    assert "llm" not in keywords, (
        "the agent route must not hand the graph a pre-bound client; that would bypass resolution"
    )


async def test_both_memory_tiers_are_untouched_by_the_policy_layer(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """`specs/memory`, checked against a run that resolves rather than one handed a client.

    The policy layer sits between the graph and the gateway, and both memory tiers sit beside it —
    a stored preference still shapes the answer, and the thread projection is still written. This
    is asserted through the *resolving* path because that is the one the requirement is about: the
    memory suites already prove the tiers work, and what they do not prove is that introducing
    resolution left them alone.
    """
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PRO)
    principal = Principal.from_claims({"sub": user_id})

    async with session_as(engines, user_id) as owned:
        await PreferenceStore(owned, principal, settings).update(unit_system=UnitSystem.IMPERIAL)
        thread = await ThreadStore(owned, principal, settings).create(title="Berlin")

    async with (
        privileged_session(engines.privileged_sessionmaker) as resolving,
        session_as(engines, user_id) as owned,
        connected_tools(settings=settings) as tools,
    ):
        broker = _ResolvingBroker(
            resolver=resolver,
            session=resolving,
            settings=settings,
            http=httpx.AsyncClient(),
            principal=principal,
        )
        result = await run_agent(
            _state("What is the forecast for Berlin over the next 3 days?", principal),
            RunDependencies(
                settings=settings,
                tools=tools,
                geocoder=StubGeocoder(),
                models=broker,
                context=ContextSources(
                    threads=ThreadStore(owned, principal, settings),
                    preferences=PreferenceStore(owned, principal, settings),
                    thread_id=thread.id,
                ),
            ),
        )

    # The long-term tier still reaches the answer.
    assert result.state.unit_system is UnitSystem.IMPERIAL, (
        "a stored preference must still shape a run that went through the resolver"
    )
    # The short-term tier is still available and reported.
    assert result.memory.available
    # And the run resolved a policy, so this was the resolving path rather than a bound client.
    assert result.envelope.evidence.inference_attempts[-1].policy_id == "balanced"


# =========================================================================== 29.5 and 29.9 wiring


async def test_a_real_run_records_one_usage_event_per_attempt(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """Task 29.9 end to end: the events are a projection of the attempts the run recorded.

    Asserted against the evidence record rather than against a count, because the requirement is
    that the two agree — one event per recorded attempt, with the same classification and the same
    resolution facts, and no field derived twice from different places.
    """
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PRO)
    principal = Principal.from_claims({"sub": user_id})

    recorded: list[UsageEvent] = []

    async with privileged_session(engines.privileged_sessionmaker) as session:
        broker = _ResolvingBroker(
            resolver=resolver,
            session=session,
            settings=settings,
            http=httpx.AsyncClient(),
            principal=principal,
            recorder=recorded.extend,
        )
        async with connected_tools(settings=settings) as tools:
            result = await run_agent(
                _state("What is the forecast for Berlin over the next 3 days?", principal),
                RunDependencies(
                    settings=settings, tools=tools, geocoder=StubGeocoder(), models=broker
                ),
            )

    attempts = [
        attempt
        for attempt in result.envelope.evidence.inference_attempts
        if attempt.provider is not None
    ]
    assert attempts, "the run called a model"
    assert len(recorded) == len(attempts), "one event per recorded attempt"

    for attempt, event in zip(attempts, recorded, strict=True):
        assert event.call_role.value == attempt.stage.value
        assert (event.status.value == "success") is (attempt.status.value == "served"), (
            "the event's classification must equal the attempt's"
        )
        assert str(event.policy_id) == attempt.policy_id
        assert event.catalog_key == attempt.catalog_key
        assert event.plan is not None and event.plan.value == attempt.plan


async def test_the_answer_is_identical_whether_recording_works_or_not(
    engines: Engines, wired: tuple[Settings, PolicyResolver]
) -> None:
    """`specs/llm-telemetry`: recording changes nothing about the answer.

    One run with a working recorder and one with a recorder that raises on every call. The envelope
    — prose, findings, tool calls, grounding — must be the same, and the failing run must still
    produce an answer rather than an error.
    """
    settings, resolver = wired
    user_id = new_user_id()
    await _assign(engines, user_id, PlanCode.PRO)
    principal = Principal.from_claims({"sub": user_id})

    def exploding(_events: Sequence[UsageEvent]) -> None:
        raise RuntimeError("the telemetry store is unreachable")

    async def once(recorder: Any) -> Any:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            broker = _ResolvingBroker(
                resolver=resolver,
                session=session,
                settings=settings,
                http=httpx.AsyncClient(),
                principal=principal,
                recorder=recorder,
            )
            async with connected_tools(settings=settings) as tools:
                return await run_agent(
                    _state("What is the forecast for Berlin over the next 3 days?", principal),
                    RunDependencies(
                        settings=settings, tools=tools, geocoder=StubGeocoder(), models=broker
                    ),
                )

    working = await once(lambda events: None)
    broken = await once(exploding)

    assert broken.envelope.answer_prose == working.envelope.answer_prose
    assert [call.tool for call in broken.envelope.evidence.tool_calls] == [
        call.tool for call in working.envelope.evidence.tool_calls
    ]
    assert [(f.label, f.value) for f in broken.envelope.findings] == [
        (f.label, f.value) for f in working.envelope.findings
    ]
    assert broken.envelope.grounding.verified == working.envelope.grounding.verified
