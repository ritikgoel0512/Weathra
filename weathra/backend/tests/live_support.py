"""The deployed pair, probed from outside — tasks 25.3 and 25.4.

Groups 1-24 test Weathra as code. These two tasks ask a different question: does the *deployed*
pair behave the way the suites say the code does? Nothing about that can be answered in-process,
so this module is the small amount of machinery a suite pointed at production needs, and the
properties worth being careful about live here rather than in the assertions:

* **The read-only tier cannot write.** `read_only_client` refuses any method that is not GET,
  HEAD or OPTIONS *before* it reaches the network, so a test added later cannot quietly start
  creating rows in somebody's account to make an assertion pass. A preflight is an OPTIONS, so
  CORS is checkable without an exception.
* **Nothing is fabricated.** The rejection cases mint their own tokens with a key the deployed
  backend has never seen, which is the point: they must be *refused*. There is no path here that
  produces a token the backend would accept — an authenticated case signs in as a real account
  with a real password over Supabase's public endpoint, or it skips.
* **Credentials are absent by default.** The authenticated tier reports the exact secret names it
  needs and skips when they are missing, so a run with no credentials still verifies everything
  that does not need them instead of failing wholesale.
* **Nothing sensitive is printed.** `redact` is applied to anything that could carry a token, and
  it is applied to failure text as well, because a failed assertion is where a bearer token would
  otherwise be echoed into a public log.
"""

from __future__ import annotations

import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import httpx

# The deployed pair. Overridable so a staging pair can be checked with the same suite, but these
# are the addresses task 25.4 names, and the defaults are what an unconfigured run checks.
DEFAULT_FRONTEND = "https://weathra-bice.vercel.app"
DEFAULT_BACKEND = "https://weathra-backend.onrender.com"

# Enough for a cold start on the backend's instance type, and bounded so a hung production never
# hangs the run: a timeout is a result, not a reason to wait.
TIMEOUT_SECONDS = 30.0

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# What one signed-in account needs: the project, its public client key, and the account. Signing in
# is done the way the browser does it — Supabase's password grant — rather than by minting anything.
CREDENTIAL_VARIABLES = (
    "WEATHRA_LIVE_SUPABASE_URL",
    "WEATHRA_LIVE_SUPABASE_ANON_KEY",
    "WEATHRA_LIVE_USER_A_EMAIL",
    "WEATHRA_LIVE_USER_A_PASSWORD",
)

# A second account, and the only thing it is for: "user A cannot see user B's data" cannot be asked
# with one account, and it cannot be faked. Kept separate from the set above so that having no
# second account costs only the isolation checks — one account is enough to prove a real session is
# served, a question is answered with its evidence, and a stream completes.
SECOND_ACCOUNT_VARIABLES = (
    "WEATHRA_LIVE_USER_B_EMAIL",
    "WEATHRA_LIVE_USER_B_PASSWORD",
)


class LiveCheckError(AssertionError):
    """A deployed-pair check that could not be completed. An `AssertionError` so pytest reports it."""


@dataclass(frozen=True)
class Target:
    """Where the deployed pair lives, normalised."""

    frontend: str
    backend: str

    def api(self, path: str) -> str:
        return f"{self.backend}/api/v1{path}"

    def page(self, path: str) -> str:
        return f"{self.frontend}{path}"


def normalise(url: str, *, name: str) -> str:
    """A base URL with no trailing slash, over HTTPS, or a refusal naming what was wrong.

    HTTPS is required rather than preferred: a check that silently accepted `http://` would be
    verifying a production surface over a channel production does not use, and any bearer token
    the authenticated tier carries would travel in clear.
    """
    trimmed = url.strip().rstrip("/")
    if not trimmed:
        raise LiveCheckError(f"{name} is empty")
    if not trimmed.startswith("https://"):
        raise LiveCheckError(f"{name} is not an https:// URL")
    if " " in trimmed:
        raise LiveCheckError(f"{name} contains whitespace")
    return trimmed


def target_from_env(environment: Mapping[str, str] | None = None) -> Target:
    source = environment if environment is not None else os.environ
    return Target(
        frontend=normalise(
            source.get("WEATHRA_LIVE_FRONTEND_URL") or DEFAULT_FRONTEND,
            name="WEATHRA_LIVE_FRONTEND_URL",
        ),
        backend=normalise(
            source.get("WEATHRA_LIVE_BACKEND_URL") or DEFAULT_BACKEND,
            name="WEATHRA_LIVE_BACKEND_URL",
        ),
    )


@dataclass(frozen=True)
class Credentials:
    """One deployed account, and optionally a second, with the public configuration to sign in."""

    supabase_url: str
    anon_key: str
    user_a_email: str
    user_a_password: str
    user_b_email: str | None = None
    user_b_password: str | None = None

    @property
    def has_second_account(self) -> bool:
        return bool(self.user_b_email and self.user_b_password)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Everything that must never appear in output."""
        return tuple(
            value for value in (self.anon_key, self.user_a_password, self.user_b_password) if value
        )


def credentials_from_env(
    environment: Mapping[str, str] | None = None,
) -> tuple[Credentials | None, tuple[str, ...]]:
    """The credentials, and the names of anything missing.

    Two different absences, reported differently, because they cost different things:

    * without the four in `CREDENTIAL_VARIABLES` there is no session at all, so `None` comes back
      with their names and every authenticated check skips;
    * without the two in `SECOND_ACCOUNT_VARIABLES` there is a session but no second subject, so
      the credentials come back *with* those names listed — only the isolation checks skip, and
      everything one account can prove still runs.

    The second case is the one worth being careful about. Treating a missing second account as "no
    credentials" would skip checks a single account can prove; treating it as "isolation passes"
    would report the property those checks exist to prove without having asked. It does neither.
    """
    source = environment if environment is not None else os.environ
    present = {
        name: (source.get(name) or "").strip()
        for name in (*CREDENTIAL_VARIABLES, *SECOND_ACCOUNT_VARIABLES)
    }
    missing = tuple(name for name in CREDENTIAL_VARIABLES if not present[name])
    if missing:
        return None, missing

    second = tuple(name for name in SECOND_ACCOUNT_VARIABLES if not present[name])
    return (
        Credentials(
            supabase_url=normalise(
                present["WEATHRA_LIVE_SUPABASE_URL"], name="WEATHRA_LIVE_SUPABASE_URL"
            ),
            anon_key=present["WEATHRA_LIVE_SUPABASE_ANON_KEY"],
            user_a_email=present["WEATHRA_LIVE_USER_A_EMAIL"],
            user_a_password=present["WEATHRA_LIVE_USER_A_PASSWORD"],
            user_b_email=present["WEATHRA_LIVE_USER_B_EMAIL"] or None,
            user_b_password=present["WEATHRA_LIVE_USER_B_PASSWORD"] or None,
        ),
        second,
    )


def redact(text: str, *secrets: str) -> str:
    """Remove anything that could carry a credential, longest first so no substring survives."""
    for secret in sorted(
        {value for value in secrets if value and len(value) > 7}, key=len, reverse=True
    ):
        text = text.replace(secret, "«redacted»")
    return text


class ReadOnlyViolation(LiveCheckError):
    """A write was attempted by a client that exists in order to be incapable of one."""


@contextmanager
def read_only_client(*, transport: httpx.BaseTransport | None = None) -> Iterator[httpx.Client]:
    """An HTTP client that refuses to write, before anything reaches the network.

    The guarantee task 25.4 needs is that a smoke check cannot create rows in a real person's
    account. Asserting that in review is not the same as making it impossible, so this is a
    transport-level refusal: GET, HEAD and OPTIONS pass, and everything else raises without a
    request being sent.
    """

    class Guard(httpx.BaseTransport):
        def __init__(self, inner: httpx.BaseTransport) -> None:
            self._inner = inner

        def handle_request(self, request: httpx.Request) -> httpx.Response:
            if request.method.upper() not in SAFE_METHODS:
                raise ReadOnlyViolation(
                    f"the read-only checks may not {request.method} anything; "
                    f"{request.url.path} was not requested"
                )
            return self._inner.handle_request(request)

    inner = transport if transport is not None else httpx.HTTPTransport(retries=1)
    with httpx.Client(
        transport=Guard(inner), timeout=TIMEOUT_SECONDS, follow_redirects=False
    ) as client:
        yield client


def fetch(client: httpx.Client, method: str, url: str, **kwargs: Any) -> httpx.Response:
    """One request, with a transport failure reported as a check failure rather than a traceback.

    A production surface that cannot be reached at all is a result this suite must report clearly:
    "the deployment is unreachable" and "the deployment answered wrongly" are different findings.
    """
    try:
        return client.request(method, url, **kwargs)
    except httpx.TimeoutException as timeout:
        raise LiveCheckError(f"{method} {url} timed out after {TIMEOUT_SECONDS:.0f}s") from timeout
    except httpx.HTTPError as failure:
        raise LiveCheckError(
            f"{method} {url} could not be reached: {type(failure).__name__}"
        ) from failure


def assert_not_server_error(response: httpx.Response, *secrets: str) -> None:
    """No 5xx on any surface this suite touches. The first thing worth knowing, and the cheapest."""
    if response.status_code >= 500:
        raise LiveCheckError(
            f"{response.request.method} {response.request.url.path} answered "
            f"{response.status_code}: {redact(response.text[:200], *secrets)}"
        )


def assert_status(response: httpx.Response, expected: int | tuple[int, ...], *secrets: str) -> None:
    allowed = (expected,) if isinstance(expected, int) else expected
    if response.status_code not in allowed:
        raise LiveCheckError(
            f"{response.request.method} {response.request.url.path} answered "
            f"{response.status_code}, expected {' or '.join(str(code) for code in allowed)}: "
            f"{redact(response.text[:200], *secrets)}"
        )


def redirect_target(response: httpx.Response) -> str:
    """Where a redirect points, or a refusal. Never followed: where it points is the assertion."""
    if response.status_code not in (301, 302, 303, 307, 308):
        raise LiveCheckError(
            f"{response.request.url.path} answered {response.status_code}, not a redirect"
        )
    location: str | None = response.headers.get("location")
    if not location:
        raise LiveCheckError(f"{response.request.url.path} redirected with no Location header")
    return location


def preflight(client: httpx.Client, url: str, origin: str, *, method: str = "GET") -> str | None:
    """The `Access-Control-Allow-Origin` a browser would be given for this origin, or `None`.

    `None` is the refusal a disallowed origin gets: the middleware answers without the header at
    all, so its presence — and its agreement with the origin asked about — is the whole signal.
    """
    response = fetch(
        client,
        "OPTIONS",
        url,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization",
        },
    )
    allowed: str | None = response.headers.get("access-control-allow-origin")
    if not allowed:
        return None
    return allowed.strip().rstrip("/")


def error_code(response: httpx.Response) -> str | None:
    """The `error.code` a refusal carries, or `None` when the body is not one."""
    try:
        parsed = response.json()
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    code = (parsed.get("error") or {}).get("code")
    return str(code) if code else None


def upstream_refused(response: httpx.Response) -> bool:
    """Whether the *provider* refused, rather than Weathra.

    A 429 carrying `provider_rate_limited` is Weathra reporting an upstream limit correctly — the
    documented behaviour, not a defect. It is also not evidence that the surface works, so a check
    that hit it has to say "could not be performed" rather than pass or fail. Running this suite
    repeatedly is enough to provoke it on a free provider tier, which is worth knowing before
    reading a red run as a broken deployment.
    """
    return response.status_code == 429 and error_code(response) == "provider_rate_limited"


def json_body(response: httpx.Response, *secrets: str) -> dict[str, Any]:
    """The response as an object, or a refusal naming what arrived instead.

    A production surface that answers 200 with something that is not the documented shape is a
    failure this suite must catch rather than raise `JSONDecodeError` over.
    """
    try:
        parsed = response.json()
    except ValueError as failure:
        raise LiveCheckError(
            f"{response.request.url.path} answered {response.status_code} with a body that is not "
            f"JSON: {redact(response.text[:200], *secrets)}"
        ) from failure
    if not isinstance(parsed, dict):
        raise LiveCheckError(
            f"{response.request.url.path} answered with {type(parsed).__name__}, not an object"
        )
    return parsed


def sign_in(client: httpx.Client, credentials: Credentials, email: str, password: str) -> str:
    """A bearer token for a real deployed account, obtained the way the browser obtains one.

    Supabase's password grant with the public client key — no service-role key, nothing minted, no
    account provisioned. If this fails, the authenticated tier fails: there is deliberately no
    fallback that produces a token the backend would accept some other way.
    """
    response = fetch(
        client,
        "POST",
        f"{credentials.supabase_url}/auth/v1/token?grant_type=password",
        headers={"apikey": credentials.anon_key, "Content-Type": "application/json"},
        json={"email": email, "password": password},
    )
    if response.status_code != 200:
        raise LiveCheckError(
            f"signing in as the live test account failed with {response.status_code}; the account "
            "may not exist, may not be confirmed, or its password may have changed"
        )
        # The body is deliberately not reported: it carries the account's identity.
    token = json_body(response, *credentials.secrets).get("access_token")
    if not isinstance(token, str) or not token:
        raise LiveCheckError("the identity provider returned no access token")
    return token
