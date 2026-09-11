"""Tasks 31.3 to 31.7 — the administrative surface through the real app.

Two halves, and the first is the larger one on purpose.

**The authorization matrix.** Every administrative operation, refused for an anonymous caller, for
an ordinary one, for a Free one, for a Pro one, for a Premium one, and for one whose token asserts
the role. Driven off the registered routes rather than a list here, so an endpoint added without a
role check fails this suite rather than quietly shipping — which is the failure mode a hand-written
list produces the first time somebody adds a route and forgets to add a row.

A paid subscription is a *plan*, and a plan is not a role. The Pro and Premium cases exist to say
so out loud: the two are separate tables, separate questions, and separate answers, and a system
where money bought administration would look exactly like this one until somebody tried it.

**What administration cannot reach.** `specs/authentication` requires that holding the role grants
no access to another person's data, and 31.7 requires no administrative path to reach a user-owned
row through the privileged connection. Both are asserted here — the first behaviourally, by an
administrator being refused another person's records exactly as anyone would be, and the second
over the source and over the responses.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from tests.api_support import ApiFactory, ApiHarness
from tests.db_support import grant_administrator, new_user_id
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.api.classification import classifications
from weathra.db.session import privileged_session
from weathra.domain.entitlements import PlanCode

pytestmark = pytest.mark.db

PREFIX = "/api/v1"
PACKAGE_ROOT = Path(__file__).resolve().parents[2] / "weathra"

# The token claim groups 28 to 30 honoured. It grants nothing now, and every refusal below is
# asserted against it as well as against a bare token.
ASSERTED_ROLE_CLAIM = {"app_metadata": {"weathra_role": "administrator"}}

# Every administrative operation, with a body where one is required. Written once and reused by
# every case in the matrix, so a new endpoint is added in exactly one place.
OPERATIONS: tuple[tuple[str, str, dict[str, Any] | None], ...] = (
    ("GET", "/admin/models", None),
    (
        "POST",
        "/admin/models",
        {
            "catalog_key": "probe-entry",
            "gateway_provider": "openrouter",
            "gateway_model": "probe/model",
            "display_name": "Probe",
            "capability_roles": ["synthesis"],
            "capability_tier": "standard",
            "supports_structured_output": True,
            "context_window": 8000,
            "input_price_per_million": "0.1",
            "output_price_per_million": "0.2",
            "pricing_recorded_on": "2026-09-09",
            "is_free_tier": False,
        },
    ),
    ("PATCH", "/admin/models/standard-general", {"display_name": "Renamed"}),
    ("POST", "/admin/models/standard-general/enable", None),
    ("POST", "/admin/models/standard-general/disable", None),
    ("GET", "/admin/policies", None),
    (
        "POST",
        "/admin/policies",
        {
            "policy_id": "probe_policy",
            "display_name": "Probe",
            "candidate_catalog_keys": ["standard-general"],
            "applicable_call_roles": ["synthesis"],
            "eligibility": "public",
        },
    ),
    (
        "PUT",
        "/admin/policies/balanced/candidates",
        {"candidate_catalog_keys": ["standard-general"]},
    ),
    ("PUT", "/admin/policies/balanced/fallback", {"fallback_policy_id": None}),
    ("GET", "/admin/policies/free_default/audit", None),
    ("GET", "/admin/plans", None),
    ("PUT", "/admin/plans/free/policies", {"policy_by_call_role": {"synthesis": "free_default"}}),
    (
        "PUT",
        "/admin/plans/free/allowances",
        {"dimension": "requests_per_day", "allowance": 30},
    ),
    ("GET", "/admin/allowances", None),
    (
        "PUT",
        "/admin/allowances/internal",
        {"dimension": "requests_per_day", "allowance": 3000},
    ),
    # Task 34.22: the listing the plan-management screen reads. A subject and a tier — Weathra
    # holds no contact detail, so there is none here to withhold from a non-administrator either.
    ("GET", "/admin/principals", None),
    ("GET", "/admin/principals/administrators", None),
    (
        "PUT",
        f"/admin/principals/{'11111111-2222-4333-8444-555555555555'}/plan",
        {"plan_code": "pro"},
    ),
    ("PUT", f"/admin/principals/{'11111111-2222-4333-8444-555555555555'}/role", None),
    ("DELETE", f"/admin/principals/{'11111111-2222-4333-8444-555555555555'}/role", None),
    ("GET", "/admin/usage", None),
    # The trend the administrative screen leads with. Aggregates the same table as the row
    # above and discloses the same nothing, and is listed here because this matrix is what
    # holds every administrative operation to refusing an ordinary caller.
    ("GET", "/admin/usage/series", None),
    ("GET", "/admin/lab/comparisons", None),
    (
        "POST",
        "/admin/lab/comparisons",
        {"catalog_keys": ["standard-general"], "question": "What is the forecast for Berlin?"},
    ),
    (
        "GET",
        f"/admin/lab/comparisons/{'11111111-2222-4333-8444-555555555555'}",
        None,
    ),
)


def forecast_plan() -> dict[str, Any]:
    """A real `RoutingPlan`, serialised the way a model would return it.

    Built from the type rather than hand-written: a dict that drifts from the schema fails
    validation, the supervisor falls back to the deterministic router, and the run quietly stops
    exercising the resolved client the usage assertions depend on.
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


def with_inference(api_factory: ApiFactory, **overrides: object) -> Any:
    return api_factory(openrouter_api_key="test-credential-never-sent", **overrides)


async def administrator(api: ApiHarness) -> str:
    subject = new_user_id()
    await grant_administrator(api.app.state.engines, subject)
    return subject


async def on_plan(api: ApiHarness, plan: PlanCode) -> str:
    """An ordinary caller with a real plan row. Paying for Premium is not a promotion."""
    subject = new_user_id()
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        await session.execute(
            text("INSERT INTO profiles (user_id) VALUES (CAST(:u AS uuid)) ON CONFLICT DO NOTHING"),
            {"u": subject},
        )
        await session.execute(
            text(
                "INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), :p) "
                "ON CONFLICT (user_id) DO UPDATE SET plan_code = excluded.plan_code"
            ),
            {"u": subject, "p": plan.value},
        )
    return subject


async def call(
    api: ApiHarness,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return await api.client.request(method, f"{PREFIX}{path}", json=body, headers=headers or {})


# =========================================================================== 31.7 the matrix


@pytest.mark.parametrize(("method", "path", "body"), OPERATIONS, ids=lambda value: str(value))
async def test_an_unauthenticated_caller_is_refused_every_operation(
    api_factory: ApiFactory,
    seeded_reference_data: None,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    async with with_inference(api_factory) as api:
        response = await call(api, method, path, body)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_missing"


@pytest.mark.parametrize(("method", "path", "body"), OPERATIONS, ids=lambda value: str(value))
async def test_an_ordinary_caller_is_refused_every_operation(
    api_factory: ApiFactory,
    seeded_reference_data: None,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    async with with_inference(api_factory) as api:
        subject = new_user_id()
        response = await call(api, method, path, body, api.authorize(subject=subject))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize("plan", [PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM])
async def test_no_plan_buys_administration(
    api_factory: ApiFactory, seeded_reference_data: None, plan: PlanCode
) -> None:
    """A subscription is a plan; administration is a role. Two tables, two questions.

    Premium is the one worth checking hardest: it is the tier a person can be moved to, and a
    system where the top tier quietly implied the role would look exactly like this one right up
    until somebody paid for it.
    """
    async with with_inference(api_factory) as api:
        subject = await on_plan(api, plan)
        headers = api.authorize(subject=subject)
        refusals = [
            (await call(api, method, path, body, headers)).status_code
            for method, path, body in OPERATIONS
        ]

    assert set(refusals) == {403}, f"{plan.value} reached an administrative operation"


@pytest.mark.parametrize(("method", "path", "body"), OPERATIONS, ids=lambda value: str(value))
async def test_a_token_asserting_the_role_is_refused_every_operation(
    api_factory: ApiFactory,
    seeded_reference_data: None,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    """The forged-role case, in the shape that used to work."""
    async with with_inference(api_factory) as api:
        subject = new_user_id()
        response = await call(
            api,
            method,
            path,
            body,
            api.authorize(subject=subject, **ASSERTED_ROLE_CLAIM),
        )

    assert response.status_code == 403


async def test_a_refusal_discloses_nothing_about_what_the_endpoint_would_have_returned(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/authentication`: the refusal discloses nothing about the capability's contents.

    The seeded catalog, policies and plans are all real and all named; if any of them appeared in
    a refusal, an ordinary caller would learn the shape of the estate by being told no.
    """
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=new_user_id())
        bodies = [
            (await call(api, method, path, body, headers)).text for method, path, body in OPERATIONS
        ]

    rendered = " ".join(bodies).lower()
    for leaked in (
        "standard-general",
        "frontier-reasoning",
        "economy-free-primary",
        "balanced",
        "high_reasoning",
        "admin_experimental",
        "nvidia",
        "openrouter",
        "premium",
        "requests_per_day",
        "usage_limits",
        "model_catalog",
        "select",
    ):
        assert leaked not in rendered, f"a refusal disclosed {leaked!r}"


async def test_every_registered_admin_route_is_covered_by_the_matrix(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The matrix is only worth what it covers, so what it covers is checked against the app.

    A route added without a case here fails this test rather than shipping unexercised.
    """
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()

    served = {
        f"{method.upper()} {path[len(PREFIX) :]}"
        for path, operations in schema["paths"].items()
        if "/admin/" in path
        for method in operations
        if method.lower() in {"get", "post", "put", "patch", "delete"}
    }
    # The matrix exercises concrete paths; the app declares templates. Mapped rather than matched
    # loosely, so a genuinely uncovered route cannot pass by resembling a covered one.
    templates = {entry.path for entry in classifications() if entry.administrative}

    def template_for(path: str) -> str:
        if path in templates:
            return path
        parts = path.strip("/").split("/")
        for candidate in templates:
            wanted = candidate.strip("/").split("/")
            if len(wanted) != len(parts):
                continue
            if all(w.startswith("{") or w == p for w, p in zip(wanted, parts, strict=True)):
                return candidate
        return path

    covered = {f"{method} {template_for(path)}" for method, path, _ in OPERATIONS}
    assert served == covered, {
        "uncovered": sorted(served - covered),
        "stale": sorted(covered - served),
    }


# ============================================= 34.9 the capability a signed-in person is told


async def test_me_reports_the_administrative_capability_from_backend_state(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`/me` tells the acting principal whether they hold the role.

    That is what lets the product *offer* the administrative section instead of making an
    administrator know a URL. It is read from `admin_roles` — the same state every administrative
    endpoint checks — so the navigation and the boundary cannot disagree about who is one.
    """
    async with with_inference(api_factory) as api:
        ordinary = new_user_id()
        promoted = await administrator(api)

        as_ordinary = await api.client.get(f"{PREFIX}/me", headers=api.authorize(subject=ordinary))
        as_admin = await api.client.get(f"{PREFIX}/me", headers=api.authorize(subject=promoted))

    assert as_ordinary.status_code == as_admin.status_code == 200
    assert as_ordinary.json()["administrative"] is False
    assert as_admin.json()["administrative"] is True


async def test_the_capability_is_never_taken_from_the_token(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A token asserting the role is still ignored, here as everywhere.

    Worth its own case now that the answer is *reported* to a client: a field a client can read is
    a field somebody will try to make the backend say. It says what the row says.
    """
    async with with_inference(api_factory) as api:
        pretender = new_user_id()
        response = await api.client.get(
            f"{PREFIX}/me",
            headers=api.authorize(subject=pretender, **ASSERTED_ROLE_CLAIM),
        )

    assert response.status_code == 200
    assert response.json()["administrative"] is False


async def test_the_capability_answers_only_for_the_asking_principal(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """One administrator existing does not make anybody else one, and `/me` takes no argument that
    could ask about somebody else — the subject comes from the validated token."""
    async with with_inference(api_factory) as api:
        await administrator(api)
        bystander = new_user_id()

        response = await api.client.get(f"{PREFIX}/me", headers=api.authorize(subject=bystander))

    assert response.json()["administrative"] is False


# =========================================================================== 31.6 classification


async def test_every_admin_route_is_classified_protected_and_administrative(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()

    declared = {entry.path: entry for entry in classifications()}
    for path, operations in schema["paths"].items():
        if "/admin/" not in path:
            continue
        relative = path[len(PREFIX) :]
        entry = declared.get(relative)
        assert entry is not None, f"{relative} is served and unclassified"
        assert entry.administrative, f"{relative} is served but not classified administrative"

        for method, operation in operations.items():
            if method.lower() not in {"get", "post", "put", "patch", "delete"}:
                continue
            assert operation["security"], f"{method} {path} carries no security requirement"
            assert "Administrative." in operation["description"]
            assert "401" in operation["responses"]


async def test_the_classification_declares_no_admin_path_the_app_does_not_serve(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()

    served = {path[len(PREFIX) :] for path in schema["paths"]}
    declared = {entry.path for entry in classifications() if entry.administrative}
    assert declared <= served, f"declared but not served: {sorted(declared - served)}"


# =========================================================================== 31.7 reach


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/me"),
        ("GET", "/me/preferences"),
        ("GET", "/me/locations"),
        ("GET", "/threads"),
        ("GET", "/me/usage"),
    ],
)
async def test_an_administrator_sees_their_own_records_and_not_another_persons(
    api_factory: ApiFactory, seeded_reference_data: None, method: str, path: str
) -> None:
    """`specs/authentication`: holding the role grants no access to another user's own data.

    The administrator's session is an ordinary owner-scoped session — the role reaches the model
    layer, not people's rows — so what comes back is *their* empty account, not somebody else's
    full one.
    """
    async with with_inference(api_factory) as api:
        other = new_user_id()
        other_headers = api.authorize(subject=other)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=other_headers
        )
        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=other_headers
        )

        admin = await administrator(api)
        response = await api.client.request(
            method, f"{PREFIX}{path}", headers=api.authorize(subject=admin)
        )

    assert response.status_code == 200
    assert other not in response.text, "an administrator read another subject's identifier"
    assert "imperial" not in response.text, "an administrator read another person's preference"
    assert "Berlin" not in response.text, "an administrator read another person's saved location"


async def test_an_administrator_is_refused_another_persons_evidence_and_thread(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Refused exactly as any other caller is — a 404, because "exists but is not yours" is itself
    a disclosure."""
    async with with_inference(api_factory) as api:
        api.script(completions=["Berlin looks mild."] * 4, json_responses=[forecast_plan()] * 4)
        other = new_user_id()
        created = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?", "create_thread": True},
            headers=api.authorize(subject=other),
        )
        assert created.status_code == 200
        thread_id = created.json()["thread_id"]
        evidence_id = created.json()["evidence_id"]

        admin_headers = api.authorize(subject=await administrator(api))
        thread = await api.client.get(f"{PREFIX}/threads/{thread_id}", headers=admin_headers)
        evidence = await api.client.get(f"{PREFIX}/evidence/{evidence_id}", headers=admin_headers)

    assert thread.status_code == 404
    assert evidence.status_code == 404


# The names an administrative module must not contain. Personal data — the tables that hold what a
# person said, chose or saved, and the stores that read them. `user_plans` is deliberately absent:
# plan assignment is entitlement state the request role is granted no write on, and `0006` names
# the administrative path as the one that writes it.
PERSONAL_NAMES: tuple[str, ...] = (
    "threads",
    "preferences",
    "saved_locations",
    "agent_runs",
    "llm_usage_events",
    "checkpoint",
    "weathra.memory",
    "ThreadStore",
    "PreferenceStore",
    "SavedLocationStore",
)


def personal_reach(sources: dict[str, str]) -> list[str]:
    """Where *sources* name a table or store holding a person's own data.

    Separated from the scan below so the same logic can be pointed at deliberately offending source
    and shown to catch it. A checker nobody has watched fail is a green light, not a check.

    A name check rather than an import graph, and the limitation is worth stating: it catches a
    module that reaches for personal data directly, which is the mistake somebody actually makes,
    and would not catch one that reached three modules deep. The behavioural tests above cover the
    property from the other end — an administrator is refused another person's records through the
    API, whatever the source says.
    """
    found: list[str] = []
    for relative, source in sources.items():
        found.extend(f"{relative}:{name}" for name in PERSONAL_NAMES if name in source)
    return found


def test_no_administrative_module_reaches_a_personal_table() -> None:
    """31.7, asserted over the source.

    The privileged connection is legitimate here — the request role holds `SELECT` and nothing else
    on every operational table, which is *why* administration is privileged — so the rule cannot be
    "these modules avoid the privileged connection". It is that they avoid the tables and the
    stores that hold a person's own data, which the privileged connection would reach past every
    policy.

    This is the purpose-built check group 26's scanner cannot make. That one looks for a module
    naming a user-owned table *and* opening the privileged connection; these routers open it and
    name no table at all, because they call the group 27 stores — so they would pass it while
    proving nothing. This asserts the property that actually matters here.
    """
    admin_package = PACKAGE_ROOT / "api" / "routers" / "admin"
    sources = {
        path.name: path.read_text(encoding="utf-8") for path in sorted(admin_package.rglob("*.py"))
    }
    assert sources, "the administrative package was not found, so this checked nothing"
    assert personal_reach(sources) == []


def test_the_personal_reach_check_catches_a_module_that_reached_for_one() -> None:
    """The negative control, through the checker rather than around it."""
    caught = personal_reach(
        {
            "plans.py": (
                "from weathra.memory.threads import ThreadStore\n"
                "async def peek(session, user_id):\n"
                "    return await ThreadStore(session, user_id).list()\n"
            )
        }
    )
    assert caught, "a router reading another person's threads went undetected"
    assert all(entry.startswith("plans.py:") for entry in caught)


def test_the_personal_reach_check_does_not_flag_plan_assignment() -> None:
    """The other direction: `user_plans` is the one user-owned table this path may write, and a
    checker that flagged it would be turned off within a day."""
    assert (
        personal_reach({"plans.py": "await PlanStore(session).assign(subject_id, plan_code)\n"})
        == []
    )


async def test_the_usage_summary_returns_measures_and_never_a_row(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """31.5: aggregates, internal separated, no conversation content, and no subject.

    The safety argument for an administrator reading across users is that a usage event holds no
    content and this route returns no rows. Both halves are asserted, because either alone would
    be a different endpoint.
    """
    async with with_inference(api_factory) as api:
        api.script(completions=["Berlin looks mild."] * 4, json_responses=[forecast_plan()] * 4)
        person = new_user_id()
        assert (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "What is the forecast for Berlin?"},
                headers=api.authorize(subject=person),
            )
        ).status_code == 200
        await api.app.state.usage_recorder.drain()

        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=plan", headers=api.authorize(subject=await administrator(api))
        )

    assert response.status_code == 200
    body = response.json()
    assert body["grouped_by"] == "plan"
    assert body["window"]["start"] < body["window"]["end"]
    assert body["groups"], "the run recorded nothing to aggregate"
    for group in body["groups"]:
        assert set(group) >= {"calls", "failures", "total_tokens", "is_internal"}
        assert "event_id" not in group and "user_id" not in group

    rendered = response.text
    assert person not in rendered, "the aggregate named a subject"
    assert "Berlin" not in rendered, "the aggregate carried conversation content"


async def test_an_unsupported_grouping_is_refused_rather_than_interpolated(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=user_id; DROP TABLE llm_usage_events",
            headers=api.authorize(subject=await administrator(api)),
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_internal_usage_is_reported_apart_from_product_usage(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        api.script(completions=["Berlin looks mild."] * 4, json_responses=[forecast_plan()] * 4)
        admin = await administrator(api)
        person = new_user_id()
        for subject in (person, admin):
            assert (
                await api.client.post(
                    f"{PREFIX}/agent/ask",
                    json={"question": "What is the forecast for Berlin?"},
                    headers=api.authorize(subject=subject),
                )
            ).status_code == 200
        await api.app.state.usage_recorder.drain()

        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=plan", headers=api.authorize(subject=admin)
        )

    groups = response.json()["groups"]
    assert any(group["is_internal"] for group in groups), (
        "the administrator's call was not internal"
    )
    assert any(not group["is_internal"] for group in groups), "the person's call was not product"


# =========================================================================== concurrency


async def test_two_administrators_editing_one_policy_leave_it_in_one_of_the_two_states(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-policy` states no version semantics, so the last write wins — but it must win
    *wholly*. The failure worth ruling out is not a lost update; it is a candidate list
    interleaved from two writers, which would resolve to a model neither of them chose.
    """
    async with with_inference(api_factory) as api:
        first, second = await administrator(api), await administrator(api)
        one = ["standard-general"]
        two = ["frontier-reasoning", "standard-general"]

        responses = await asyncio.gather(
            api.client.put(
                f"{PREFIX}/admin/policies/balanced/candidates",
                json={"candidate_catalog_keys": one},
                headers=api.authorize(subject=first),
            ),
            api.client.put(
                f"{PREFIX}/admin/policies/balanced/candidates",
                json={"candidate_catalog_keys": two},
                headers=api.authorize(subject=second),
            ),
        )
        assert [response.status_code for response in responses] == [200, 200]

        listing = await api.client.get(
            f"{PREFIX}/admin/policies", headers=api.authorize(subject=first)
        )
        settled = next(
            policy for policy in listing.json()["policies"] if policy["policy_id"] == "balanced"
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            recorded = await session.scalar(
                text("SELECT count(*) FROM admin_audit WHERE action = 'policy_edit'")
            )

    assert settled["candidate_catalog_keys"] in (one, two), (
        "the candidate list interleaved two writers rather than settling on one of them"
    )
    assert recorded == 2, "both writes are in the trail, whichever of them the row ended up as"


# ======================================================= 34.5 reading a policy's own audit trail


async def test_an_administrator_reads_the_trail_of_the_policy_they_changed(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/model-lab` requires a promotion to be recorded with the acting principal, the change,
    and the comparison runs cited as its basis. A record nothing can read back is a record only in
    name, and until 34.5 the only reader was a database client — so this is the endpoint that makes
    the requirement checkable by the person who made the change.
    """
    run_id = "9b5849dd-b798-4dc8-b04f-a8e6c0874e1a"
    async with with_inference(api_factory) as api:
        subject = await administrator(api)

        written = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={
                "candidate_catalog_keys": ["standard-general", "economy-free-primary"],
                "cited_comparison_run_ids": [run_id],
            },
            headers=api.authorize(subject=subject),
        )
        assert written.status_code == 200

        read = await api.client.get(
            f"{PREFIX}/admin/policies/balanced/audit", headers=api.authorize(subject=subject)
        )

    assert read.status_code == 200
    body = read.json()
    assert body["policy_id"] == "balanced"
    assert body["count"] == len(body["entries"]) == 1

    entry = body["entries"][0]
    assert entry["action"] == "policy_edit"
    assert entry["subject_kind"] == "model_policy"
    assert entry["subject_id"] == "balanced"
    assert entry["acting_principal"] == subject
    assert entry["cited_comparison_run_ids"] == [run_id]
    # The before and after are the whole point: "who changed the candidate list" is answerable
    # without them and "what did it used to be" is not.
    assert entry["before"]["candidate_catalog_keys"] == ["standard-general", "economy-free-primary"]
    assert entry["after"]["candidate_catalog_keys"] == ["standard-general", "economy-free-primary"]


async def test_the_trail_carries_no_other_records_change(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Narrowed to the policy in the path. A reader asking about one policy is not handed a plan
    assignment, a catalog edit, or somebody's role grant — and the role grant matters most: it names
    an auth subject, and the answer to "what happened to this policy" is not the place to disclose
    who was made an administrator.
    """
    async with with_inference(api_factory) as api:
        subject = await administrator(api)
        # `on_plan` creates the profile row the plan's foreign key needs. A bare subject id has none,
        # and assigning a plan to it is a foreign-key violation rather than a test of anything.
        other = await on_plan(api, PlanCode.FREE)

        assigned = await api.client.put(
            f"{PREFIX}/admin/principals/{other}/plan",
            json={"plan_code": "pro"},
            headers=api.authorize(subject=subject),
        )
        assert assigned.status_code == 200
        edited = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={"candidate_catalog_keys": ["standard-general"]},
            headers=api.authorize(subject=subject),
        )
        assert edited.status_code == 200

        read = await api.client.get(
            f"{PREFIX}/admin/policies/balanced/audit", headers=api.authorize(subject=subject)
        )

    entries = read.json()["entries"]
    assert [entry["action"] for entry in entries] == ["policy_edit"]
    assert other not in read.text, "the trail of one policy disclosed an unrelated principal"


async def test_a_policy_with_no_recorded_change_reads_as_empty_rather_than_missing(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """An untouched policy has an empty trail; an unknown one is a 404.

    Different answers because they are different facts: a reader told "no history" for a policy that
    does not exist would conclude a change had gone unrecorded.
    """
    async with with_inference(api_factory) as api:
        subject = await administrator(api)

        untouched = await api.client.get(
            f"{PREFIX}/admin/policies/free_default/audit", headers=api.authorize(subject=subject)
        )
        unknown = await api.client.get(
            f"{PREFIX}/admin/policies/no-such-policy/audit", headers=api.authorize(subject=subject)
        )

    assert untouched.status_code == 200
    assert untouched.json() == {"policy_id": "free_default", "count": 0, "entries": []}
    assert unknown.status_code == 404
    assert unknown.json()["error"]["details"]["policy_id"] == "no-such-policy"


# =========================================================================== 31.2 the audit


AUDITED: tuple[tuple[str, str, str, dict[str, Any] | None, str], ...] = (
    (
        "catalog",
        "PATCH",
        "/admin/models/standard-general",
        {"display_name": "Renamed by a test"},
        "catalog_edit",
    ),
    ("catalog", "POST", "/admin/models/frontier-reasoning/disable", None, "catalog_disable"),
    ("catalog enable", "POST", "/admin/models/probe-disabled/enable", None, "catalog_enable"),
    (
        "policy",
        "PUT",
        "/admin/policies/balanced/candidates",
        {"candidate_catalog_keys": ["standard-general"]},
        "policy_edit",
    ),
    (
        "plan mapping",
        "PUT",
        "/admin/plans/free/policies",
        {"policy_by_call_role": {"synthesis": "free_default"}},
        "plan_mapping_edit",
    ),
    (
        "allowance",
        "PUT",
        "/admin/plans/free/allowances",
        {"dimension": "requests_per_day", "allowance": 30},
        "allowance_set",
    ),
    (
        "internal allowance",
        "PUT",
        "/admin/allowances/internal",
        {"dimension": "requests_per_day", "allowance": 3000},
        "allowance_set",
    ),
)


@pytest.mark.parametrize(
    ("label", "method", "path", "body", "action"), AUDITED, ids=[case[0] for case in AUDITED]
)
async def test_every_privileged_write_is_recorded_with_the_administrator_who_made_it(
    api_factory: ApiFactory,
    seeded_reference_data: None,
    label: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    action: str,
) -> None:
    """31.2, through the API rather than through the store.

    The stores were shown to audit in group 27. What is new here is that every administrative
    *route* reaches them, so the audit records the HTTP caller rather than whoever the route
    happened to pass along — which is the thing a route can get wrong.
    """
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        if "probe-disabled" in path:
            # Enabling an already-enabled entry is a no-op and records nothing, which is right —
            # an audit row for a change that did not happen is noise in the one log that must not
            # have any. So there has to be something to enable.
            async with privileged_session(api.app.state.engines.privileged_sessionmaker) as prep:
                await prep.execute(
                    text(
                        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, "
                        "  display_name, capability_roles, capability_tier, "
                        "  supports_structured_output, context_window, input_price_per_million, "
                        "  output_price_per_million, price_currency, pricing_recorded_on, status, "
                        "  is_free_tier) "
                        "VALUES ('probe-disabled', 'openrouter', 'probe/disabled', 'Probe', "
                        "  ARRAY['synthesis']::text[], 'standard', true, 8000, 0.1, 0.2, 'USD', "
                        "  DATE '2026-09-09', 'disabled', false)"
                    )
                )

        response = await call(api, method, path, body, api.authorize(subject=admin))
        assert response.status_code in {200, 201}, response.text[:300]

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            rows = await session.execute(
                text(
                    "SELECT acting_principal, action, subject_kind, subject_id, before, after "
                    "  FROM admin_audit ORDER BY created_at DESC LIMIT 1"
                )
            )
            recorded = rows.first()

    assert recorded is not None, f"the {label} write recorded nothing"
    assert str(recorded[0]) == admin, "the audit named someone other than the acting caller"
    assert recorded[1] == action
    assert recorded[3], "the audit row names no target"
    assert recorded[4] is not None or recorded[5] is not None


async def test_plan_assignment_is_recorded_and_takes_effect_for_the_next_request(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """31.4's headline criterion, asserted end to end rather than at the row.

    The assignment is only real if the *next* request sees it, so the proof is the person's own
    usage endpoint reporting the new tier's allowance — not the row this route wrote.
    """
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        person = new_user_id()
        before = await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=person))
        assert before.json()["plan_code"] == "free"

        assigned = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan",
            json={"plan_code": "pro"},
            headers=api.authorize(subject=admin),
        )
        assert assigned.status_code == 200

        after = await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=person))

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            entry = (
                await session.execute(
                    text(
                        "SELECT acting_principal, subject_id, before, after FROM admin_audit "
                        " WHERE action = 'plan_assign'"
                    )
                )
            ).first()

    body = after.json()
    assert body["plan_code"] == "pro"
    daily = next(item for item in body["dimensions"] if item["dimension"] == "requests_per_day")
    assert daily["allowance"] == 250, "the new tier's allowance, read on the next request"

    assert entry is not None
    assert str(entry[0]) == admin
    assert entry[1] == person


async def test_an_allowance_change_takes_effect_without_a_code_change(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`: subsequent requests are accounted against the new allowance.

    Not cached anywhere, deliberately: the gate reads `usage_limits` fresh on every admission, so
    "takes effect" means the next request rather than the next staleness window.
    """
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        person = new_user_id()

        raised = await api.client.put(
            f"{PREFIX}/admin/plans/free/allowances",
            json={"dimension": "requests_per_day", "allowance": 7},
            headers=api.authorize(subject=admin),
        )
        assert raised.status_code == 200

        usage = await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=person))

    daily = next(
        item for item in usage.json()["dimensions"] if item["dimension"] == "requests_per_day"
    )
    assert daily["allowance"] == 7
    assert daily["remaining"] == 7


@pytest.mark.parametrize(
    ("body", "why"),
    [
        ({"dimension": "requests_per_day", "allowance": -1}, "a negative allowance"),
        ({"dimension": "requests_per_fortnight", "allowance": 10}, "an unknown dimension"),
        ({"dimension": "requests_per_day"}, "no allowance at all"),
        ({"allowance": 10}, "no dimension at all"),
    ],
)
async def test_an_invalid_allowance_is_refused_and_changes_nothing(
    api_factory: ApiFactory, seeded_reference_data: None, body: dict[str, Any], why: str
) -> None:
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        response = await api.client.put(
            f"{PREFIX}/admin/plans/free/allowances",
            json=body,
            headers=api.authorize(subject=admin),
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            current = await session.scalar(
                text(
                    "SELECT allowance FROM usage_limits "
                    " WHERE plan_code = 'free' AND dimension = 'requests_per_day'"
                )
            )
            audited = await session.scalar(
                text("SELECT count(*) FROM admin_audit WHERE action = 'allowance_set'")
            )

    assert response.status_code == 400, f"{why} was accepted"
    assert current == 25, "a refused write changed the seeded allowance"
    assert audited == 0, "a refused write left an audit row claiming it happened"


async def test_a_plan_named_plus_is_refused_before_any_handler_runs(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The retired tier reaches nothing, in the path and in the body alike."""
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        headers = api.authorize(subject=admin)
        in_path = await api.client.put(
            f"{PREFIX}/admin/plans/plus/allowances",
            json={"dimension": "requests_per_day", "allowance": 10},
            headers=headers,
        )
        in_body = await api.client.put(
            f"{PREFIX}/admin/principals/{new_user_id()}/plan",
            json={"plan_code": "plus"},
            headers=headers,
        )

    assert in_path.status_code == 400
    assert in_body.status_code == 400
    assert "plus" not in in_path.text.lower().replace("plus_", "")


# =========================================================================== 31.3 reflection


async def test_disabling_a_model_is_reflected_in_the_next_resolution(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """31.3: each operation applied *and reflected in subsequent resolutions*.

    The snapshot is a per-process TTL cache (design.md decision 23), so the route invalidates it —
    not an invalidation protocol, just the process that made the change refusing to serve its own
    stale view back to the administrator who made it.
    """
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        snapshots = api.app.state.inference.snapshots

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            before = await snapshots.current(session)
        assert before.enabled_entry("frontier-reasoning") is not None

        disabled = await api.client.post(
            f"{PREFIX}/admin/models/frontier-reasoning/disable",
            headers=api.authorize(subject=admin),
        )
        assert disabled.status_code == 200
        assert snapshots.peek() is None, "the route left its own process serving a stale catalog"

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            after = await snapshots.current(session)

    assert after.enabled_entry("frontier-reasoning") is None
    assert after.entry("frontier-reasoning") is not None, "a withdrawn model stays auditable"


async def test_the_last_model_serving_a_role_cannot_be_withdrawn(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A disable that left routing with nothing to resolve would take the agent surface down from
    an administrative screen."""
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        headers = api.authorize(subject=admin)

        listing = await api.client.get(f"{PREFIX}/admin/models", headers=headers)
        serving = [
            entry["catalog_key"]
            for entry in listing.json()["entries"]
            if "routing" in entry["capability_roles"] and entry["status"] == "enabled"
        ]
        assert serving, "the seeded catalog serves no routing model, so this proves nothing"

        refusals = []
        for key in serving:
            response = await api.client.post(
                f"{PREFIX}/admin/models/{key}/disable", headers=headers
            )
            refusals.append(response.status_code)

    assert refusals[-1] == 400, "the last model serving routing was withdrawn"
    assert refusals.count(400) == 1, "only the last one is refused"


async def test_a_policy_naming_a_model_that_does_not_exist_is_refused(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        response = await api.client.put(
            f"{PREFIX}/admin/policies/balanced/candidates",
            json={"candidate_catalog_keys": ["a-model-nobody-added"]},
            headers=api.authorize(subject=admin),
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_a_duplicate_catalog_key_is_refused_as_a_conflict(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        response = await api.client.post(
            f"{PREFIX}/admin/models",
            json={
                "catalog_key": "standard-general",
                "gateway_provider": "openrouter",
                "gateway_model": "somebody/else",
                "display_name": "Duplicate",
                "capability_roles": ["synthesis"],
                "capability_tier": "standard",
                "supports_structured_output": True,
                "context_window": 8000,
                "input_price_per_million": "0.1",
                "output_price_per_million": "0.2",
                "pricing_recorded_on": "2026-09-09",
                "is_free_tier": False,
            },
            headers=api.authorize(subject=admin),
        )
    assert response.status_code == 400
    assert "already exists" in response.json()["error"]["message"]


# =========================================================================== atomicity


async def test_a_write_that_fails_after_its_audit_row_leaves_neither_behind(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The mutation and its record are one transaction, so a failure takes both.

    Injected at the store rather than simulated: the route is asked to do a real edit, and the
    commit is made to fail afterwards. A change that survived with no audit row — or a row for a
    change that rolled back — would each be worse than no audit, because both read as complete.
    """
    from weathra.entitlements import catalog as catalog_module

    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        original = catalog_module.CatalogStore.edit

        async def explode(self: Any, *arguments: Any, **keywords: Any) -> Any:
            await original(self, *arguments, **keywords)
            raise RuntimeError("the connection dropped after the write")

        catalog_module.CatalogStore.edit = explode  # type: ignore[method-assign]
        try:
            # The failure propagates rather than becoming a 500 here: Starlette's server-error
            # middleware re-raises after handling, and `ASGITransport` runs the app in-process
            # with nothing above it to swallow that. The status a real caller sees is covered by
            # `test_api.py`'s handler tests; what this one is about is the two rows.
            with pytest.raises(RuntimeError, match="connection dropped"):
                await api.client.patch(
                    f"{PREFIX}/admin/models/standard-general",
                    json={"display_name": "Renamed then lost"},
                    headers=api.authorize(subject=admin),
                )
        finally:
            catalog_module.CatalogStore.edit = original  # type: ignore[method-assign]

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            name = await session.scalar(
                text("SELECT display_name FROM model_catalog WHERE catalog_key='standard-general'")
            )
            audited = await session.scalar(
                text("SELECT count(*) FROM admin_audit WHERE action = 'catalog_edit'")
            )

    assert name != "Renamed then lost", "the change survived a transaction that rolled back"
    assert audited == 0, "an audit row survived the change it described"


async def test_an_administrator_cannot_revoke_their_own_role(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """An estate whose last administrator demotes themselves has no way back in short of the
    bootstrap script and a database credential."""
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        response = await api.client.delete(
            f"{PREFIX}/admin/principals/{admin}/role", headers=api.authorize(subject=admin)
        )

        listing = await api.client.get(
            f"{PREFIX}/admin/principals/administrators", headers=api.authorize(subject=admin)
        )

    assert response.status_code == 400
    assert listing.json()["count"] == 1


async def test_granting_the_role_takes_effect_and_revoking_it_takes_it_away(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The promotion round trip, measured by what the promoted principal can then do."""
    async with with_inference(api_factory) as api:
        admin = await administrator(api)
        newcomer = new_user_id()
        before = await api.client.get(
            f"{PREFIX}/admin/plans", headers=api.authorize(subject=newcomer)
        )

        granted = await api.client.put(
            f"{PREFIX}/admin/principals/{newcomer}/role", headers=api.authorize(subject=admin)
        )
        during = await api.client.get(
            f"{PREFIX}/admin/plans", headers=api.authorize(subject=newcomer)
        )

        revoked = await api.client.delete(
            f"{PREFIX}/admin/principals/{newcomer}/role", headers=api.authorize(subject=admin)
        )
        after = await api.client.get(
            f"{PREFIX}/admin/plans", headers=api.authorize(subject=newcomer)
        )

    assert before.status_code == 403
    assert granted.status_code == 200
    assert granted.json()["granted_by"] == admin
    assert during.status_code == 200
    assert revoked.status_code == 204
    assert after.status_code == 403


# =========================================================================== attribution


async def test_an_administrators_request_is_attributed_internally_everywhere_at_once(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The defect this group found, and the invariant that replaces it.

    One request by an administrator, and three records of it that must agree: the quota *subject*
    it was admitted as, the *counter* it spent, and the usage *event* it wrote. Before the fix the
    counter went to the internal subject while the event carried the administrator's own user id
    and their plan — the same call recorded two ways, which is exactly the reconciliation
    `specs/usage-limits` requires to hold.

    They agree now because there is one determination: the role read from `admin_roles` once per
    request at the identity boundary, passed to the gate and to the broker. There is no second
    classifier to drift.
    """
    async with with_inference(api_factory) as api:
        api.script(completions=["Berlin looks mild."] * 4, json_responses=[forecast_plan()] * 4)
        admin = await administrator(api)

        answered = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=admin),
        )
        assert answered.status_code == 200
        await api.app.state.usage_recorder.drain()

        reported = await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=admin))

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            counters = {
                row[0]: row[1]
                for row in await session.execute(
                    text(
                        "SELECT subject, consumed FROM usage_counters "
                        " WHERE dimension = 'requests_per_day'"
                    )
                )
            }
            events = (
                await session.execute(
                    text("SELECT user_id, subject_kind, is_internal, plan FROM llm_usage_events")
                )
            ).all()

    # 1. the subject it was admitted as
    assert reported.json()["internal"] is True

    # 2. the counter it spent
    assert counters.get("internal") == 1, "the internal allowance was not what paid for the call"
    assert admin not in counters, "an administrator's call was charged to their own plan"

    # 3. the event it wrote
    assert events, "the run recorded no usage event"
    for user_id, subject_kind, is_internal, plan in events:
        assert subject_kind == "internal", "the event was recorded as product usage"
        assert is_internal is True, "the generated classification disagrees with the subject kind"
        assert plan is None, "an internal event carried a product plan"
        assert str(user_id) == admin, "the event lost the administrator it belonged to"


async def test_an_ordinary_persons_request_stays_attributed_to_their_plan_everywhere(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The other direction of the same invariant, so the fix cannot have made everyone internal."""
    async with with_inference(api_factory) as api:
        api.script(completions=["Berlin looks mild."] * 4, json_responses=[forecast_plan()] * 4)
        person = new_user_id()

        answered = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=person),
        )
        assert answered.status_code == 200
        await api.app.state.usage_recorder.drain()

        reported = await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=person))

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            counters = {
                row[0]: row[1]
                for row in await session.execute(
                    text(
                        "SELECT subject, consumed FROM usage_counters "
                        " WHERE dimension = 'requests_per_day'"
                    )
                )
            }
            events = (
                await session.execute(
                    text("SELECT user_id, subject_kind, is_internal, plan FROM llm_usage_events")
                )
            ).all()

    assert reported.json()["internal"] is False
    assert counters.get(person) == 1
    assert "internal" not in counters
    assert events
    for user_id, subject_kind, is_internal, plan in events:
        assert str(user_id) == person
        assert subject_kind == "user"
        assert is_internal is False
        assert plan == "free", "a product event must carry the plan it was served under"
