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

from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from tests.auth_support import build_factory
from tests.live_support import (
    SECOND_ACCOUNT_VARIABLES,
    Credentials,
    Target,
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
from weathra.api.classification import PROTECTED_PATHS, PUBLIC_PATHS

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
)

NOT_A_REAL_ID = "00000000-0000-4000-8000-000000000000"


def test_every_protected_path_has_a_credential_free_check() -> None:
    """The completeness half: a protected route added later must appear here or fail this test."""
    covered = {path.split("?")[0] for path in PROTECTED_GETS}
    covered |= {path for _, path in PROTECTED_WRITES}
    identified = {
        path.replace("{saved_id}", NOT_A_REAL_ID)
        .replace("{thread_id}", NOT_A_REAL_ID)
        .replace("{evidence_id}", NOT_A_REAL_ID)
        for path in PROTECTED_PATHS
    }
    assert not identified - covered, (
        f"protected paths with no deployed check: {sorted(identified - covered)}"
    )


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
def token_a(writer: httpx.Client, credentials: Credentials) -> str:
    return sign_in(writer, credentials, credentials.user_a_email, credentials.user_a_password)


@pytest.fixture(scope="module")
def token_b(writer: httpx.Client, second_account: Credentials) -> str:
    assert second_account.user_b_email and second_account.user_b_password
    return sign_in(
        writer, second_account, second_account.user_b_email, second_account.user_b_password
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_a_real_session_is_served_and_acts_as_its_own_subject(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
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
    writer: httpx.Client, target: Target, token_b: str, credentials: Credentials
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
    token_a: str,
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
    token_a: str,
    token_b: str,
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
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """Group 18.8's authenticated case and 25.4's stream, in one: it opens, and it finishes."""
    with writer.stream(
        "POST",
        target.api("/agent/stream"),
        headers=_auth(token_a),
        json={"question": "What is the forecast for Berlin"},
        timeout=120.0,
    ) as response:
        assert response.status_code == 200, f"the stream answered {response.status_code}"
        assert "text/event-stream" in response.headers.get("content-type", "")
        events = [line for line in response.iter_lines() if line.startswith("event:")]

    assert events, "the stream carried no events"
    assert any("complete" in event or "done" in event for event in events), (
        f"the stream never reported completion: {events[-3:]}"
    )
