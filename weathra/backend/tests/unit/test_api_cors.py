"""Task 23.5 — the allow-list the browser is actually held to, at the layer that enforces it.

`test_config.py` covers how `CORS_ALLOWED_ORIGINS` is *parsed*: comma-separated, stripped, no
wildcard. What is asserted here is what the running application then does with the result, because
that is where three days of this task were spent and none of it was a parsing bug.

Two properties, and both are about how unforgiving the match is:

1. **Exact.** Starlette compares the browser's `Origin` header against the configured list as
   strings. A trailing slash, a capital letter in the host, or `http` where the browser sent
   `https` is not a near-miss — it is an entry that authorises nothing, while looking correct in a
   dashboard. Every one of those spellings was a real candidate while diagnosing why production
   refused the frontend, and `.github/scripts/render_allowed_origin.py` refuses to treat any of
   them as "already allowed" for exactly this reason.
2. **Read once, at start-up.** `build_app` reads the setting while constructing the application, so
   the allow-list belongs to the process. That is why saving a variable in Render does not change a
   running service, and why activating one takes a deploy rather than a restart — the fact the
   first attempt at this operation was built on the opposite assumption.

Offline: `build_app` with settings passed in, and no network, database or credential involved.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from weathra.api.app import build_app
from weathra.config import Settings

PRODUCTION_ORIGIN = "https://weathra-bice.vercel.app"


def _client(origins: str) -> TestClient:
    settings = Settings(supabase_url="https://project.supabase.co", cors_allowed_origins=origins)
    return TestClient(build_app(settings))


def _preflight(client: TestClient, origin: str) -> tuple[int, str | None]:
    response = client.options(
        "/api/v1/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    return response.status_code, response.headers.get("access-control-allow-origin")


def test_a_configured_origin_is_allowed() -> None:
    status, allowed = _preflight(_client(PRODUCTION_ORIGIN), PRODUCTION_ORIGIN)
    assert status == 200
    assert allowed == PRODUCTION_ORIGIN


def test_each_configured_origin_is_allowed_independently() -> None:
    client = _client(f"http://localhost:3000, {PRODUCTION_ORIGIN}")
    for origin in ("http://localhost:3000", PRODUCTION_ORIGIN):
        status, allowed = _preflight(client, origin)
        assert (status, allowed) == (200, origin)


def test_an_unconfigured_origin_is_refused_with_no_allow_header() -> None:
    """The shape of the refusal matters: it is how a missing origin is diagnosed from outside.

    Starlette answers a disallowed origin with 400 and omits `Access-Control-Allow-Origin`
    entirely, while still sending the allow-methods and allow-headers it would have sent. So the
    presence of that one header — not the status, and not the other CORS headers — is the only
    reliable signal that an origin is allowed.
    """
    status, allowed = _preflight(_client("http://localhost:3000"), PRODUCTION_ORIGIN)
    assert status == 400
    assert allowed is None


@pytest.mark.parametrize(
    ("configured", "shape"),
    [
        (f"{PRODUCTION_ORIGIN}/", "a trailing slash"),
        ("https://WEATHRA-BICE.vercel.app", "a capitalised host"),
        ("http://weathra-bice.vercel.app", "the wrong scheme"),
    ],
)
def test_an_entry_that_only_looks_right_authorises_nothing(configured: str, shape: str) -> None:
    """Each of these reads as correct in a dashboard and allows no browser through.

    A browser sends its origin with the scheme and host lower-cased and no trailing slash, and the
    comparison is exact, so none of these entries can ever match. This is the test that says why
    the release tooling may normalise surrounding whitespace when deciding whether an origin is
    already configured — and nothing else.
    """
    status, allowed = _preflight(_client(configured), PRODUCTION_ORIGIN)
    assert allowed is None, f"{shape} unexpectedly authorised the browser's origin"
    assert status == 400


def test_the_allow_list_belongs_to_the_process() -> None:
    """Two apps, two allow-lists, from the settings each was built with.

    The point is not that `build_app` takes an argument. It is that the value is captured when the
    application is constructed, so a change to the environment reaches production only in a new
    process — which is why Render's restart, documented to reuse "the exact same Git commit and
    configuration", cannot activate a saved variable, and a deploy is required.
    """
    before = _client("http://localhost:3000")
    after = _client(f"http://localhost:3000,{PRODUCTION_ORIGIN}")
    assert _preflight(before, PRODUCTION_ORIGIN)[1] is None
    assert _preflight(after, PRODUCTION_ORIGIN)[1] == PRODUCTION_ORIGIN
