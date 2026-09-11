"""Tasks 25.3 and 25.4 — the deployed pair, asked the questions the suites ask of the code.

Every group above this one tests Weathra as source. These two tasks ask whether the *deployed*
frontend and backend behave the way those suites say they do, which nothing in-process can answer.

**Two tiers, and the split is not a convenience.**

The first needs no credentials and runs on every dispatch. It covers what production owes an
anonymous visitor and what it owes an unauthenticated caller: the pages that must render, the
routes that must redirect, readiness, the public weather surfaces with their attribution, the CORS
answer the browser actually receives, and — group 18's rejection half — every protected endpoint
refusing every shape of bad token. It runs through a client that *cannot* write: `read_only_client`
refuses anything but GET, HEAD and OPTIONS before a request is sent, so no check here can create a
row in anybody's account to make an assertion pass.

The second needs two dedicated deployed accounts and skips, naming the exact secrets, when they are
absent. It covers what only a real session can prove: that a valid token is served, and that one
account cannot read or change another's data. It signs in the way the browser does — Supabase's
password grant with the public client key — and nothing here mints a token the backend would
accept. The rejection cases below mint plenty, with a key production has never seen, which is the
point of them.

**What the tokens in the first tier are.** `TokenFactory` signs with a local key pair, so *every*
token it produces is refused by production, including the one it calls valid. That is the strongest
statement this suite can make about the deployed validator: a structurally perfect token from an
unknown issuer is still nothing.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from tests.auth_support import build_factory
from tests.live_support import (
    SECOND_ACCOUNT_VARIABLES,
    Credentials,
    LiveCheckError,
    Target,
    Token,
    assert_not_server_error,
    assert_status,
    credentials_from_env,
    fetch,
    json_body,
    preflight,
    read_only_client,
    redirect_target,
    sign_in,
    target_from_env,
    upstream_refused,
)
from weathra.api.classification import ADMINISTRATIVE_PATHS, PROTECTED_PATHS, PUBLIC_PATHS
from weathra.api.streaming import TERMINAL_EVENTS, StreamEventType

pytestmark = pytest.mark.deployed


@pytest.fixture(scope="module")
def target() -> Target:
    return target_from_env()


@pytest.fixture(scope="module")
def reader() -> Iterator[httpx.Client]:
    """The read-only client every credential-free check uses."""
    with read_only_client() as client:
        yield client


@pytest.fixture(scope="module")
def tokens() -> Any:
    """Locally signed tokens, every one of which production must refuse."""
    return build_factory()


@pytest.fixture(scope="module")
def credentials() -> Credentials:
    """One deployed account. Skips, naming the four variables, when there is none."""
    found, missing = credentials_from_env()
    if found is None:
        pytest.skip(
            "the authenticated checks need one deployed account; missing: " + ", ".join(missing)
        )
    return found


@pytest.fixture(scope="module")
def second_account(credentials: Credentials) -> Credentials:
    """The same credentials, but only for checks that genuinely need a second subject.

    Isolation cannot be asked with one account and it cannot be faked, so these checks skip rather
    than being weakened into something that passes without proving anything. Everything else an
    authenticated session can prove runs from the first account alone.
    """
    if not credentials.has_second_account:
        pytest.skip(
            "'one account cannot see another's data' needs a second deployed account; missing: "
            + ", ".join(SECOND_ACCOUNT_VARIABLES)
        )
    return credentials


# A GET the deployed backend can answer for each protected path, so "no token means 401" can be
# asked of every one of them. Path parameters are filled with values that do not exist: a 401 must
# arrive before anything is looked up, which is the property being checked.
PROTECTED_GETS: tuple[str, ...] = (
    "/me",
    "/me/preferences",
    "/me/usage",
    "/me/locations",
    "/threads",
    "/threads/00000000-0000-4000-8000-000000000000",
    "/evidence/00000000-0000-4000-8000-000000000000",
    "/me/watches",
    "/weather/changes?location=Berlin",
)

# The protected endpoints a browser reaches with something other than GET. They are checked with
# their own methods below, and the check is safe for exactly the reason the endpoints are
# protected: a request carrying no credential is refused at the authentication boundary before any
# handler runs, so it cannot create, change or remove anything. A 401 *is* the proof that nothing
# happened.
PROTECTED_WRITES: tuple[tuple[str, str], ...] = (
    ("POST", "/agent/ask"),
    ("POST", "/agent/stream"),
    ("POST", "/me/locations"),
    ("PUT", "/me/preferences"),
    ("DELETE", "/me/locations/00000000-0000-4000-8000-000000000000"),
    ("DELETE", "/me/data"),
    ("DELETE", "/threads/00000000-0000-4000-8000-000000000000"),
    # Weather Watch. Added 2026-09-11: `test_every_protected_path_has_a_credential_free_check`
    # caught these missing against the deployed pair, which is the second time that assertion has
    # found a protected surface nobody was probing — the first was group 31's administrative paths.
    # All five methods the router publishes, because a 401 on the collection says nothing about the
    # member, and `evaluate` reaches a provider if it is ever reached at all.
    ("POST", "/me/watches"),
    ("PATCH", "/me/watches/00000000-0000-4000-8000-000000000000"),
    ("DELETE", "/me/watches/00000000-0000-4000-8000-000000000000"),
    ("POST", "/me/watches/00000000-0000-4000-8000-000000000000/evaluate"),
)

NOT_A_REAL_ID = "00000000-0000-4000-8000-000000000000"


def test_every_protected_path_has_a_credential_free_check() -> None:
    """The completeness half: a protected route added later must appear here or fail this test.

    The administrative paths are covered by `test_saas_acceptance.py`, which owns task 34.7, and
    are excluded here rather than duplicated — that module asserts its own half is complete, and
    the assertion below asserts the two halves partition the protected surface with nothing
    falling between them.
    """
    covered = {path.split("?")[0] for path in PROTECTED_GETS}
    covered |= {path for _, path in PROTECTED_WRITES}
    identified = {
        path.replace("{saved_id}", NOT_A_REAL_ID)
        .replace("{thread_id}", NOT_A_REAL_ID)
        .replace("{evidence_id}", NOT_A_REAL_ID)
        .replace("{watch_id}", NOT_A_REAL_ID)
        for path in PROTECTED_PATHS
        if path not in ADMINISTRATIVE_PATHS
    }
    assert not identified - covered, (
        f"protected paths with no deployed check: {sorted(identified - covered)}"
    )


def test_the_two_deployed_modules_between_them_cover_every_protected_path() -> None:
    """Neither module can be complete on its own, so the partition itself is asserted.

    Without this, a path could be dropped from `ADMINISTRATIVE_PATHS` *and* stay excluded here,
    and both modules would report themselves complete while nothing checked it.
    """
    administrative = set(ADMINISTRATIVE_PATHS)
    ordinary = set(PROTECTED_PATHS) - administrative

    assert administrative <= set(PROTECTED_PATHS), (
        "an administrative path is not classified protected, so no tier checks its refusal: "
        f"{sorted(administrative - set(PROTECTED_PATHS))}"
    )
    assert ordinary | administrative == set(PROTECTED_PATHS)
    assert not ordinary & administrative


# ------------------------------------------------------------------ 25.4, the frontend


def test_the_production_frontend_serves_its_sign_in_page(
    reader: httpx.Client, target: Target
) -> None:
    response = fetch(reader, "GET", target.page("/sign-in"))
    assert_not_server_error(response)
    assert_status(response, 200)
    assert "Weathra" in response.text, "the sign-in page rendered without the product name in it"
    assert "Sign in" in response.text


@pytest.mark.parametrize("path", ["/", "/dashboard", "/settings", "/locations", "/historical"])
def test_a_protected_screen_redirects_an_unauthenticated_visitor(
    reader: httpx.Client, target: Target, path: str
) -> None:
    """Group 18.10 against the deployment: redirected to sign-in, with the destination kept.

    The destination matters as much as the redirect. Losing it is how a person who followed a link
    ends up on the dashboard's default screen after signing in, which reads as the link not working.
    """
    response = fetch(reader, "GET", target.page(path))
    assert_not_server_error(response)
    location = redirect_target(response)
    assert location.startswith("/sign-in"), f"{path} redirected to {location}, not to sign-in"
    if path != "/":
        assert "next=" in location, f"{path} redirected without keeping the destination: {location}"


def test_the_production_frontend_carries_no_private_credential(
    reader: httpx.Client, target: Target
) -> None:
    """Group 18.11, asked of what is actually being served rather than of a local build."""
    response = fetch(reader, "GET", target.page("/sign-in"))
    served = response.text.upper()
    for forbidden in ("SERVICE_ROLE", "DATABASE_URL", "OPENROUTER", "SUPABASE_SERVICE"):
        assert forbidden not in served, f"the deployed sign-in page mentions {forbidden}"


# ------------------------------------------------------------------ 25.4, the backend


def test_the_backend_reports_every_dependency_reachable(
    reader: httpx.Client, target: Target
) -> None:
    """ "Readiness all-reachable": every *required* dependency, by name, from the deployment itself."""
    response = fetch(reader, "GET", target.api("/ready"))
    assert_not_server_error(response)
    assert_status(response, 200)
    body = json_body(response)
    assert body.get("ready") is True, f"the backend reports itself not ready: {body.get('ready')}"
    assert body.get("environment") == "production", (
        f"the deployment reports environment {body.get('environment')!r}"
    )

    dependencies = body.get("dependencies")
    assert isinstance(dependencies, list) and dependencies, "readiness named no dependencies"
    unreachable = [
        entry.get("name")
        for entry in dependencies
        if entry.get("required") and entry.get("reachable") is False
    ]
    assert not unreachable, f"required dependencies unreachable: {unreachable}"

    named = {entry.get("name") for entry in dependencies}
    for expected in ("database", "authentication_provider", "weather_provider"):
        assert expected in named, f"readiness does not report {expected}"


def test_the_backend_health_endpoint_answers(reader: httpx.Client, target: Target) -> None:
    response = fetch(reader, "GET", target.api("/health"))
    assert_status(response, 200)
    assert json_body(response).get("status") == "ok"


def test_a_public_forecast_is_served_without_a_session_and_says_where_it_came_from(
    reader: httpx.Client, target: Target
) -> None:
    """25.4's "attributed public forecast without a session", asked of the deployment.

    Attribution is the part worth checking rather than the numbers: `specs/weather-providers`
    requires every figure to name its provider, and a forecast that arrived without one would be
    indistinguishable from one Weathra had invented.
    """
    response = fetch(reader, "GET", target.api("/weather/forecast?location=Berlin&days=3"))
    assert_not_server_error(response)
    if upstream_refused(response):
        pytest.skip("the weather provider rate-limited this request; the surface was not exercised")
    assert_status(response, 200)
    body = json_body(response)
    attribution = body.get("attribution", {})
    assert attribution.get("provider"), "the forecast names no provider"
    assert attribution.get("location", {}).get("timezone"), "no resolved location"
    assert attribution.get("retrieved_at"), "the forecast does not say when it was fetched"


def test_a_baseline_comparison_labels_both_sides(reader: httpx.Client, target: Target) -> None:
    """25.4's "baseline comparison with both sides labelled".

    A comparison that did not label its sides would leave a forecast figure and a multi-year
    observed baseline looking like the same kind of number, which is the confusion
    `specs/historical-weather` exists to prevent.

    `temperature_mean` is the measure the product itself asks for — it is the route's default and
    what the Dashboard sends — because a baseline is computed from the daily series, which carries
    daily aggregates and not instantaneous measures. An earlier version of this check asked for
    `temperature` and read the resulting refusal as a production data gap; the next test is what
    that mistake became.
    """
    response = fetch(
        reader,
        "GET",
        target.api(
            "/weather/history/baseline/comparison"
            "?location=Berlin&measure=temperature_mean&start=2025-07-01&end=2025-07-07"
        ),
    )
    assert_not_server_error(response)
    if upstream_refused(response):
        pytest.skip("the weather provider rate-limited this request; the surface was not exercised")
    assert_status(response, 200)
    body = json_body(response)
    assert body.get("baseline", {}).get("labelling"), "the baseline side carries no labelling"
    assert body.get("observed_data_class"), "the observed side carries no data class"
    assert body.get("characterization"), "the comparison states no characterisation"


def test_a_baseline_of_an_instantaneous_measure_is_refused_clearly(
    reader: httpx.Client, target: Target
) -> None:
    """The unsupported case, and that production says *why* rather than blaming the archive.

    Asking to baseline `temperature` cannot be satisfied for any location in any year: the daily
    series carries `temperature_mean`, `temperature_max` and `temperature_min`. Production used to
    answer 404 `no_data_for_range` — "the archive holds no temperature observations for this
    calendar period in any of the 10 year(s) requested" — which reads as a coverage gap and sends
    the reader hunting for missing data. It now refuses up front and names what to ask for.
    """
    response = fetch(
        reader,
        "GET",
        target.api(
            "/weather/history/baseline"
            "?location=Berlin&measure=temperature&start=2025-07-01&end=2025-07-07"
        ),
    )
    assert_not_server_error(response)
    assert_status(response, 400)
    error = json_body(response).get("error", {})
    assert error.get("code") == "validation_failed", f"refused as {error.get('code')!r}"
    assert "temperature_mean" in error.get("message", ""), (
        "the refusal does not say what to ask for instead"
    )


@pytest.mark.parametrize("path", sorted(PUBLIC_PATHS))
def test_no_public_surface_answers_with_a_server_error(
    reader: httpx.Client, target: Target, path: str
) -> None:
    """Every public path, and none of them may 5xx.

    A 4xx here is fine and expected — most of these need parameters — so the assertion is narrow
    on purpose: what must not happen is the deployment failing rather than refusing.
    """
    response = fetch(reader, "GET", target.api(path))
    assert_not_server_error(response)


# ------------------------------------------------------------------ 25.4, the contract between them


def test_the_backend_accepts_the_production_frontend_origin(
    reader: httpx.Client, target: Target
) -> None:
    """The header the browser is actually given, for the origin production is actually served on."""
    allowed = preflight(reader, target.api("/health"), target.frontend)
    assert allowed == target.frontend, (
        "the backend does not answer the production frontend's origin with a matching "
        f"Access-Control-Allow-Origin (got {allowed!r})"
    )


def test_the_backend_refuses_an_unrelated_origin(reader: httpx.Client, target: Target) -> None:
    """The other half: an allow-list that allowed everything would prove nothing about the first."""
    assert preflight(reader, target.api("/health"), "https://not-weathra-example.invalid") is None


# ------------------------------------------------------------------ 25.3, the rejection half


@pytest.mark.parametrize("path", PROTECTED_GETS)
def test_a_protected_endpoint_refuses_a_caller_with_no_token(
    reader: httpx.Client, target: Target, path: str
) -> None:
    """Group 18.3 against the deployment: 401, on every protected path, with no token at all."""
    response = fetch(reader, "GET", target.api(path))
    assert_not_server_error(response)
    assert_status(response, 401)


@pytest.mark.parametrize(
    "kind",
    [
        "valid",
        "expired",
        "wrong_issuer",
        "wrong_audience",
        "bad_signature",
        "unknown_key_id",
        "malformed",
        "truncated",
        "unsigned",
    ],
)
def test_a_protected_endpoint_refuses_every_shape_of_foreign_token(
    reader: httpx.Client, target: Target, tokens: Any, kind: str
) -> None:
    """Group 18.4 against the deployment, including the case that matters most.

    `valid` is in this list deliberately: it is a structurally perfect token signed by a key
    production has never seen, so a 401 for it is the deployed validator saying it checks
    signatures against the identity provider's keys rather than merely parsing what it is handed.
    """
    token = getattr(tokens, kind)()
    response = fetch(reader, "GET", target.api("/me"), headers={"Authorization": f"Bearer {token}"})
    assert_not_server_error(response)
    assert_status(response, 401)

    body = response.text
    assert token not in body, "the refusal echoed the token back"
    assert token[:24] not in body, "the refusal echoed part of the token back"


@pytest.mark.parametrize(("method", "path"), PROTECTED_WRITES, ids=lambda value: str(value))
def test_a_protected_write_refuses_a_caller_with_no_token(
    target: Target, method: str, path: str
) -> None:
    """Group 18.3's other half: the endpoints a browser reaches with POST, PUT and DELETE.

    These use their own client rather than the read-only one, and that is safe for exactly the
    reason being asserted: with no credential the request is refused at the authentication boundary
    before any handler runs, so it cannot create, change or remove anything. A 401 *is* the proof
    that nothing happened; any other answer would be the finding.

    `/agent/stream` is here because it is a POST, and its refusal must arrive as a refusal rather
    than as an opened stream that then fails.
    """
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        response = fetch(client, method, target.api(path), json={})
    assert_not_server_error(response)
    assert_status(response, 401)
    assert "text/event-stream" not in response.headers.get("content-type", "")


# ------------------------------------------------------------------ 25.3, what needs a session


@pytest.fixture(scope="module")
def writer() -> Iterator[httpx.Client]:
    """A client that may write — used only for the two dedicated accounts' own data."""
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        yield client


@pytest.fixture(scope="module")
def token_a(writer: httpx.Client, credentials: Credentials) -> Token:
    return sign_in(writer, credentials, credentials.user_a_email, credentials.user_a_password)


@pytest.fixture(scope="module")
def token_b(
    writer: httpx.Client, second_account: Credentials, subject_a: str, target: Target
) -> Token:
    """The second account's session, having confirmed it really is a second *subject*.

    `has_second_account` rejects the same address supplied twice, which is the mistake that is easy
    to make; this is the one that is not. Two distinct addresses can still resolve to one Supabase
    user, and when they do, every isolation check below reports that one account reads and deletes
    the other's data. That is a true statement about one account and a false alarm about
    production, so it is refused here — the checks skip, naming the variables to fix — rather than
    being recorded as a leak.
    """
    assert second_account.user_b_email and second_account.user_b_password
    token = sign_in(
        writer, second_account, second_account.user_b_email, second_account.user_b_password
    )
    response = fetch(writer, "GET", target.api("/me"), headers=_auth(token))
    assert_status(response, 200, *second_account.secrets)
    if json_body(response, *second_account.secrets).get("user_id") == subject_a:
        pytest.skip(
            "both live accounts resolve to the same deployed subject, so nothing here would be an "
            "isolation check; point " + " and ".join(SECOND_ACCOUNT_VARIABLES) + " at a second "
            "account"
        )
    return token


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_a_real_session_is_served_and_acts_as_its_own_subject(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> None:
    """Group 18.2 against the deployment: the valid case, and whose it is."""
    response = fetch(writer, "GET", target.api("/me"), headers=_auth(token_a))
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 200, *credentials.secrets)
    body = json_body(response, *credentials.secrets)
    assert body.get("user_id"), "/me answered without naming its subject"
    assert body.get("email") == credentials.user_a_email, "/me answered as somebody else"


@pytest.fixture
def location_of_b(
    writer: httpx.Client, target: Target, token_b: Token, credentials: Credentials
) -> Iterator[dict[str, Any]]:
    """One saved location belonging to account B, removed afterwards.

    Isolation cannot be checked between two empty accounts: "A cannot see B's data" is vacuous
    unless B has some. This is the smallest amount of data that makes the question real, it lives
    in a dedicated test account rather than anybody's own, and it is deleted whether the assertions
    pass or not.
    """
    created = fetch(
        writer,
        "POST",
        target.api("/me/locations"),
        headers=_auth(token_b),
        json={"latitude": 35.6895, "longitude": 139.6917, "label": "live-acceptance"},
    )
    if upstream_refused(created):
        pytest.skip(
            "the weather provider rate-limited the request that saves a location, so there is no "
            "record to ask an isolation question about. Not an isolation failure: nothing was "
            "asked. Re-run when the provider's window has turned over"
        )
    assert_status(created, (200, 201), *credentials.secrets)
    record = json_body(created, *credentials.secrets)
    try:
        yield record
    finally:
        fetch(
            writer,
            "DELETE",
            target.api(f"/me/locations/{record['id']}"),
            headers=_auth(token_b),
        )


def test_one_account_cannot_read_another_s_saved_location(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    credentials: Credentials,
    location_of_b: dict[str, Any],
) -> None:
    """Group 18.5 against the deployment, by identifier and by listing.

    The refusal must be indistinguishable from a record that does not exist: a 403 would confirm
    that the identifier is real and somebody else's, which is itself a disclosure.
    """
    listing = fetch(writer, "GET", target.api("/me/locations"), headers=_auth(token_a))
    assert_status(listing, 200, *credentials.secrets)
    identifiers = {
        entry.get("id") for entry in json_body(listing, *credentials.secrets).get("locations", [])
    }
    assert location_of_b["id"] not in identifiers, "A's listing contains B's saved location"


def test_one_account_cannot_delete_another_s_saved_location(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    token_b: Token,
    credentials: Credentials,
    location_of_b: dict[str, Any],
) -> None:
    """Group 18.6 against the deployment: the attempt fails and B's record is still there."""
    attempt = fetch(
        writer, "DELETE", target.api(f"/me/locations/{location_of_b['id']}"), headers=_auth(token_a)
    )
    assert_status(attempt, 404, *credentials.secrets)

    listing = fetch(writer, "GET", target.api("/me/locations"), headers=_auth(token_b))
    assert_status(listing, 200, *credentials.secrets)
    identifiers = {
        entry.get("id") for entry in json_body(listing, *credentials.secrets).get("locations", [])
    }
    assert location_of_b["id"] in identifiers, "B's saved location did not survive A's attempt"


def test_an_authenticated_stream_completes(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> None:
    """Group 18.8's authenticated case and 25.4's stream, in one: it opens, and it finishes.

    **Completion is named, not guessed.** This asserted `"complete" in event or "done" in event`
    until 2026-09-11, and Weathra's event vocabulary has never contained either word: the terminal
    events are `final` and `error` (`StreamEventType`, and the catalogue in `docs/api.md`). The
    assertion could not have passed against a working stream, and nobody found out, because until
    the deployed inference credential was corrected the stream always terminated on `error` and the
    check failed for the reason everyone was already expecting. A substring guess that happens to
    match the failure path is the most expensive kind of wrong, so the vocabulary is imported here
    rather than spelled again — a renamed event breaks this test instead of quietly passing it.

    `specs/agent-orchestration` requires **exactly one** terminal event, so both halves are asserted:
    `final` arrived, and `error` did not. "It finished" and "it did not fail" are not the same claim
    when a stream is allowed to end either way.
    """
    with writer.stream(
        "POST",
        target.api("/agent/stream"),
        headers=_auth(token_a),
        json={"question": "What is the forecast for Berlin"},
        timeout=120.0,
    ) as response:
        assert response.status_code == 200, f"the stream answered {response.status_code}"
        assert "text/event-stream" in response.headers.get("content-type", "")
        body = list(response.iter_lines())

    events = [line.split(":", 1)[1].strip() for line in body if line.startswith("event:")]
    assert events, "the stream carried no events"

    terminal = [event for event in events if event in TERMINAL_EVENTS]
    assert terminal == [StreamEventType.FINAL], (
        f"the stream's terminal events were {terminal or 'none'}, expected exactly "
        f"[{StreamEventType.FINAL}]; all events: {events}"
    )

    # The terminal event is the one that carries the answer, so an empty `final` would satisfy
    # every assertion above and deliver nothing. 25.4 asks for a stream that *completes*.
    final_payload = _final_payload(body, *credentials.secrets)
    assert final_payload.get("answer"), "the stream's final event carried no answer"
    assert final_payload.get("evidence_id"), "the stream's final event named no evidence record"

    # The token travels in a header on the way in and must not come back out in any frame.
    assert str(token_a) not in "\n".join(body), "the stream echoed the bearer token"


def _final_payload(body: list[str], *secrets: str) -> dict[str, Any]:
    """The `data:` line belonging to the `final` event, parsed."""
    for index, line in enumerate(body):
        if line.startswith("event:") and line.split(":", 1)[1].strip() == StreamEventType.FINAL:
            for following in body[index + 1 :]:
                if following.startswith("data:"):
                    try:
                        parsed = json.loads(following.split(":", 1)[1].strip())
                    except ValueError as failure:
                        raise LiveCheckError(
                            "the stream's final event carried a data line that is not JSON"
                        ) from failure
                    if not isinstance(parsed, dict):
                        raise LiveCheckError("the stream's final event is not an object")
                    return parsed
                if following.startswith("event:"):
                    break
    raise LiveCheckError("the stream carried no final event to read")


@pytest.fixture(scope="module")
def answer_of_a(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> Iterator[dict[str, Any]]:
    """One question, asked once, through the deployed product as account A.

    Module-scoped and shared rather than asked per test, and that is the point rather than a
    speed optimisation. `/ask` is the only check in either task that reaches the inference gateway,
    so every additional caller would be another real request against a real key for a criterion
    that is already answered. The three assertions below — the grounding criterion of 25.4, and
    18.5's evidence and thread isolation, which need a record that genuinely belongs to somebody —
    all read this one answer. There is no retry: a failure is reported as a failure.

    `create_thread` is set because 18.7's persistent-memory isolation needs a thread that genuinely
    belongs to somebody; the thread is this fixture's own record and is deleted on the way out.
    """
    response = fetch(
        writer,
        "POST",
        target.api("/agent/ask"),
        headers=_auth(token_a),
        json={
            "question": (
                "Acceptance check: what is the temperature in Berlin over the next three days?"
            ),
            "create_thread": True,
        },
        timeout=180.0,
    )
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 200, *credentials.secrets)
    body = json_body(response, *credentials.secrets)
    try:
        yield body
    finally:
        # The thread is this check's own record and is removed whether the assertions passed or
        # not. The evidence record it produced is left alone: it is what `/evidence/{id}` is asked
        # about above, and deleting a run's evidence would be deleting the acceptance evidence.
        thread_id = body.get("thread_id")
        if thread_id:
            fetch(
                writer,
                "DELETE",
                target.api(f"/threads/{thread_id}"),
                headers=_auth(token_a),
            )


def test_a_question_s_every_figure_appears_in_its_evidence(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    credentials: Credentials,
    answer_of_a: dict[str, Any],
) -> None:
    """25.4's remaining criterion: a question through `/ask`, and its figures held to its evidence.

    **Why the grounding report is the assertion rather than a re-derivation here.** "Every figure
    appears in its evidence" is a claim the product already computes, over the prose it just wrote:
    `GroundingReport.verified` is documented as true exactly when every figure in the prose matched
    a finding or an evidence value, with the extraction method and rounding tolerance named beside
    it. Re-implementing that matching in a test would be asserting a second, weaker version of it
    and calling the agreement proof.

    So this asks three things the report cannot fake. `figures_checked` must be non-zero — a
    verified report over nothing checked is vacuous, and is the shape a broken extractor would
    take. `ungrounded_figures` must be empty, and is printed when it is not, because that list is
    the actual finding. And `prose_discarded` must be false: the zero-retrieval guard withholding
    the prose is a legitimate outcome for the *product* and a failed check for this criterion,
    since there are then no figures to appear anywhere.

    **The round trip is the other half.** An answer that carries its own evidence proves the run
    recorded one; fetching `/evidence/{id}` as the same caller proves the record was *stored* and
    is retrievable, which is what a person following the answer's evidence link actually does. The
    two request identifiers must agree, or the link points at somebody else's run.
    """
    body = answer_of_a

    answer = body.get("answer") or {}
    grounding = answer.get("grounding") or {}
    assert grounding, "the answer carried no grounding report"
    assert not grounding.get("prose_discarded"), (
        "the prose was withheld by the zero-retrieval guard, so no figure appears anywhere"
    )
    assert grounding.get("figures_checked", 0) > 0, (
        f"the grounding report checked no figures: {grounding}"
    )
    assert not grounding.get("ungrounded_figures"), (
        f"figures in the prose that the evidence does not support: "
        f"{grounding.get('ungrounded_figures')}"
    )
    assert grounding.get("verified") is True, f"the grounding report is not verified: {grounding}"

    record = answer.get("evidence") or {}
    assert record.get("request_id"), "the answer carried no evidence record"

    # Every figure the answer *reports* — not only the ones in the prose — carries the class and
    # the source it came from. A finding with a value and no data class is a number with no
    # provenance, which is the thing `specs/safety-grounding` exists to prevent.
    for finding in answer.get("findings") or ():
        if finding.get("value") is None:
            continue
        assert finding.get("data_class"), f"a reported figure names no data class: {finding}"

    evidence_id = body.get("evidence_id")
    if evidence_id:
        stored = fetch(
            writer, "GET", target.api(f"/evidence/{evidence_id}"), headers=_auth(token_a)
        )
        assert_status(stored, 200, *credentials.secrets)
        held = json_body(stored, *credentials.secrets)
        assert held.get("request_id") == record.get("request_id"), (
            "the stored evidence record belongs to a different run than the answer"
        )


# --------------------------------------------- 25.3, the second subject and the other direction
#
# Everything below needs both accounts. Group 18's isolation cases are symmetric by construction —
# "A cannot see B" and "B cannot see A" are the same policy asked from opposite ends — and a suite
# that only ever asked one direction would pass against a policy that happened to be right for one
# account and wrong for the other. Asking both costs one extra record and proves the property the
# task names rather than half of it.


@pytest.fixture(scope="module")
def subject_a(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> str:
    """Account A's own subject, as the deployment reports it."""
    response = fetch(writer, "GET", target.api("/me"), headers=_auth(token_a))
    assert_status(response, 200, *credentials.secrets)
    identifier = json_body(response, *credentials.secrets).get("user_id")
    assert isinstance(identifier, str) and identifier, "/me named no subject for account A"
    return identifier


@pytest.fixture(scope="module")
def subject_b(
    writer: httpx.Client, target: Target, token_b: Token, credentials: Credentials
) -> str:
    response = fetch(writer, "GET", target.api("/me"), headers=_auth(token_b))
    assert_status(response, 200, *credentials.secrets)
    identifier = json_body(response, *credentials.secrets).get("user_id")
    assert isinstance(identifier, str) and identifier, "/me named no subject for account B"
    return identifier


def test_the_second_account_is_served_and_acts_as_its_own_subject(
    writer: httpx.Client,
    target: Target,
    token_b: Token,
    second_account: Credentials,
    subject_a: str,
) -> None:
    """Group 18.2 for the second subject, and that it *is* a second one.

    The last assertion is the one worth having. Two sessions that both resolved to the same subject
    would make every isolation check below pass while proving nothing at all, and that is exactly
    what a misconfigured pair of accounts — or a token cached across the two sign-ins — would look
    like from the outside.
    """
    response = fetch(writer, "GET", target.api("/me"), headers=_auth(token_b))
    assert_not_server_error(response, *second_account.secrets)
    assert_status(response, 200, *second_account.secrets)
    body = json_body(response, *second_account.secrets)

    assert body.get("user_id"), "/me answered without naming its subject"
    assert body.get("email") == second_account.user_b_email, "/me answered as somebody else"
    assert body.get("email_verified") is True, (
        "the second account's token does not report a verified email"
    )
    assert body.get("user_id") != subject_a, (
        "both sessions resolve to the same subject, so nothing below would be an isolation check"
    )


@pytest.fixture
def location_of_a(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> Iterator[dict[str, Any]]:
    """The mirror of `location_of_b`: one saved location belonging to account A, removed after.

    Deliberately a different place from B's, so a listing that returned the wrong account's rows
    could not be mistaken for the right one on its contents.
    """
    created = fetch(
        writer,
        "POST",
        target.api("/me/locations"),
        headers=_auth(token_a),
        json={"latitude": -33.8688, "longitude": 151.2093, "label": "live-acceptance-a"},
    )
    if upstream_refused(created):
        pytest.skip(
            "the weather provider rate-limited the request that saves a location, so there is no "
            "record to ask an isolation question about. Not an isolation failure: nothing was "
            "asked. Re-run when the provider's window has turned over"
        )
    assert_status(created, (200, 201), *credentials.secrets)
    record = json_body(created, *credentials.secrets)
    try:
        yield record
    finally:
        fetch(
            writer,
            "DELETE",
            target.api(f"/me/locations/{record['id']}"),
            headers=_auth(token_a),
        )


def test_the_second_account_cannot_read_the_first_s_saved_location(
    writer: httpx.Client,
    target: Target,
    token_b: Token,
    credentials: Credentials,
    location_of_a: dict[str, Any],
) -> None:
    """Group 18.5 in the other direction: B's listing does not carry A's row."""
    listing = fetch(writer, "GET", target.api("/me/locations"), headers=_auth(token_b))
    assert_status(listing, 200, *credentials.secrets)
    identifiers = {
        entry.get("id") for entry in json_body(listing, *credentials.secrets).get("locations", [])
    }
    assert location_of_a["id"] not in identifiers, "B's listing contains A's saved location"


def test_the_second_account_cannot_delete_the_first_s_saved_location(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    token_b: Token,
    credentials: Credentials,
    location_of_a: dict[str, Any],
) -> None:
    """Group 18.6 in the other direction, and A's record is still there afterwards."""
    attempt = fetch(
        writer, "DELETE", target.api(f"/me/locations/{location_of_a['id']}"), headers=_auth(token_b)
    )
    assert_status(attempt, 404, *credentials.secrets)

    listing = fetch(writer, "GET", target.api("/me/locations"), headers=_auth(token_a))
    assert_status(listing, 200, *credentials.secrets)
    identifiers = {
        entry.get("id") for entry in json_body(listing, *credentials.secrets).get("locations", [])
    }
    assert location_of_a["id"] in identifiers, "A's saved location did not survive B's attempt"


def test_neither_account_is_served_the_other_s_evidence_record(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    token_b: Token,
    credentials: Credentials,
    answer_of_a: dict[str, Any],
) -> None:
    """Group 18.5's evidence case against the deployment, over a record that genuinely exists.

    The identifier came out of A's own answer a moment earlier, so this is not the absent-record
    path dressed up: the row is there, it is A's, and B is refused with the *same* 404 A would get
    for an identifier that was never issued. A 403 would confirm the record is real and somebody
    else's, which is itself the disclosure the handler's identical-response rule exists to prevent.
    """
    evidence_id = answer_of_a.get("evidence_id")
    if not evidence_id:
        pytest.skip("the deployed answer carried no stored evidence identifier to ask about")

    mine = fetch(writer, "GET", target.api(f"/evidence/{evidence_id}"), headers=_auth(token_a))
    assert_status(mine, 200, *credentials.secrets)

    theirs = fetch(writer, "GET", target.api(f"/evidence/{evidence_id}"), headers=_auth(token_b))
    assert_status(theirs, 404, *credentials.secrets)

    absent = fetch(writer, "GET", target.api(f"/evidence/{NOT_A_REAL_ID}"), headers=_auth(token_b))
    assert theirs.status_code == absent.status_code, (
        "a foreign record is refused differently from an absent one, which discloses that it exists"
    )


@pytest.fixture(scope="module")
def thread_of_a(
    writer: httpx.Client, target: Target, token_a: Token, credentials: Credentials
) -> Iterator[str]:
    """One thread genuinely owned by account A, opened without needing an answer.

    Thread *ownership* has nothing to do with the inference provider, and until 2026-09-11 this
    suite proved it with a thread that came back from `/ask` — so a deployment whose gateway was
    refusing credentials could not be asked whether one account's conversations are visible to
    another. That is the wrong dependency: it made an authorization property untestable for a
    reason that is not about authorization, and 25.3's isolation cases errored at setup rather than
    reporting anything.

    `/agent/stream` opens the thread before it reaches inference — deliberately, because
    `specs/usage-limits` and the ownership check both have to refuse *before* a response starts —
    so a run that then fails at the gateway still leaves a real, owned row behind. This asks for
    exactly that and does not care how the run ends: the assertion is about who can see the thread,
    not what was said in it.

    Identified by comparing A's listing before and after, because a stream that fails at its first
    event never emits the thread event that would otherwise name it. Removed on the way out,
    whatever the assertions did, and nothing pre-existing is touched.
    """
    before = _thread_ids(
        fetch(writer, "GET", target.api("/threads"), headers=_auth(token_a)), credentials
    )
    with writer.stream(
        "POST",
        target.api("/agent/stream"),
        headers=_auth(token_a),
        json={"question": "Acceptance check: opening a thread.", "create_thread": True},
        timeout=180.0,
    ) as response:
        assert_status(response, 200, *credentials.secrets)
        # Drained rather than read: whether the run completes is criterion 7's question, asked
        # once elsewhere. Leaving the body unread would hold the connection open.
        for _ in response.iter_lines():
            pass

    listing = fetch(writer, "GET", target.api("/threads"), headers=_auth(token_a))
    assert_status(listing, 200, *credentials.secrets)
    opened = _thread_ids(listing, credentials) - before
    if not opened:
        pytest.skip("the deployed stream opened no thread, so nothing here is an isolation check")
    thread_id = sorted(opened)[0]
    try:
        yield thread_id
    finally:
        fetch(writer, "DELETE", target.api(f"/threads/{thread_id}"), headers=_auth(token_a))


def test_neither_account_is_served_the_other_s_thread(
    writer: httpx.Client,
    target: Target,
    token_a: Token,
    token_b: Token,
    credentials: Credentials,
    thread_of_a: str,
) -> None:
    """Group 18.5 and 18.7's persistent-memory case: threads, by listing and by identifier."""
    mine = fetch(writer, "GET", target.api("/threads"), headers=_auth(token_a))
    assert_status(mine, 200, *credentials.secrets)
    own = _thread_ids(mine, credentials)

    theirs = fetch(writer, "GET", target.api("/threads"), headers=_auth(token_b))
    assert_status(theirs, 200, *credentials.secrets)
    other = _thread_ids(theirs, credentials)

    assert not (own & other), f"both accounts are served the same thread: {sorted(own & other)}"

    assert thread_of_a in own, "A's own thread is missing from A's listing"
    assert thread_of_a not in other, "B's listing contains A's thread"

    fetched = fetch(writer, "GET", target.api(f"/threads/{thread_of_a}"), headers=_auth(token_b))
    assert_status(fetched, 404, *credentials.secrets)

    absent = fetch(writer, "GET", target.api(f"/threads/{NOT_A_REAL_ID}"), headers=_auth(token_b))
    assert fetched.status_code == absent.status_code, (
        "a foreign thread is refused differently from an absent one, which discloses that it exists"
    )

    # The other direction of the same policy, and the destructive one: a refusal that still deleted
    # the row would satisfy every assertion above and lose A's conversation.
    attempt = fetch(writer, "DELETE", target.api(f"/threads/{thread_of_a}"), headers=_auth(token_b))
    assert_status(attempt, 404, *credentials.secrets)
    survivor = fetch(writer, "GET", target.api("/threads"), headers=_auth(token_a))
    assert_status(survivor, 200, *credentials.secrets)
    assert thread_of_a in _thread_ids(survivor, credentials), (
        "A's thread did not survive B's delete attempt"
    )


def _thread_ids(response: httpx.Response, credentials: Credentials) -> set[str]:
    """The identifiers in a `/threads` listing."""
    entries = json_body(response, *credentials.secrets).get("threads")
    if not isinstance(entries, list):
        return set()
    return {str(entry["id"]) for entry in entries if isinstance(entry, dict) and entry.get("id")}
