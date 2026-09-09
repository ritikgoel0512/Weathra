"""Group 18 — the identity boundary, proven as a whole rather than a slice at a time.

Every group above tests its own part. This one takes the boundary itself as the subject: every
protected route, every token failure mode, and every cross-user attempt, parametrized so that a
route added without protection or a rejection case that stops being distinguishable fails here.

Three properties this suite exists to hold:

* **A protected route acts as the token's subject and nothing else.** Not a header, not a body
  field, not a query parameter (design.md decision 4).
* **A rejection reveals nothing.** Same response for another user's record as for one that does not
  exist, no token material in any body, and a distinguishable code so a *client* can tell an
  expired session from a bad one without an attacker learning anything.
* **Row Level Security holds on its own.** Asserted with the ownership predicate deliberately
  omitted, which is the only way to prove the second gate rather than the first.
"""

from __future__ import annotations

import uuid
from contextlib import AbstractAsyncContextManager
from typing import Any

import pytest
from sqlalchemy import text

from tests.api_support import ApiFactory, ApiHarness, harness
from tests.auth_support import USER_A, USER_B, TokenFactory
from tests.db_support import insert_profile, new_user_id, session_as
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.api.classification import PROTECTED_PATHS
from weathra.api.streaming import StreamEventType
from weathra.auth.deps import IDENTITY_ASSERTING_HEADERS
from weathra.db.engine import Engines
from weathra.db.models import ownership_column, user_owned_tables
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

PREFIX = "/api/v1"


@pytest.fixture
def api_factory(
    token_factory: TokenFactory, checkpointer_schema: str, clean_database: None
) -> ApiFactory:
    """On ``checkpointer_schema`` — the migrated URL plus LangGraph's tables — because the
    ``DELETE`` routes covered below reach the checkpointer, as a deployed app's would."""

    def build(**overrides: Any) -> AbstractAsyncContextManager[ApiHarness]:
        return harness(factory=token_factory, database_url=checkpointer_schema, **overrides)

    return build


def with_inference(api_factory: ApiFactory) -> AbstractAsyncContextManager[ApiHarness]:
    return api_factory(openrouter_api_key="test-credential-never-sent")


def _plan(*steps: PlanStep, **kwargs: object) -> dict:
    return RoutingPlan(steps=steps, reason="a scripted plan", **kwargs).model_dump(mode="json")


BERLIN_PLAN = _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3))


# Every protected route, with a request that would succeed for its owner. The list is derived from
# the classification table below, so a protected route added without an entry here fails the
# coverage test rather than quietly going untested.
PROTECTED_REQUESTS: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("GET", "/weather/changes", {"params": {"location": "Berlin"}}),
    ("GET", "/me", {}),
    ("GET", "/me/preferences", {}),
    ("PUT", "/me/preferences", {"json": {"unit_system": "imperial"}}),
    ("DELETE", "/me/preferences", {}),
    ("GET", "/me/usage", {}),
    ("GET", "/me/locations", {}),
    ("POST", "/me/locations", {"json": {"location": "Berlin"}}),
    ("DELETE", "/me/locations/{saved_id}", {}),
    ("DELETE", "/me/data", {}),
    ("GET", "/threads", {}),
    ("GET", "/threads/{thread_id}", {}),
    ("DELETE", "/threads/{thread_id}", {}),
    ("GET", "/evidence/{evidence_id}", {}),
    ("POST", "/agent/ask", {"json": {"question": "Berlin?"}}),
    ("POST", "/agent/stream", {"json": {"question": "Berlin?"}}),
)


def _route_id(entry: tuple[str, str, dict[str, Any]]) -> str:
    return f"{entry[0]}-{entry[1]}"


# =========================================================================== coverage


def test_the_parameterized_suite_covers_every_protected_route() -> None:
    """So a protected route added to the app cannot slip past this whole suite untested."""
    covered = {path for _, path, _ in PROTECTED_REQUESTS}
    declared = set(PROTECTED_PATHS)

    # The suite's templated paths correspond to the classification table's parameterized ones.
    normalized = {
        path.replace("{saved_id}", "{saved_id}")
        .replace("{thread_id}", "{thread_id}")
        .replace("{evidence_id}", "{evidence_id}")
        for path in covered
    }
    assert declared - normalized == set(), (
        f"untested protected routes: {sorted(declared - normalized)}"
    )


# =========================================================================== 18.2 valid requests


async def _own_ids(api: ApiHarness, subject: str) -> dict[str, str]:
    """Create one of each owned record for a subject, and return their identifiers."""
    headers = api.authorize(subject=subject)

    await api.client.get(f"{PREFIX}/me", headers=headers)
    saved = await api.client.post(
        f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
    )
    api.script(json_responses=[BERLIN_PLAN], completions=["Berlin looks mild."])
    asked = await api.client.post(
        f"{PREFIX}/agent/ask",
        json={"question": "Berlin?", "create_thread": True},
        headers=headers,
    )
    assert asked.status_code == 200, asked.text[:300]

    return {
        "saved_id": saved.json()["id"],
        "thread_id": asked.json()["thread_id"],
        "evidence_id": asked.json()["evidence_id"],
    }


@pytest.mark.parametrize("entry", PROTECTED_REQUESTS, ids=_route_id)
async def test_a_valid_token_succeeds_and_acts_as_its_subject(
    api_factory: ApiFactory, entry: tuple[str, str, dict[str, Any]]
) -> None:
    """Every protected route answers for its owner, and answers *as* the token's subject."""
    method, template, options = entry

    async with with_inference(api_factory) as api:
        identifiers = await _own_ids(api, USER_A)
        path = template.format(**identifiers)
        headers = api.authorize(subject=USER_A)

        if template == "/agent/ask" or template == "/agent/stream":
            api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])

        response = await api.client.request(method, f"{PREFIX}{path}", headers=headers, **options)

        assert response.status_code in {200, 201, 204}, (
            f"{method} {path} answered {response.status_code}: {response.text[:200]}"
        )

        # Every record the request touched belongs to the token's subject and nobody else.
        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            for table in user_owned_tables():
                # Each table names the column its policy compares against: `usage_counters` is
                # keyed by `subject`, which also carries the reserved internal subject.
                owner = ownership_column(table)
                rows = await session.execute(text(f"SELECT DISTINCT {owner} FROM {table}"))
                owners = {str(row[0]) for row in rows if row[0] is not None}
                assert owners <= {USER_A}, f"{table} holds a row for {owners - {USER_A}}"


@pytest.mark.parametrize("entry", PROTECTED_REQUESTS, ids=_route_id)
async def test_an_identity_asserting_header_never_overrides_the_token(
    api_factory: ApiFactory, entry: tuple[str, str, dict[str, Any]]
) -> None:
    """Design.md decision 4: one identity path, so there is one authorization path."""
    method, template, options = entry

    async with with_inference(api_factory) as api:
        identifiers = await _own_ids(api, USER_A)
        path = template.format(**identifiers)

        headers = {**api.authorize(subject=USER_A)}
        for header in IDENTITY_ASSERTING_HEADERS:
            headers[header] = USER_B

        if template in {"/agent/ask", "/agent/stream"}:
            api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])

        response = await api.client.request(method, f"{PREFIX}{path}", headers=headers, **options)
        assert response.status_code in {200, 201, 204}, response.text[:200]

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            for table in user_owned_tables():
                owner = ownership_column(table)
                rows = await session.execute(text(f"SELECT DISTINCT {owner} FROM {table}"))
                owners = {str(row[0]) for row in rows}
                assert USER_B not in owners, f"{table} was written under the header's identity"


# =========================================================================== 18.3 missing token


@pytest.mark.parametrize("entry", PROTECTED_REQUESTS, ids=_route_id)
async def test_a_missing_token_is_refused_and_changes_nothing(
    api_factory: ApiFactory, entry: tuple[str, str, dict[str, Any]]
) -> None:
    """401, and no read or write: the request stops at the dependency, before any handler runs."""
    method, template, options = entry

    async with with_inference(api_factory) as api:
        identifiers = await _own_ids(api, USER_A)
        path = template.format(**identifiers)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            before = await _snapshot(session)

        api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])
        response = await api.client.request(method, f"{PREFIX}{path}", **options)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_missing"

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            after = await _snapshot(session)

        assert after == before, f"{method} {path} mutated the database without a token"
        assert api.llm is not None
        assert api.llm.call_count == 0, "and started no run"


async def _snapshot(session: Any) -> dict[str, int]:
    """Row counts for every user-owned table, so a mutation is detectable."""
    counts: dict[str, int] = {}
    for table in user_owned_tables():
        counts[table] = int(await session.scalar(text(f"SELECT count(*) FROM {table}")) or 0)
    return counts


# =========================================================================== 18.4 bad tokens


BAD_TOKENS: tuple[tuple[str, str], ...] = (
    ("expired", "token_expired"),
    ("wrong_issuer", "token_issuer_invalid"),
    ("wrong_audience", "token_audience_invalid"),
    ("bad_signature", "token_signature_invalid"),
    ("unknown_key_id", "token_unknown_key"),
    ("no_subject", "token_malformed"),
    ("no_expiry", "token_malformed"),
    ("unverified_email", "email_not_verified"),
)


@pytest.mark.parametrize(("factory_method", "expected_code"), BAD_TOKENS)
async def test_each_invalid_token_is_refused_with_its_own_code(
    api_factory: ApiFactory, factory_method: str, expected_code: str
) -> None:
    """Distinguishable so a *client* can act: re-authenticate, or report a misconfiguration."""
    async with api_factory() as api:
        token = getattr(api.factory, factory_method)()
        response = await api.client.get(f"{PREFIX}/me", headers=api.bearer(token))

        assert response.status_code == 401
        assert response.json()["error"]["code"] == expected_code
        assert token not in response.text, "no token material in the body"
        assert token.split(".")[1] not in response.text, "not even the payload segment"


async def test_a_malformed_credential_is_refused(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        for credential in ("not-a-token", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0", ""):
            response = await api.client.get(
                f"{PREFIX}/me", headers={"Authorization": f"Bearer {credential}"}
            )
            assert response.status_code == 401, credential
            assert response.json()["error"]["code"] in {"token_malformed", "token_missing"}


async def test_a_non_bearer_scheme_is_a_malformed_credential_not_an_absent_one(
    api_factory: ApiFactory,
) -> None:
    """A client using Basic auth gets a reason rather than a bare "sign in"."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/me", headers={"Authorization": "Basic dXNlcjpwYXNz"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_malformed"
        assert "dXNlcjpwYXNz" not in response.text, "and the credential is not echoed"


async def test_every_invalid_token_case_has_a_distinguishable_code(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        codes: dict[str, str] = {}
        for factory_method, _ in BAD_TOKENS:
            token = getattr(api.factory, factory_method)()
            response = await api.client.get(f"{PREFIX}/me", headers=api.bearer(token))
            codes[factory_method] = response.json()["error"]["code"]

    # Two cases share ``token_malformed`` legitimately — a token with no subject and one with no
    # expiry are both structurally unusable — and every other case is its own condition.
    assert len(set(codes.values())) >= len(BAD_TOKENS) - 1, codes


async def test_a_public_endpoint_also_refuses_a_present_but_invalid_token(
    api_factory: ApiFactory,
) -> None:
    """Treating a bad token as anonymous would silently serve the wrong units to a stale session."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast",
            params={"location": "Berlin", "days": 3},
            headers=api.bearer(api.factory.expired()),
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_expired"


# =========================================================================== 18.5 reads


async def test_user_a_cannot_read_user_bs_records_by_identifier(
    api_factory: ApiFactory,
) -> None:
    """And the refusal is the same response an unknown identifier produces."""
    async with with_inference(api_factory) as api:
        owned = await _own_ids(api, USER_B)
        intruder = api.authorize(subject=USER_A)

        attempts = (
            ("GET", f"/threads/{owned['thread_id']}", f"/threads/{uuid.uuid4()}"),
            ("GET", f"/evidence/{owned['evidence_id']}", f"/evidence/{uuid.uuid4()}"),
        )

        for method, foreign, unknown in attempts:
            foreign_response = await api.client.request(
                method, f"{PREFIX}{foreign}", headers=intruder
            )
            unknown_response = await api.client.request(
                method, f"{PREFIX}{unknown}", headers=intruder
            )

            assert foreign_response.status_code == unknown_response.status_code == 404, foreign
            assert (
                foreign_response.json()["error"]["code"] == unknown_response.json()["error"]["code"]
            )
            assert (
                foreign_response.json()["error"]["message"]
                == unknown_response.json()["error"]["message"]
            ), f"{foreign} is distinguishable from a record that does not exist"


async def test_user_a_cannot_read_user_bs_records_by_listing(api_factory: ApiFactory) -> None:
    async with with_inference(api_factory) as api:
        await _own_ids(api, USER_B)
        intruder = api.authorize(subject=USER_A)

        locations = await api.client.get(f"{PREFIX}/me/locations", headers=intruder)
        threads = await api.client.get(f"{PREFIX}/threads", headers=intruder)
        preferences = await api.client.get(f"{PREFIX}/me/preferences", headers=intruder)

        assert locations.json()["count"] == 0
        assert threads.json()["count"] == 0
        assert not preferences.json()["default_location"]
        assert USER_B not in locations.text + threads.text + preferences.text


async def test_user_a_sees_none_of_user_bs_data_on_any_protected_route(
    api_factory: ApiFactory,
) -> None:
    """Every protected read, checked for the other user's identifiers in the response."""
    async with with_inference(api_factory) as api:
        owned = await _own_ids(api, USER_B)
        intruder = api.authorize(subject=USER_A)

        for path in (
            "/me",
            "/me/preferences",
            "/me/locations",
            "/threads",
        ):
            response = await api.client.get(f"{PREFIX}{path}", headers=intruder)
            assert response.status_code == 200, path
            body = response.text
            assert USER_B not in body, f"{path} disclosed the other user's subject"
            for identifier in owned.values():
                assert identifier not in body, f"{path} disclosed {identifier}"


# =========================================================================== 18.6 mutations


async def test_user_a_cannot_mutate_user_bs_records(api_factory: ApiFactory) -> None:
    """And user B's records are byte-for-byte unchanged afterwards."""
    async with with_inference(api_factory) as api:
        owned = await _own_ids(api, USER_B)
        owner = api.authorize(subject=USER_B)
        intruder = api.authorize(subject=USER_A)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            before = await _owned_rows(session, USER_B)

        attempts: tuple[tuple[str, str, dict[str, Any]], ...] = (
            ("DELETE", f"/me/locations/{owned['saved_id']}", {}),
            ("DELETE", f"/threads/{owned['thread_id']}", {}),
            (
                "POST",
                "/agent/ask",
                {"json": {"question": "Which one is warmer?", "thread_id": owned["thread_id"]}},
            ),
        )

        for method, path, options in attempts:
            api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])
            response = await api.client.request(
                method, f"{PREFIX}{path}", headers=intruder, **options
            )
            assert response.status_code == 404, f"{method} {path} answered {response.status_code}"

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            after = await _owned_rows(session, USER_B)

        assert after == before, "user B's records changed"

        # And user B still has everything.
        assert (await api.client.get(f"{PREFIX}/me/locations", headers=owner)).json()["count"] == 1
        assert (await api.client.get(f"{PREFIX}/threads", headers=owner)).json()["count"] == 1


async def test_a_thread_append_attempt_on_a_foreign_thread_writes_nothing(
    api_factory: ApiFactory,
) -> None:
    """The ownership gate runs before the graph, so no turn is recorded and no checkpoint written."""
    async with with_inference(api_factory) as api:
        owned = await _own_ids(api, USER_B)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            before = await session.scalar(
                text("SELECT resolved_entities FROM threads WHERE id = :id"),
                {"id": owned["thread_id"]},
            )

        fake = api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])
        response = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "And Munich?", "thread_id": owned["thread_id"]},
            headers=api.authorize(subject=USER_A),
        )

        assert response.status_code == 404
        assert fake.call_count == 0, "the graph never ran"

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            after = await session.scalar(
                text("SELECT resolved_entities FROM threads WHERE id = :id"),
                {"id": owned["thread_id"]},
            )
        assert after == before, "the foreign thread's projection is unchanged"


async def _owned_rows(session: Any, subject: str) -> dict[str, list[Any]]:
    """Every row one user owns, ordered, for a byte-for-byte comparison."""
    snapshot: dict[str, list[Any]] = {}
    for table in user_owned_tables():
        owner = ownership_column(table)
        rows = await session.execute(
            text(f"SELECT * FROM {table} WHERE {owner} = :subject ORDER BY {owner}"),
            {"subject": subject},
        )
        snapshot[table] = [tuple(str(value) for value in row) for row in rows]
    return snapshot


# =========================================================================== 18.7 the three named


async def test_saved_locations_are_isolated(api_factory: ApiFactory) -> None:
    """``specs/authentication``: two users each save locations and each sees only their own."""
    async with api_factory() as api:
        first = api.authorize(subject=USER_A)
        second = api.authorize(subject=USER_B)

        await api.client.post(f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=first)
        await api.client.post(f"{PREFIX}/me/locations", json={"location": "Lisbon"}, headers=second)

        theirs = await api.client.get(f"{PREFIX}/me/locations", headers=first)
        others = await api.client.get(f"{PREFIX}/me/locations", headers=second)

    assert [entry["location"]["display_name"] for entry in theirs.json()["locations"]] == ["Berlin"]
    assert [entry["location"]["display_name"] for entry in others.json()["locations"]] == ["Lisbon"]


async def test_preferences_are_isolated(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        first = api.authorize(subject=USER_A)
        second = api.authorize(subject=USER_B)

        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=first
        )

        theirs = await api.client.get(f"{PREFIX}/me/preferences", headers=first)
        others = await api.client.get(f"{PREFIX}/me/preferences", headers=second)

    assert theirs.json()["unit_system"] == "imperial"
    assert theirs.json()["sources"]["unit_system"] == "chosen"
    assert others.json()["unit_system"] == "metric"
    assert others.json()["sources"]["unit_system"] == "default"


async def test_persistent_memory_is_isolated(api_factory: ApiFactory) -> None:
    """A follow-up resolves only against the acting user's own conversation."""
    async with with_inference(api_factory) as api:
        first = api.authorize(subject=USER_A)
        second = api.authorize(subject=USER_B)

        api.script(
            json_responses=[
                _plan(
                    PlanStep(
                        capability=Capability.FORECAST,
                        reason="both",
                        locations=("Berlin", "Munich"),
                        days=3,
                    )
                )
            ],
            completions=["Similar."],
        )
        established = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Compare Berlin and Munich", "create_thread": True},
            headers=first,
        )
        assert established.status_code == 200, established.text[:300]

        # The second user's own new thread has no context, so their follow-up resolves to nothing.
        api.script(
            json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1))],
            completions=["Cannot say."],
        )
        theirs = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Which one is warmer tomorrow?", "create_thread": True},
            headers=second,
        )

        assert theirs.status_code == 200, theirs.text[:300]
        answer = theirs.json()["answer"]
        assert answer["clarification_question"], "asked rather than assumed"
        assert "Berlin" not in (answer["clarification_question"] or "")
        assert answer["findings"] == [], "and no figure was produced for a question nobody asked"


# =========================================================================== 18.8 the SSE case


async def test_an_authenticated_stream_applies_the_users_memory_and_preferences(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=USER_A)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )

        api.script(
            json_responses=[
                _plan(
                    PlanStep(
                        capability=Capability.FORECAST,
                        reason="both",
                        locations=("Berlin", "Munich"),
                        days=3,
                    )
                )
            ],
            completions=["Similar."],
        )
        established = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Compare Berlin and Munich", "create_thread": True},
            headers=headers,
        )
        thread_id = established.json()["thread_id"]

        api.script(
            json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1))],
            completions=["Munich is warmer."],
        )
        streamed = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Which one is warmer tomorrow?", "thread_id": thread_id},
            headers=headers,
        )

    assert streamed.status_code == 200
    final = _final_event(streamed.text)
    resolved = final["answer"]["resolved"]

    assert resolved["location_source"] == "thread", "the user's own memory"
    assert resolved["unit_system"] == "imperial", "and their own preference, applied"
    # Read from the *thread* rather than from the profile, and that is the correct precedence: the
    # first turn applied the saved preference and recorded imperial into the conversation, so the
    # follow-up finds it there. The value is the person's; the source says where this turn got it.
    assert resolved["units_source"] == "thread"


async def test_an_unauthenticated_stream_starts_no_run(api_factory: ApiFactory) -> None:
    async with with_inference(api_factory) as api:
        fake = api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])
        response = await api.client.post(f"{PREFIX}/agent/stream", json={"question": "Berlin?"})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_missing"
        assert fake.call_count == 0


async def test_a_stream_on_a_foreign_thread_is_refused(api_factory: ApiFactory) -> None:
    async with with_inference(api_factory) as api:
        owned = await _own_ids(api, USER_B)

        fake = api.script(json_responses=[BERLIN_PLAN], completions=["Mild."])
        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Which one is warmer?", "thread_id": owned["thread_id"]},
            headers=api.authorize(subject=USER_A),
        )

        assert response.status_code == 404, "a 404 rather than a stream whose event says so"
        assert response.json()["error"]["code"] == "thread_not_found"
        assert fake.call_count == 0
        assert owned["thread_id"] not in response.text


def _final_event(payload: str) -> dict:
    """The stream's terminal event, parsed."""
    import json as json_module

    blocks = [block for block in payload.strip().split("\n\n") if block.strip()]
    last = blocks[-1]
    assert f"event: {StreamEventType.FINAL.value}" in last, f"the stream did not complete: {last}"
    for line in last.splitlines():
        if line.startswith("data: "):
            parsed: dict = json_module.loads(line[len("data: ") :])
            return parsed
    raise AssertionError("the final event carried no data")  # pragma: no cover


# =========================================================================== 18.9 the RLS gate


async def test_row_level_security_holds_with_the_ownership_predicate_omitted(
    engines: Engines, clean_database: None
) -> None:
    """The second gate, proven without the first.

    Every query in Weathra carries ``WHERE user_id = :actor``. That is the *primary* gate, and it
    is what these other tests exercise. This one deliberately omits it — a query no handler would
    write — so what is being asserted is the policy itself rather than the predicate above it.
    """
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        await session.execute(
            text(
                "INSERT INTO saved_locations (id, user_id, location_id, label, location) "
                "VALUES (gen_random_uuid(), :user_id, 'loc:52.52,13.41', 'Home', '{}')"
            ),
            {"user_id": owner},
        )

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)

        # No ownership predicate at all. Under the restricted role, the policy is the only thing
        # standing between this query and the other user's row.
        rows = await session.execute(text("SELECT id, user_id FROM saved_locations"))
        visible = [str(row[1]) for row in rows]

    assert visible == [], f"the policy let a foreign row through: {visible}"


async def test_the_same_query_returns_the_row_for_its_owner(
    engines: Engines, clean_database: None
) -> None:
    """The other half: the policy is restrictive, not simply broken."""
    owner = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        await session.execute(
            text(
                "INSERT INTO saved_locations (id, user_id, location_id, label, location) "
                "VALUES (gen_random_uuid(), :user_id, 'loc:52.52,13.41', 'Home', '{}')"
            ),
            {"user_id": owner},
        )

    async with session_as(engines, owner) as session:
        rows = await session.execute(text("SELECT user_id FROM saved_locations"))
        visible = [str(row[0]) for row in rows]

    assert visible == [owner]


async def test_a_session_with_no_principal_sees_no_user_owned_row(
    engines: Engines, clean_database: None
) -> None:
    """A public endpoint reads no user-owned row even if a handler bug asked it to."""
    owner = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)

    async with session_as(engines, None) as session:
        for table in user_owned_tables():
            found = await session.scalar(text(f"SELECT count(*) FROM {table}"))
            assert found == 0, f"an unauthenticated session saw a row in {table}"


async def test_the_policy_is_what_is_being_tested_and_it_is_present(
    engines: Engines, clean_database: None
) -> None:
    """A guard on the guard: if the policy were dropped, the isolation test above would pass
    vacuously only if it also stopped finding the policy. This asserts it is there.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        for table in user_owned_tables():
            row = (
                await session.execute(
                    text(
                        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                        "WHERE oid = to_regclass(:table)"
                    ),
                    {"table": table},
                )
            ).one()
            enabled, forced = row
            assert enabled, f"{table} has no row level security"
            assert forced, f"{table} does not FORCE it, so the owner would bypass the policy"

            count = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' "
                    "AND tablename = :table"
                ),
                {"table": table},
            )
            assert count and count >= 1, f"{table} carries no owner-restricting policy"


async def test_the_restricted_role_cannot_bypass_the_policies(
    engines: Engines, clean_database: None
) -> None:
    """``NOBYPASSRLS``, without which every policy above would be advisory."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        row = (
            await session.execute(
                text("SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = :r"),
                {"r": engines.settings.database_restricted_role},
            )
        ).one_or_none()

    assert row is not None
    bypass, superuser, can_login = row
    assert not bypass, "the restricted role can bypass Row Level Security"
    assert not superuser
    assert not can_login, "and it is NOLOGIN, so it cannot be connected to directly"


async def test_the_request_session_actually_runs_as_the_restricted_role(
    engines: Engines, clean_database: None
) -> None:
    """Without the role switch the policies would not bind at all — the owner is exempt."""
    async with session_as(engines, new_user_id()) as session:
        role = await session.scalar(text("SELECT current_role"))
        claims = await session.scalar(text("SELECT current_setting('request.jwt.claims', true)"))

    assert role == engines.settings.database_restricted_role
    assert claims, "and the acting user's claims are bound"


async def test_claims_do_not_leak_to_the_next_use_of_a_pooled_connection(
    engines: Engines, clean_database: None
) -> None:
    """``SET LOCAL`` scoped to the transaction: the next request must not inherit this one's."""
    first = new_user_id()

    async with session_as(engines, first) as session:
        bound = await session.scalar(text("SELECT weathra_current_user_id()"))
    assert bound == first

    async with session_as(engines, None) as session:
        after = await session.scalar(text("SELECT weathra_current_user_id()"))
    assert after is None, "the previous request's identity survived into an anonymous session"
