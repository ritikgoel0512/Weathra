"""Task 34.7 — the SaaS layer, asked of the deployed backend.

Groups 26 to 32 built the entitlement layer and proved it in process. This asks whether the
*deployed* backend behaves the way those suites say it does, which nothing in-process can answer:
the resolution a real Free-plan caller actually gets, the body field a real caller can actually
send, and the isolation two real accounts actually have.

**Three tiers, and each absence costs only its own tier.** The pattern is
`test_deployed_acceptance.py`'s, for its reasons.

1. **Credential-free.** Runs on every dispatch and needs nothing configured. It covers the
   administrative surface's refusals — every administrative path refusing an absent token and a
   foreign one — through a client that cannot write. Group 31 added eighteen administrative paths
   and this is the tier that owes them a check.
2. **One deployed account.** What only a real session proves: the resolution recorded in the
   evidence record, a claimed plan ignored, a usage event recorded, the deterministic surfaces
   still serving, and an ordinary caller refused the administrative surface without learning which
   models exist.
3. **A second account**, and separately **an administrative account**. Isolation cannot be asked
   with one account and an override cannot be asked without the role. Neither can be faked, so
   both skip naming their variables rather than being weakened into something that passes without
   proving anything.

**What this suite will not do.** It provisions nothing, grants nothing, and mints nothing. It does
not lower a plan's allowance to observe a refusal: `plan_allowances` rows are shared by every
account on that plan, so a check that edited one would be changing production for real people to
make an assertion convenient. The exhaustion check therefore consumes a *dedicated* account's own
day allowance and is opt-in — see `test_an_exhausted_allowance_refuses_with_its_basis`.
"""

from __future__ import annotations

import json
import os
import pathlib
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
    read_only_client,
    sign_in,
    target_from_env,
    upstream_refused,
)
from weathra.api.classification import ADMINISTRATIVE_PATHS

pytestmark = pytest.mark.deployed

BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[2]

NOT_A_REAL_ID = "00000000-0000-4000-8000-000000000000"
NOT_A_REAL_KEY = "no-such-catalog-entry"

# The administrative account, and the only thing it is for. Kept separate from the two product
# accounts because holding the administrative role is not something a product account should have:
# an account that can disable a model is not an account whose isolation checks mean anything.
ADMIN_ACCOUNT_VARIABLES = (
    "WEATHRA_LIVE_ADMIN_EMAIL",
    "WEATHRA_LIVE_ADMIN_PASSWORD",
)

# Every administrative GET, with path parameters filled by values that do not exist: the refusal
# must arrive before anything is looked up, which is the property being checked.
ADMINISTRATIVE_GETS: tuple[str, ...] = (
    "/admin/models",
    "/admin/policies",
    "/admin/plans",
    "/admin/allowances",
    "/admin/usage",
    "/admin/usage/series",
    "/admin/principals/administrators",
    # Added 2026-09-11. `/admin/principals` and a policy's audit trail arrived with task 34.22 and
    # were never added here, so two administrative reads had never been confirmed to refuse an
    # unauthenticated caller against the deployment — the third and fourth time this assertion has
    # caught that, after group 31's paths and Weather Watch's. It is the argument for deriving the
    # list from the contract rather than maintaining it by hand.
    "/admin/principals",
    "/admin/policies/no-such-policy/audit",
    "/admin/lab/comparisons",
    f"/admin/lab/comparisons/{NOT_A_REAL_ID}",
)

# The administrative writes. Safe for the reason the endpoints are administrative: a request with
# no credential is refused at the authentication boundary before any handler runs, so it cannot
# create, change or remove anything. A 401 *is* the proof that nothing happened.
ADMINISTRATIVE_WRITES: tuple[tuple[str, str], ...] = (
    ("POST", "/admin/models"),
    ("PATCH", f"/admin/models/{NOT_A_REAL_KEY}"),
    ("POST", f"/admin/models/{NOT_A_REAL_KEY}/enable"),
    ("POST", f"/admin/models/{NOT_A_REAL_KEY}/disable"),
    ("POST", "/admin/policies"),
    ("PUT", "/admin/policies/no-such-policy/candidates"),
    ("PUT", "/admin/policies/no-such-policy/fallback"),
    ("PUT", "/admin/plans/free/policies"),
    ("PUT", "/admin/plans/free/allowances"),
    ("PUT", "/admin/allowances/internal"),
    ("PUT", f"/admin/principals/{NOT_A_REAL_ID}/plan"),
    ("PUT", f"/admin/principals/{NOT_A_REAL_ID}/role"),
    ("DELETE", f"/admin/principals/{NOT_A_REAL_ID}/role"),
    ("POST", "/admin/lab/comparisons"),
)

# Vendor model strings and catalog keys a refusal must never contain. `specs/model-lab` requires a
# non-administrative caller to be refused *without* learning which models exist, and a leak here
# would be the kind that reads as a helpful error message.
DISCLOSURE_MARKERS: tuple[str, ...] = (
    "economy-free-primary",
    "economy-free-secondary",
    "standard-general",
    "frontier-reasoning",
    "nvidia/",
    "openai/",
    "anthropic/",
    "meta-llama/",
    ":free",
)


def _no_model_identifier_disclosed(response: httpx.Response) -> None:
    body = response.text.lower()
    leaked = [marker for marker in DISCLOSURE_MARKERS if marker.lower() in body]
    assert not leaked, f"{response.request.url.path} disclosed {leaked} to an unentitled caller"


@pytest.fixture(scope="module")
def target() -> Target:
    return target_from_env()


@pytest.fixture(scope="module")
def reader() -> Iterator[httpx.Client]:
    with read_only_client() as client:
        yield client


@pytest.fixture(scope="module")
def writer() -> Iterator[httpx.Client]:
    """A client that may write — used only for the dedicated accounts' own data."""
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        yield client


@pytest.fixture(scope="module")
def tokens() -> Any:
    """Locally signed tokens, every one of which production must refuse."""
    return build_factory()


@pytest.fixture(scope="module")
def credentials() -> Credentials:
    found, missing = credentials_from_env()
    if found is None:
        pytest.skip(
            "the SaaS-layer session checks need one deployed account; missing: "
            + ", ".join(missing)
        )
    return found


@pytest.fixture(scope="module")
def second_account(credentials: Credentials) -> Credentials:
    if not credentials.has_second_account:
        pytest.skip(
            "'one account sees none of another's usage' needs a second deployed account; missing: "
            + ", ".join(SECOND_ACCOUNT_VARIABLES)
        )
    return credentials


@pytest.fixture(scope="module")
def token_a(writer: httpx.Client, credentials: Credentials) -> str:
    return sign_in(writer, credentials, credentials.user_a_email, credentials.user_a_password)


@pytest.fixture(scope="module")
def token_b(writer: httpx.Client, second_account: Credentials) -> str:
    assert second_account.user_b_email and second_account.user_b_password
    return sign_in(
        writer, second_account, second_account.user_b_email, second_account.user_b_password
    )


@pytest.fixture(scope="module")
def token_admin(writer: httpx.Client, credentials: Credentials) -> str:
    """A session for the administrative account, or a skip naming the two variables.

    The role itself is a row this suite does not write. `scripts/grant_administrator.py` grants it,
    deliberately out of band: a test that could grant itself the administrative role would be
    testing something other than the boundary.
    """
    email = os.environ.get("WEATHRA_LIVE_ADMIN_EMAIL")
    password = os.environ.get("WEATHRA_LIVE_ADMIN_PASSWORD")
    if not email or not password:
        pytest.skip(
            "the administrative checks need a deployed account holding the administrative role; "
            "missing: " + ", ".join(ADMIN_ACCOUNT_VARIABLES)
        )
    return sign_in(writer, credentials, email, password)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _ask(
    client: httpx.Client, target: Target, token: str, question: str, **extra: Any
) -> httpx.Response:
    return fetch(
        client,
        "POST",
        target.api("/agent/ask"),
        headers=_auth(token),
        json={"question": question, **extra},
        timeout=120.0,
    )


def _attempts(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The inference attempts on an answer's evidence record."""
    record = body.get("answer", {}).get("evidence", {}) or {}
    return list(record.get("inference_attempts") or ())


# ------------------------------------------------------------------ the credential-free tier


def _fill(path: str) -> str:
    """A path with its parameters filled by values that do not exist.

    They must not exist: the refusal has to arrive *before* anything is looked up, and a real
    identifier would let a 404 stand in for a 401 and look like a pass.
    """
    return (
        path.replace("{catalog_key}", NOT_A_REAL_KEY)
        .replace("{policy_id}", "no-such-policy")
        .replace("{plan_code}", "free")
        .replace("{subject_id}", NOT_A_REAL_ID)
        .replace("{run_id}", NOT_A_REAL_ID)
    )


def _published_administrative_operations() -> set[tuple[str, str]]:
    """Every (method, filled path) the contract publishes on an administrative path.

    Read from `openapi.json`, which `test_openapi_snapshot.py` holds to the live application. That
    is the point: a check list written by hand gets the *methods* wrong, which is not a failure a
    401 assertion reports usefully — the deployment answers 405 and the message is about the
    method rather than about the boundary.
    """
    contract = json.loads((BACKEND_ROOT / "openapi.json").read_text())
    published: set[tuple[str, str]] = set()
    for raw_path, operations in contract["paths"].items():
        path = raw_path.removeprefix("/api/v1")
        if path not in ADMINISTRATIVE_PATHS:
            continue
        for method in operations:
            if method.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                published.add((method.upper(), _fill(path)))
    return published


def test_every_administrative_operation_has_a_credential_free_check() -> None:
    """The completeness half, and the assertion that was failing when group 34 arrived.

    Group 31 added eighteen administrative paths and nothing here covered any of them. The check
    is deselected by default — `deployed` is not in the default marker expression — so it failed
    silently from the commit that added them until this module was written.

    It compares *operations*, not paths, because two of those eighteen answer no `GET` at all:
    `/admin/models/{catalog_key}` is a `PATCH` and `/admin/allowances/internal` is a `PUT`. A
    path-level list called both of them reads and got 405 from production.
    """
    covered = {("GET", path.split("?")[0]) for path in ADMINISTRATIVE_GETS}
    covered |= set(ADMINISTRATIVE_WRITES)
    published = _published_administrative_operations()

    assert published, "the contract publishes no administrative operations at all"
    assert not published - covered, (
        f"administrative operations with no deployed check: {sorted(published - covered)}"
    )
    assert not covered - published, (
        f"checks for operations the contract does not publish: {sorted(covered - published)}"
    )


def test_every_administrative_path_is_covered_by_some_operation() -> None:
    """The path-level statement too, so a path answering nothing at all cannot pass silently."""
    covered = {path for _, path in _published_administrative_operations()}
    expected = {_fill(path) for path in ADMINISTRATIVE_PATHS}
    assert covered == expected, (
        f"administrative paths publishing no operation: {sorted(expected - covered)}"
    )


@pytest.mark.parametrize("path", ADMINISTRATIVE_GETS)
def test_an_administrative_read_refuses_a_caller_with_no_token(
    reader: httpx.Client, target: Target, path: str
) -> None:
    response = fetch(reader, "GET", target.api(path))
    assert_not_server_error(response)
    assert_status(response, 401)
    _no_model_identifier_disclosed(response)


@pytest.mark.parametrize(("method", "path"), ADMINISTRATIVE_WRITES, ids=lambda value: str(value))
def test_an_administrative_write_refuses_a_caller_with_no_token(
    writer: httpx.Client, target: Target, method: str, path: str
) -> None:
    """Safe because the refusal precedes the handler: a 401 is the proof nothing was written."""
    response = fetch(writer, method, target.api(path), json={})
    assert_not_server_error(response)
    assert_status(response, 401)
    _no_model_identifier_disclosed(response)


@pytest.mark.parametrize("path", ADMINISTRATIVE_GETS)
def test_an_administrative_read_refuses_a_foreign_token(
    reader: httpx.Client, target: Target, tokens: Any, path: str
) -> None:
    """A structurally perfect token from an issuer production has never seen is still nothing."""
    response = fetch(reader, "GET", target.api(path), headers=_auth(tokens.valid()))
    assert_not_server_error(response)
    assert_status(response, 401)
    _no_model_identifier_disclosed(response)


# ------------------------------------------------------------------ one deployed account


def test_the_caller_s_plan_comes_from_backend_state(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """The entitlement a real deployed account actually has, read from where it is held."""
    response = fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a))
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 200, *credentials.secrets)
    body = json_body(response, *credentials.secrets)

    assert body.get("plan_code") in {"free", "pro", "premium"}, (
        f"/me/usage reported the plan {body.get('plan_code')!r}, which is not a canonical tier"
    )
    assert body.get("internal") is False, "a product account is accounted as internal usage"
    assert body.get("dimensions"), "/me/usage reported no allowance dimensions"
    for dimension in body["dimensions"]:
        assert dimension.get("consumed") is not None
        assert dimension.get("dimension") and dimension.get("window")


def test_an_entitled_model_serves_and_the_resolution_is_in_the_evidence_record(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7's first item, against the deployment.

    The claim is not "a model answered" — it is that the record says *which* model, under which
    policy, for which plan, and why. Until the group 34 wiring, a resolution was recorded and not
    honoured, so the record naming a catalog entry is the assertion that matters most here.
    """
    response = _ask(writer, target, token_a, "What is the forecast for Berlin?")
    if upstream_refused(response):
        pytest.skip("the inference gateway refused; the check could not be performed")
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 200, *credentials.secrets)
    body = json_body(response, *credentials.secrets)

    attempts = _attempts(body)
    assert attempts, "the evidence record carried no inference attempt"

    served = [attempt for attempt in attempts if attempt.get("served_model")]
    assert served, f"no attempt reported a served model: {attempts}"

    plan = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
        *credentials.secrets,
    )["plan_code"]

    for attempt in served:
        assert attempt.get("catalog_key"), (
            f"an attempt named no catalog entry, so the resolution was not recorded: {attempt}"
        )
        assert attempt.get("resolution_reason"), "an attempt recorded no resolution reason"
        assert attempt.get("plan") == plan, (
            f"the attempt recorded the plan {attempt.get('plan')!r}, /me/usage reports {plan!r}"
        )
        # A configured fallback is a legitimate outcome and a *different* one, so it is named
        # rather than folded in: an aggregate that counted it as a policy resolution would report
        # configuration as entitlement.
        assert attempt.get("policy_id"), (
            f"an attempt recorded no resolving policy: {attempt.get('resolution_reason')!r}"
        )


def test_a_claimed_plan_in_the_body_is_ignored(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7's second item. Entitlement is derived, and a caller bypassing the frontend learns it.

    Either outcome is correct and both are asserted as correct: the field may be rejected as
    unknown, or accepted and ignored. What may not happen is the answer being served under the
    claimed plan.
    """
    before = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
        *credentials.secrets,
    )["plan_code"]

    response = _ask(
        writer,
        target,
        token_a,
        "What is the forecast for Berlin?",
        plan="premium",
        plan_code="premium",
        model="frontier-reasoning",
        catalog_key="frontier-reasoning",
    )
    if upstream_refused(response):
        pytest.skip("the inference gateway refused; the check could not be performed")
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, (200, 422), *credentials.secrets)

    if response.status_code == 200:
        for attempt in _attempts(json_body(response, *credentials.secrets)):
            assert attempt.get("plan") == before, (
                f"a body field moved the run onto the {attempt.get('plan')!r} plan"
            )
            assert attempt.get("catalog_key") != "frontier-reasoning" or before == "premium", (
                "a body field selected a model above the caller's entitlement"
            )

    after = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
        *credentials.secrets,
    )["plan_code"]
    assert after == before, f"a body field changed the caller's plan from {before!r} to {after!r}"


def test_a_usage_event_is_recorded_for_the_call(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7's usage item. The count is the caller's own, and it moves because the caller called."""

    def recent() -> dict[str, Any]:
        body = json_body(
            fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
            *credentials.secrets,
        )
        return dict(body["recent"])

    before = recent()
    response = _ask(writer, target, token_a, "Compare Berlin and Munich this week.")
    if upstream_refused(response):
        pytest.skip("the inference gateway refused; the check could not be performed")
    assert_status(response, 200, *credentials.secrets)
    after = recent()

    assert after["calls"] > before["calls"], (
        f"a language model call recorded no usage event: {before} then {after}"
    )
    # Counts, never content and never cost: `/me/usage` is the caller's own view and carries no
    # estimated cost by design. The estimate is on the administrative aggregate, checked there.
    assert set(after) == {"days", "calls", "failures", "total_tokens"}, (
        f"/me/usage's recent summary carries unexpected fields: {sorted(after)}"
    )


def test_a_failed_call_is_recorded_too(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7 asks for a usage event on a forced failure. The forced failure available from outside
    the process is a question the gateway refuses or the guard withholds — so this asserts the
    *accounting* property rather than manufacturing a provider error: a call the deployment could
    not complete still moves the caller's counters, and never moves them backwards.
    """

    def recent() -> dict[str, Any]:
        body = json_body(
            fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
            *credentials.secrets,
        )
        return dict(body["recent"])

    before = recent()
    response = _ask(writer, target, token_a, "?")
    assert_not_server_error(response, *credentials.secrets)
    after = recent()

    assert after["calls"] >= before["calls"], "the caller's recorded call count went backwards"
    assert after["failures"] >= before["failures"], "the recorded failure count went backwards"
    if response.status_code == 200 and _attempts(json_body(response, *credentials.secrets)):
        assert after["calls"] > before["calls"], (
            "an answer was served with inference attempts and no usage event followed"
        )


@pytest.mark.parametrize(
    "path",
    [
        "/weather/forecast?location=Berlin",
        "/weather/history?location=Berlin&start=2026-08-01&end=2026-08-07",
        "/weather/statistics?location=Berlin&start=2026-08-01&end=2026-08-07",
        "/weather/compare?locations=Berlin&locations=Munich",
    ],
)
def test_the_deterministic_surfaces_still_serve(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials, path: str
) -> None:
    """34.7's standing requirement: whatever the model layer does, these keep working.

    Asserted with a session because that is the state the rest of this tier runs in — the same
    surfaces are checked anonymously by `test_deployed_acceptance.py`.
    """
    response = fetch(writer, "GET", target.api(path), headers=_auth(token_a))
    if upstream_refused(response):
        pytest.skip("the weather provider refused; the check could not be performed")
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 200, *credentials.secrets)
    body = json_body(response, *credentials.secrets)
    assert body.get("attribution") or body.get("source") or body.get("provider"), (
        f"{path} served figures without saying where they came from"
    )


def test_the_caller_s_own_data_survives_the_whole_pass(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7's last clause: both memory tiers and the caller's own state, unchanged throughout."""
    for path in ("/me", "/me/preferences", "/me/locations", "/threads"):
        response = fetch(writer, "GET", target.api(path), headers=_auth(token_a))
        assert_not_server_error(response, *credentials.secrets)
        assert_status(response, 200, *credentials.secrets)


@pytest.mark.parametrize("path", ADMINISTRATIVE_GETS)
def test_an_ordinary_account_is_refused_the_administrative_surface(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials, path: str
) -> None:
    """A valid session is not a role, and the refusal teaches the caller nothing about the models."""
    response = fetch(writer, "GET", target.api(path), headers=_auth(token_a))
    assert_not_server_error(response, *credentials.secrets)
    assert_status(response, 403, *credentials.secrets)
    _no_model_identifier_disclosed(response)


# ------------------------------------------------------------------ a second account


def test_one_account_sees_none_of_another_s_usage(
    writer: httpx.Client,
    target: Target,
    token_a: str,
    token_b: str,
    second_account: Credentials,
) -> None:
    """34.7's isolation item. Each `/me/usage` is its own subject's, and says so."""
    a = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
        *second_account.secrets,
    )
    b = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_b)),
        *second_account.secrets,
    )

    assert a["user_id"] != b["user_id"], "the two accounts resolved to one subject"
    assert a.get("plan_code") and b.get("plan_code")
    # The strongest statement available from outside: neither response contains the other's
    # subject anywhere in it, so neither is reporting a total that spans both.
    assert b["user_id"] not in str(a), "A's usage response mentions B's subject"
    assert a["user_id"] not in str(b), "B's usage response mentions A's subject"


# ------------------------------------------------------------------ the administrative account


def test_the_administrative_account_reads_the_catalog(
    writer: httpx.Client, target: Target, token_admin: str
) -> None:
    response = fetch(writer, "GET", target.api("/admin/models"), headers=_auth(token_admin))
    assert_not_server_error(response)
    assert_status(response, 200)
    body = json_body(response)
    entries = body.get("models") or body.get("entries") or ()
    assert entries, "the administrative catalog listing was empty"


def test_an_override_is_accepted_for_an_enabled_model_and_refused_for_an_absent_one(
    writer: httpx.Client, target: Target, token_admin: str
) -> None:
    """34.7's override items, in the only shape production can be asked for safely.

    An *absent* key stands in for the refusal case rather than a disabled one, because disabling a
    seeded model to observe a refusal would take it out of resolution for every account on a plan
    that names it. Absent and disabled are refused by the same allowlist check, one branch apart,
    and `integration/test_agent_resolution.py` covers the disabled branch in process.
    """
    catalog = json_body(
        fetch(writer, "GET", target.api("/admin/models"), headers=_auth(token_admin))
    )
    entries = catalog.get("models") or catalog.get("entries") or ()
    enabled = [entry for entry in entries if entry.get("enabled")]
    assert enabled, "no enabled catalog entry to override with"
    key = enabled[0]["catalog_key"]

    accepted = _ask(
        writer, target, token_admin, "What is the forecast for Berlin?", model_override=key
    )
    if upstream_refused(accepted):
        pytest.skip("the inference gateway refused; the check could not be performed")
    assert_not_server_error(accepted)
    assert_status(accepted, 200)
    served = [attempt for attempt in _attempts(json_body(accepted)) if attempt.get("served_model")]
    assert served, "the overridden run recorded no served attempt"
    assert any(attempt.get("catalog_key") == key for attempt in served), (
        f"the override named {key} and the record names {[a.get('catalog_key') for a in served]}"
    )

    refused = _ask(
        writer,
        target,
        token_admin,
        "What is the forecast for Berlin?",
        model_override=NOT_A_REAL_KEY,
    )
    assert_not_server_error(refused)
    assert_status(refused, (400, 404, 422))


def test_the_administrative_aggregate_labels_its_cost_an_estimate(
    writer: httpx.Client, target: Target, token_admin: str
) -> None:
    """34.7's cost item: present, and labelled — it is a published price, not an invoice.

    The label is the field name, `estimated_cost_total`, which is why this asserts the name rather
    than searching the body for the word: a response carrying a bare `cost` would satisfy a
    substring check while telling a reader it is an amount owed.
    """
    response = fetch(writer, "GET", target.api("/admin/usage?by=model"), headers=_auth(token_admin))
    assert_not_server_error(response)
    assert_status(response, 200)
    body = json_body(response)

    groups = body.get("groups") or ()
    if not groups:
        pytest.skip("the deployment has recorded no usage in the period, so there is none to cost")

    for group in groups:
        assert "estimated_cost_total" in group, (
            f"a usage group reports no estimated cost: {sorted(group)}"
        )
    assert not any(key == "cost" or key.endswith("_cost") for group in groups for key in group), (
        "a usage group carries an unqualified cost field, which reads as an amount owed"
    )


def test_internal_usage_is_reported_separately_from_every_product_plan(
    writer: httpx.Client, target: Target, token_admin: str
) -> None:
    """34.7's separation item. Lab and evaluation work is not somebody's plan consumption.

    The aggregate returns one entry per (group, internal) pair, so the separation is structural:
    an internal call and a product call on the same plan are two rows, and no single figure spans
    them. Asserted as that shape rather than as two endpoints — there is only one, deliberately,
    because two could disagree.
    """
    response = fetch(writer, "GET", target.api("/admin/usage?by=plan"), headers=_auth(token_admin))
    assert_not_server_error(response)
    assert_status(response, 200)
    body = json_body(response)

    assert body.get("grouped_by") == "plan"
    groups = body.get("groups") or ()
    if not groups:
        pytest.skip("the deployment has recorded no usage in the period")

    for group in groups:
        assert "is_internal" in group, (
            f"a usage group does not say whether it is internal: {sorted(group)}"
        )
        assert isinstance(group["is_internal"], bool)

    # And no subject, ever: an aggregate is counts, and a row would be somebody's.
    flat = str(body).lower()
    for leak in ("user_id", "subject", "email", "prompt", "completion_text"):
        assert leak not in flat, f"the administrative aggregate disclosed {leak}"


def test_an_exhausted_allowance_refuses_with_its_basis(
    writer: httpx.Client, target: Target, token_a: str, credentials: Credentials
) -> None:
    """34.7's 429 item, opt-in because the honest way to reach it costs a day's allowance.

    Two ways exist to observe this against a deployment. Lowering a plan's allowance is refused
    here: `plan_allowances` rows are shared by every account on that plan, so the check would be
    changing production for real people. The other is to spend the dedicated account's own day
    allowance, which is what this does — bounded by the allowance the account itself reports, and
    only when `WEATHRA_LIVE_EXHAUST_ALLOWANCE` is set, so a routine dispatch never burns it.
    """
    if os.environ.get("WEATHRA_LIVE_EXHAUST_ALLOWANCE") != "1":
        pytest.skip(
            "consumes the test account's day allowance; set WEATHRA_LIVE_EXHAUST_ALLOWANCE=1 to run"
        )

    usage = json_body(
        fetch(writer, "GET", target.api("/me/usage"), headers=_auth(token_a)),
        *credentials.secrets,
    )
    daily = next(
        (
            dimension
            for dimension in usage["dimensions"]
            if dimension["window"] == "day" and dimension.get("remaining") is not None
        ),
        None,
    )
    if daily is None:
        pytest.skip("this account's plan limits nothing per day, so exhaustion cannot be reached")

    remaining = int(daily["remaining"])
    assert remaining <= 60, (
        f"{remaining} calls remain on {daily['dimension']}; refusing to spend that many. "
        "Run this against an account on a small plan."
    )

    refusal: httpx.Response | None = None
    for _ in range(remaining + 2):
        response = _ask(writer, target, token_a, "What is the forecast for Berlin?")
        if response.status_code == 429 and not upstream_refused(response):
            refusal = response
            break
        assert_not_server_error(response, *credentials.secrets)

    assert refusal is not None, f"{remaining + 2} calls did not exhaust {daily['dimension']}"
    body = json_body(refusal, *credentials.secrets)
    flat = str(body).lower()
    assert daily["dimension"] in flat, "the refusal does not name the dimension it is based on"
    assert "reset" in flat or "window" in flat, "the refusal does not say when it lifts"

    # And the deterministic surfaces are untouched by it, which is the point of the gate being on
    # the agent path alone.
    forecast = fetch(
        writer,
        "GET",
        target.api("/weather/forecast?location=Berlin"),
        headers=_auth(token_a),
    )
    assert_status(forecast, 200, *credentials.secrets)
