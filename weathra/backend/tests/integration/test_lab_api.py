"""Tasks 32.3 to 32.5, 32.9 and 32.10 — the lab through the real app.

The properties this file exists for are all about *what does not happen*: no gateway call for an
off-allowlist selection, no product plan touched by a lab run, no other person's data read, no
policy changed. Each of those is asserted by a count or by a row rather than by a status code,
because a status code cannot tell you what a request did on its way to producing one.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from tests.api_support import ApiFactory, ApiHarness
from tests.db_support import grant_administrator, new_user_id
from weathra.agents.llm.base import Completion, Message
from weathra.agents.llm.fake import FakeLLMClient
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

PREFIX = "/api/v1"
PACKAGE_ROOT = Path(__file__).resolve().parents[2] / "weathra"


def forecast_plan() -> dict[str, Any]:
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


class _CountingFake:
    """A scripted client that reports how many times a gateway was actually reached."""

    def __init__(self) -> None:
        self.provider_id = "fake"
        self.model_id = "weathra-fake-1"
        self.calls = 0
        self._inner = FakeLLMClient(
            completions=["Berlin looks mild."] * 24, json_responses=[forecast_plan()] * 24
        )

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        self.calls += 1
        return await self._inner.complete(system=system, messages=messages)

    async def complete_json(self, *, system: str, messages: Sequence[Message], schema: type):  # type: ignore[no-untyped-def]
        self.calls += 1
        return await self._inner.complete_json(system=system, messages=messages, schema=schema)


def with_inference(api_factory: ApiFactory, **overrides: object) -> Any:
    return api_factory(openrouter_api_key="test-credential-never-sent", **overrides)


def install(api: ApiHarness) -> _CountingFake:
    fake = _CountingFake()
    api.app.state.inference.override(fake)
    return fake


async def administrator(api: ApiHarness) -> str:
    subject = new_user_id()
    await grant_administrator(api.app.state.engines, subject)
    return subject


async def start(api: ApiHarness, subject: str, **body: Any) -> Any:
    return await api.client.post(
        f"{PREFIX}/admin/lab/comparisons", json=body, headers=api.authorize(subject=subject)
    )


# =========================================================================== 32.5 the surface


async def test_an_administrator_runs_a_comparison_and_reads_it_back(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """One question, two models, one run record with a result per model."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)

        started = await start(
            api,
            admin,
            catalog_keys=["standard-general", "frontier-reasoning"],
            question="What is the forecast for Berlin?",
        )
        assert started.status_code == 201, started.text[:400]
        run_id = started.json()["run"]["id"]

        read = await api.client.get(
            f"{PREFIX}/admin/lab/comparisons/{run_id}", headers=api.authorize(subject=admin)
        )
        listed = await api.client.get(
            f"{PREFIX}/admin/lab/comparisons", headers=api.authorize(subject=admin)
        )

    run = read.json()["run"]
    assert run["initiated_by"] == admin
    assert run["question"] == "What is the forecast for Berlin?"
    assert set(run["candidate_catalog_keys"]) == {"standard-general", "frontier-reasoning"}
    assert {result["catalog_key"] for result in run["results"]} == {
        "standard-general",
        "frontier-reasoning",
    }
    assert run["status"] in {"completed", "partial"}
    assert listed.json()["count"] == 1


async def test_every_candidate_saw_the_same_question(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """32.1's headline: the input is fixed, so only the model varies.

    Asserted from the record rather than from the code: the run states one question, and every
    result belongs to the same case within it.
    """
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        started = await start(
            api,
            admin,
            catalog_keys=["standard-general", "frontier-reasoning"],
            question="What is the forecast for Berlin?",
        )

    run = started.json()["run"]
    assert run["question"] is not None
    assert {result["case_id"] for result in run["results"]} == {"ad-hoc"}, (
        "the candidates ran different cases, so they are not comparable"
    )


async def test_the_run_record_states_the_catalog_it_relied_on(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: the catalog state, once, for the whole run — so a rerun is checkable."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        started = await start(api, admin, catalog_keys=["standard-general"], question="Berlin?")

    state = started.json()["run"]["catalog_state"]
    assert "standard-general" in state
    assert state["standard-general"]["status"] == "enabled"
    assert state["standard-general"]["gateway_model"]


@pytest.mark.parametrize(
    ("selection", "reason"),
    [(["not-a-model"], "absent"), (["frontier-reasoning"], "disabled")],
)
async def test_a_selection_outside_the_allowlist_is_refused_with_no_gateway_call(
    api_factory: ApiFactory, seeded_reference_data: None, selection: list[str], reason: str
) -> None:
    """`specs/model-lab`: refused with a structured error naming the reason, and *no call made*.

    The call count is the assertion. A status code cannot distinguish "refused before building a
    client" from "built three clients, called one, then refused".
    """
    async with with_inference(api_factory) as api:
        fake = install(api)
        admin = await administrator(api)

        if reason == "disabled":
            async with privileged_session(api.app.state.engines.privileged_sessionmaker) as s:
                await s.execute(
                    text("UPDATE model_catalog SET status='disabled' WHERE catalog_key = :k"),
                    {"k": selection[0]},
                )

        refused = await start(api, admin, catalog_keys=selection, question="Berlin?")

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            runs = await session.scalar(text("SELECT count(*) FROM model_comparison_runs"))

    assert refused.status_code == 400
    details = refused.json()["error"]["details"]
    assert details["reason"] == reason
    assert fake.calls == 0, "a gateway was reached for a selection outside the allowlist"
    assert runs == 0, "a refused selection opened a run record"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/admin/lab/comparisons"),
        ("GET", "/admin/lab/comparisons"),
        ("GET", "/admin/lab/comparisons/00000000-0000-4000-8000-000000000000"),
    ],
)
async def test_a_non_administrative_caller_is_refused_with_nothing_disclosed(
    api_factory: ApiFactory, seeded_reference_data: None, method: str, path: str
) -> None:
    """`specs/model-lab`: no model identifier, catalog metadata, or lab record is disclosed."""
    async with with_inference(api_factory) as api:
        install(api)
        ordinary = new_user_id()
        response = await api.client.request(
            method,
            f"{PREFIX}{path}",
            json={"catalog_keys": ["standard-general"], "question": "Berlin?"}
            if method == "POST"
            else None,
            headers=api.authorize(subject=ordinary),
        )

    assert response.status_code == 403
    rendered = response.text.lower()
    for leaked in ("standard-general", "frontier-reasoning", "nvidia", "openai", "gpt", "catalog"):
        assert leaked not in rendered, f"the refusal disclosed {leaked!r}"


async def test_an_unauthenticated_caller_is_refused(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        response = await api.client.post(
            f"{PREFIX}/admin/lab/comparisons",
            json={"catalog_keys": ["standard-general"], "question": "Berlin?"},
        )
    assert response.status_code == 401


async def test_a_token_asserting_the_role_reaches_no_lab_operation(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        install(api)
        response = await api.client.post(
            f"{PREFIX}/admin/lab/comparisons",
            json={"catalog_keys": ["standard-general"], "question": "Berlin?"},
            headers=api.authorize(
                subject=new_user_id(), app_metadata={"weathra_role": "administrator"}
            ),
        )
    assert response.status_code == 403


# =========================================================================== 32.3 the bounds


async def test_more_models_than_the_bound_is_refused_before_anything_runs(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory, model_lab_max_models=1) as api:
        fake = install(api)
        admin = await administrator(api)
        refused = await start(
            api,
            admin,
            catalog_keys=["standard-general", "frontier-reasoning"],
            question="Berlin?",
        )

    assert refused.status_code == 400
    assert refused.json()["error"]["details"]["bound"] == "model_lab_max_models"
    assert fake.calls == 0


async def test_more_cases_than_the_bound_is_refused(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory, model_lab_max_cases=1) as api:
        fake = install(api)
        admin = await administrator(api)
        refused = await start(api, admin, catalog_keys=["standard-general"], category="knowledge")

    assert refused.status_code == 400
    assert refused.json()["error"]["details"]["bound"] == "model_lab_max_cases"
    assert fake.calls == 0


async def test_an_exhausted_wall_clock_returns_a_partial_result_naming_what_completed(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: a partial result naming which model-and-case results completed.

    A budget of essentially nothing, so the clock is reached before the first cell — the shape a
    real exhaustion produces, without waiting fifteen minutes to produce it.
    """
    async with with_inference(api_factory, model_lab_time_budget_seconds=0.001) as api:
        install(api)
        admin = await administrator(api)
        started = await start(
            api,
            admin,
            catalog_keys=["standard-general", "frontier-reasoning"],
            question="Berlin?",
        )

    body = started.json()
    assert started.status_code == 201
    assert body["partial"] is True
    assert body["run"]["status"] in {"partial", "failed"}
    assert len(body["run"]["results"]) < 2, "the budget stopped nothing"


async def test_one_candidate_failing_does_not_stop_the_others(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: the run continues with the remaining models and records the failure."""

    class _OneBadModel:
        """Answers for every model but one, which raises. The shape of a real outage."""

        def __init__(self, broken: str) -> None:
            self.provider_id = "fake"
            self.model_id = "weathra-fake-1"
            self._broken = broken
            self._good = _CountingFake()

        async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
            if self._broken in str(system) + str(messages):  # pragma: no cover - not reached
                raise RuntimeError("this model is down")
            return await self._good.complete(system=system, messages=messages)

        async def complete_json(self, *, system: str, messages: Sequence[Message], schema: type):  # type: ignore[no-untyped-def]
            return await self._good.complete_json(system=system, messages=messages, schema=schema)

    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        started = await start(
            api,
            admin,
            catalog_keys=["standard-general", "frontier-reasoning"],
            question="Berlin?",
        )

    results = started.json()["run"]["results"]
    assert len({result["catalog_key"] for result in results}) == 2


# =========================================================================== 32.10 accounting


async def test_a_lab_run_is_accounted_internally_and_touches_no_product_plan(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab` and `specs/usage-limits`: internal, attributed, and no plan changes."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        person = new_user_id()
        # A product caller with real consumption, so "no product plan changed" is a comparison
        # rather than an observation about an empty table.
        assert (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "What is the forecast for Berlin?"},
                headers=api.authorize(subject=person),
            )
        ).status_code == 200

        before = await _counters(api)
        assert (
            await start(api, admin, catalog_keys=["standard-general"], question="Berlin?")
        ).status_code == 201
        await api.app.state.usage_recorder.drain()
        after = await _counters(api)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            events = (
                await session.execute(
                    text(
                        "SELECT user_id, subject_kind, is_internal, plan, policy_id "
                        "  FROM llm_usage_events WHERE policy_id = '__lab_comparison__'"
                    )
                )
            ).all()

    assert after.get(person) == before.get(person), "a lab run spent a person's allowance"
    assert after.get("internal", 0) > before.get("internal", 0), "the lab spent nothing internal"
    assert events, "the lab made calls and recorded none"
    for user_id, subject_kind, is_internal, plan, policy_id in events:
        assert subject_kind == "internal"
        assert is_internal is True
        assert plan is None, "a lab event carried a product plan"
        assert str(user_id) == admin, "the event lost the administrator who initiated it"
        assert policy_id == "__lab_comparison__", "a lab call was recorded as a resolved policy"


async def test_a_lab_run_is_refused_when_the_internal_allowance_is_exhausted(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """And product traffic is unaffected, which is the half that makes the separation worth having."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        person = new_user_id()

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            allowance = await session.scalar(
                text(
                    "SELECT allowance FROM usage_limits "
                    " WHERE internal_subject IS NOT NULL AND dimension = 'requests_per_day'"
                )
            )
            await session.execute(
                text(
                    "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                    "VALUES ('internal', 'requests_per_day', to_char(now(),'YYYY-MM-DD'), :c) "
                    "ON CONFLICT (subject, dimension, window_key) DO UPDATE "
                    "  SET consumed = excluded.consumed"
                ),
                {"c": int(allowance or 0)},
            )

        refused = await start(api, admin, catalog_keys=["standard-general"], question="Berlin?")
        product = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=person),
        )

    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "quota_exceeded"
    assert product.status_code == 200, "an exhausted internal allowance stopped product traffic"


# =========================================================================== 32.4 isolation


async def test_a_lab_run_reads_and_writes_no_other_persons_state(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: no other user's thread, memory, preference, saved location, evidence
    record or usage event is read, and none is written."""
    async with with_inference(api_factory) as api:
        install(api)
        person = new_user_id()
        headers = api.authorize(subject=person)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )
        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
        )
        asked = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?", "create_thread": True},
            headers=headers,
        )
        assert asked.status_code == 200
        before = await _person_state(api, person)

        admin = await administrator(api)
        started = await start(api, admin, catalog_keys=["standard-general"], question="Berlin?")
        assert started.status_code == 201
        after = await _person_state(api, person)

    assert after == before, "a lab run changed another person's state"
    assert person not in started.text, "a lab response named another subject"
    assert "imperial" not in started.text


async def test_a_lab_run_leaves_policy_catalog_and_plan_mappings_unchanged(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: the lab does not change production policy implicitly.

    And a concurrent product request resolves exactly as before — asserted by the model that
    served it being the same one either side of the run.
    """
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        person = new_user_id()

        before_state = await _policy_state(api)
        first = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=person),
        )

        assert (
            await start(
                api,
                admin,
                catalog_keys=["standard-general", "frontier-reasoning"],
                question="Berlin?",
            )
        ).status_code == 201

        after_state = await _policy_state(api)
        second = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=person),
        )

    assert after_state == before_state, "the lab changed policy, catalog or plan state"
    assert first.json()["answer"]["llm_model"] == second.json()["answer"]["llm_model"]


def test_no_lab_module_reaches_another_persons_data() -> None:
    """32.4 over the source, and the negative control that makes it worth running.

    The lab's cells run on the administrator's own restricted session, so Row Level Security is
    the primary gate. This is the second one: a module that never names a personal store cannot
    read one however the session is configured.
    """
    forbidden = ("ThreadStore", "PreferenceStore", "SavedLocationStore", "weathra.memory")
    lab = PACKAGE_ROOT / "lab"
    sources = {path.name: path.read_text(encoding="utf-8") for path in sorted(lab.rglob("*.py"))}
    assert sources, "the lab package was not found, so this checked nothing"

    found = [
        f"{name}:{needle}"
        for name, source in sources.items()
        for needle in forbidden
        if needle in source
    ]
    assert found == []

    # The control: the same check, pointed at source that does reach for one.
    offending = {"compare.py": "from weathra.memory.threads import ThreadStore\n"}
    caught = [
        f"{name}:{needle}"
        for name, source in offending.items()
        for needle in forbidden
        if needle in source
    ]
    assert caught, "a lab module reading another person's threads went undetected"


def test_the_lab_never_opens_the_privileged_connection_for_its_cells() -> None:
    """`specs/model-lab`: it does not use the privileged connection to reach user-owned rows.

    The lab package names neither the privileged session nor the session maker. The *router* does
    use the administrative session — for the operational run and result tables, which the request
    role holds `SELECT` on and nothing else — and it opens the administrator's own restricted
    session for the cells, which is the line this asserts stays drawn.
    """
    lab = PACKAGE_ROOT / "lab"
    for path in sorted(lab.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        assert "privileged_session" not in source, f"{path.name} opens the privileged connection"
        assert "privileged_sessionmaker" not in source

    router = (PACKAGE_ROOT / "api" / "routers" / "admin" / "lab.py").read_text(encoding="utf-8")
    assert "session_for(engines, principal)" in router, (
        "the lab's cells must run on the administrator's own restricted session"
    )


# =========================================================================== 32.9 promotion


async def test_a_candidate_that_failed_a_gating_criterion_is_not_promoted(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/evaluation`: not promoted on cost or latency alone, and the refusal names why."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            from weathra.lab.records import LabRecords

            await LabRecords(session).record_evaluation(
                catalog_key="frontier-reasoning",
                gateway_model="nvidia/nemotron-3-ultra",
                dataset_version="1.0.0",
                metrics={"groundedness": 0.4},
                criteria={"structured_json_reliability": True, "groundedness": False},
                passed=False,
            )

        refused = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={"candidate_catalog_keys": ["frontier-reasoning", "standard-general"]},
            headers=api.authorize(subject=admin),
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            candidates = await session.scalar(
                text("SELECT candidate_catalog_keys FROM model_policies WHERE policy_id='balanced'")
            )

    assert refused.status_code == 400
    details = refused.json()["error"]["details"]
    assert details["failed_criteria"]["frontier-reasoning"] == ["groundedness"]
    assert candidates != ["frontier-reasoning", "standard-general"], "the refusal did not hold"


async def test_the_gate_can_be_overridden_and_the_override_is_recorded(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A person who has read the evidence may promote anyway. What they may not do is do it
    silently, so the override lands in the audit trail beside the change."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            from weathra.lab.records import LabRecords

            await LabRecords(session).record_evaluation(
                catalog_key="frontier-reasoning",
                gateway_model="nvidia/nemotron-3-ultra",
                dataset_version="1.0.0",
                metrics={},
                criteria={"groundedness": False},
                passed=False,
            )

        promoted = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={
                "candidate_catalog_keys": ["frontier-reasoning"],
                "acknowledge_criteria_failure": True,
                "cited_comparison_run_ids": [],
            },
            headers=api.authorize(subject=admin),
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT after FROM admin_audit WHERE action='policy_edit' "
                        " ORDER BY created_at DESC"
                    )
                )
            ).all()

    assert promoted.status_code == 200
    overrides = [row[0] for row in rows if row[0] and row[0].get("criteria_gate") == "overridden"]
    assert overrides, "the override left no record"
    assert overrides[0]["failed_criteria"]["frontier-reasoning"] == ["groundedness"]


async def test_a_candidate_nobody_has_evaluated_is_not_refused(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The absence of evidence is not evidence of failure. Refusing here would make an evaluation
    a precondition for the policy membership it needs in order to happen."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        promoted = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={"candidate_catalog_keys": ["standard-general"]},
            headers=api.authorize(subject=admin),
        )
    assert promoted.status_code == 200


async def test_a_promotion_records_the_comparison_runs_it_cited(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: recorded with the acting principal, the change, and the cited run."""
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)
        started = await start(api, admin, catalog_keys=["standard-general"], question="Berlin?")
        run_id = started.json()["run"]["id"]

        promoted = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={
                "candidate_catalog_keys": ["standard-general"],
                "cited_comparison_run_ids": [run_id],
            },
            headers=api.authorize(subject=admin),
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            row = (
                await session.execute(
                    text(
                        "SELECT acting_principal, cited_comparison_run_ids FROM admin_audit "
                        " WHERE action = 'policy_edit' ORDER BY created_at DESC LIMIT 1"
                    )
                )
            ).first()

    assert promoted.status_code == 200
    assert row is not None
    assert str(row[0]) == admin
    assert list(row[1]) == [run_id]


# =========================================================================== 32.4 observability


async def test_the_catalog_listing_carries_each_models_latest_observation(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-catalog`: the outcome of the most recent evaluation, where recorded.

    A status says whether a model may serve; an observation says how it did when it last did.
    """
    async with with_inference(api_factory) as api:
        install(api)
        admin = await administrator(api)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            from weathra.lab.records import LabRecords

            await LabRecords(session).record_evaluation(
                catalog_key="standard-general",
                gateway_model="openai/gpt-oss-120b",
                dataset_version="1.0.0",
                metrics={"groundedness": 0.99},
                criteria={"structured_json_reliability": True, "groundedness": True},
                passed=True,
            )

        listed = await api.client.get(
            f"{PREFIX}/admin/models", headers=api.authorize(subject=admin)
        )

    body = listed.json()
    observations = body["observations"]
    assert observations["standard-general"]["passed"] is True
    assert observations["standard-general"]["dataset_version"] == "1.0.0"
    assert "frontier-reasoning" not in observations, (
        "a model nobody has evaluated is absent, not reported with a null verdict"
    )


# =========================================================================== helpers


async def _counters(api: ApiHarness) -> dict[str, int]:
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        rows = await session.execute(
            text("SELECT subject, consumed FROM usage_counters WHERE dimension='requests_per_day'")
        )
        return {row[0]: row[1] for row in rows}


async def _person_state(api: ApiHarness, user_id: str) -> dict[str, Any]:
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        rows = {}
        for table, column in (
            ("threads", "user_id"),
            ("preferences", "user_id"),
            ("saved_locations", "user_id"),
            ("agent_runs", "user_id"),
        ):
            rows[table] = await session.scalar(
                text(f"SELECT count(*) FROM {table} WHERE {column} = CAST(:u AS uuid)"),
                {"u": user_id},
            )
        rows["preference_units"] = await session.scalar(
            text("SELECT unit_system FROM preferences WHERE user_id = CAST(:u AS uuid)"),
            {"u": user_id},
        )
        return rows


async def _policy_state(api: ApiHarness) -> dict[str, Any]:
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        policies = (
            await session.execute(
                text(
                    "SELECT policy_id, candidate_catalog_keys, fallback_policy_id "
                    "  FROM model_policies ORDER BY policy_id"
                )
            )
        ).all()
        catalog = (
            await session.execute(
                text("SELECT catalog_key, status FROM model_catalog ORDER BY catalog_key")
            )
        ).all()
        plans = (
            await session.execute(
                text("SELECT plan_code, policy_by_call_role FROM subscription_plans ORDER BY 1")
            )
        ).all()
        return {
            "policies": [tuple(row) for row in policies],
            "catalog": [tuple(row) for row in catalog],
            "plans": [(row[0], row[1]) for row in plans],
        }
