"""The deployed-acceptance harness, tested without a deployment — tasks 25.3 and 25.4.

The suite this supports runs against production, which means its bugs are expensive in a way most
test bugs are not: a check that passes because it asked the wrong URL reports a healthy deployment
that was never examined, and a check that writes reaches somebody's real account. So the machinery
is tested here, offline, against a transport that answers from memory.

Four properties carry the weight:

* **The read-only client cannot write.** Not "does not" — cannot. The refusal happens in the
  transport, before a request is sent, so a check added later that tried to POST fails loudly in
  CI rather than quietly creating a row in production.
* **A failure is a result, not a traceback.** A timeout, an unreachable host and a body that is
  not JSON each become a clear `LiveCheckError` naming the request, because "production could not
  be reached" and "production answered wrongly" are different findings and both need to survive
  into a log.
* **Nothing sensitive is printed.** `redact` is applied to failure text, which is exactly where a
  bearer token would otherwise end up in a public Actions log.
* **Missing credentials skip rather than pass.** Half a credential set is treated as none: a run
  that signed in as one account and skipped the isolation checks would report a pass for the one
  property those checks exist to prove.
"""

from __future__ import annotations

import httpx
import pytest

from tests.live_support import (
    CREDENTIAL_VARIABLES,
    DEFAULT_BACKEND,
    DEFAULT_FRONTEND,
    SECOND_ACCOUNT_VARIABLES,
    LiveCheckError,
    ReadOnlyViolation,
    Token,
    assert_not_server_error,
    assert_status,
    credentials_from_env,
    fetch,
    json_body,
    normalise,
    preflight,
    read_only_client,
    redact,
    redirect_target,
    sign_in,
    target_from_env,
)

CREDENTIALS = {
    "WEATHRA_LIVE_SUPABASE_URL": "https://project.supabase.co",
    "WEATHRA_LIVE_SUPABASE_ANON_KEY": "a-public-client-key-long-enough",
    "WEATHRA_LIVE_USER_A_EMAIL": "a@weathra.test",
    "WEATHRA_LIVE_USER_A_PASSWORD": "password-for-account-a",
    "WEATHRA_LIVE_USER_B_EMAIL": "b@weathra.test",
    "WEATHRA_LIVE_USER_B_PASSWORD": "password-for-account-b",
}


def _transport(handler: object) -> httpx.MockTransport:
    return httpx.MockTransport(handler)  # type: ignore[arg-type]


# ------------------------------------------------------------------ the targets


def test_the_defaults_are_the_deployed_pair() -> None:
    """The addresses task 25.4 names, so an unconfigured run checks production rather than nothing."""
    target = target_from_env({})
    assert target.frontend == DEFAULT_FRONTEND == "https://weathra-bice.vercel.app"
    assert target.backend == DEFAULT_BACKEND == "https://weathra-backend.onrender.com"
    assert target.api("/health") == "https://weathra-backend.onrender.com/api/v1/health"
    assert target.page("/sign-in") == "https://weathra-bice.vercel.app/sign-in"


def test_a_configured_target_is_normalised() -> None:
    target = target_from_env(
        {
            "WEATHRA_LIVE_FRONTEND_URL": "https://staging.example/ ",
            "WEATHRA_LIVE_BACKEND_URL": "https://api.staging.example",
        }
    )
    assert target.frontend == "https://staging.example"
    assert target.api("/ready") == "https://api.staging.example/api/v1/ready"


@pytest.mark.parametrize(
    "value",
    ["", "  ", "http://weathra-bice.vercel.app", "weathra-bice.vercel.app", "https://a b.example"],
)
def test_a_target_that_is_not_a_canonical_https_url_is_refused(value: str) -> None:
    """`http://` is refused rather than upgraded: a bearer token must not travel in clear, and a
    check that quietly accepted plain HTTP would be verifying a surface production does not use."""
    with pytest.raises(LiveCheckError):
        normalise(value, name="WEATHRA_LIVE_FRONTEND_URL")


# ------------------------------------------------------------------ the read-only guarantee


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_the_read_only_client_allows_safe_methods(method: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    with read_only_client(transport=_transport(handler)) as client:
        assert fetch(client, method, "https://weathra.test/x").status_code == 200


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_the_read_only_client_cannot_write(method: str) -> None:
    """The guarantee task 25.4 needs, enforced rather than reviewed.

    A smoke check must not be able to create rows in a real person's account, so this refusal
    happens in the transport — no request is sent, and the error names the method.
    """
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.method)
        return httpx.Response(200)

    with (
        read_only_client(transport=_transport(handler)) as client,
        pytest.raises(ReadOnlyViolation, match=method),
    ):
        client.request(method, "https://weathra.test/me/locations", json={})
    assert sent == [], "a write reached the transport"


def test_the_read_only_client_does_not_follow_redirects() -> None:
    """Where a redirect points *is* the assertion, so following it would discard the evidence."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(307, headers={"location": "/sign-in?next=%2Fdashboard"})

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/dashboard")
    assert response.status_code == 307
    assert redirect_target(response) == "/sign-in?next=%2Fdashboard"


# ------------------------------------------------------------------ failures as results


def test_a_timeout_is_reported_as_a_check_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    with (
        read_only_client(transport=_transport(handler)) as client,
        pytest.raises(LiveCheckError, match="timed out"),
    ):
        fetch(client, "GET", "https://weathra.test/api/v1/ready")


def test_an_unreachable_host_is_reported_as_a_check_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    with (
        read_only_client(transport=_transport(handler)) as client,
        pytest.raises(LiveCheckError, match="could not be reached"),
    ):
        fetch(client, "GET", "https://weathra.test/api/v1/ready")


def test_a_server_error_fails_the_check_and_names_the_path() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="upstream gone")

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/api/v1/health")
    with pytest.raises(LiveCheckError, match="502"):
        assert_not_server_error(response)


def test_an_expected_refusal_is_not_a_failure() -> None:
    """401 and 403 are results this suite asserts, not errors it trips over."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "unauthenticated"}})

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/api/v1/me")
    assert_not_server_error(response)
    assert_status(response, 401)
    with pytest.raises(LiveCheckError, match="expected 200"):
        assert_status(response, 200)


def test_a_body_that_is_not_the_documented_shape_fails_closed() -> None:
    """A 200 carrying HTML is a failure to report, not a `JSONDecodeError` to raise."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>a gateway page</html>")

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/api/v1/ready")
    with pytest.raises(LiveCheckError, match=r"not\s+JSON"):
        json_body(response)


def test_a_json_body_that_is_not_an_object_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/api/v1/ready")
    with pytest.raises(LiveCheckError, match="not an object"):
        json_body(response)


def test_a_non_redirect_is_refused_by_the_redirect_helper() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="rendered")

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/dashboard")
    with pytest.raises(LiveCheckError, match="not a redirect"):
        redirect_target(response)


def test_a_redirect_with_no_location_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(307)

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/dashboard")
    with pytest.raises(LiveCheckError, match="no Location"):
        redirect_target(response)


# ------------------------------------------------------------------ CORS


def test_an_allowed_origin_is_reported_with_its_header() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "OPTIONS"
        assert request.headers["origin"] == "https://weathra-bice.vercel.app"
        assert request.headers["access-control-request-method"] == "GET"
        return httpx.Response(
            200, headers={"access-control-allow-origin": "https://weathra-bice.vercel.app"}
        )

    with read_only_client(transport=_transport(handler)) as client:
        assert (
            preflight(
                client, "https://weathra.test/api/v1/health", "https://weathra-bice.vercel.app"
            )
            == "https://weathra-bice.vercel.app"
        )


def test_a_refused_origin_is_reported_as_none() -> None:
    """Starlette answers a disallowed origin with 400 and *no* allow-origin header at all, so the
    header's presence is the signal rather than the status."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, headers={"access-control-allow-methods": "GET"})

    with read_only_client(transport=_transport(handler)) as client:
        assert (
            preflight(client, "https://weathra.test/api/v1/health", "https://elsewhere.invalid")
            is None
        )


# ------------------------------------------------------------------ credentials


def test_a_complete_credential_set_is_read() -> None:
    found, missing = credentials_from_env(CREDENTIALS)
    assert missing == ()
    assert found is not None
    assert found.user_a_email == "a@weathra.test"
    assert found.supabase_url == "https://project.supabase.co"


def test_no_credentials_names_every_variable_that_is_needed() -> None:
    """The skip message has to be actionable, so the missing names are the return value."""
    found, missing = credentials_from_env({})
    assert found is None
    assert set(missing) == set(CREDENTIAL_VARIABLES)


@pytest.mark.parametrize("dropped", CREDENTIAL_VARIABLES)
def test_half_a_credential_set_is_treated_as_none(dropped: str) -> None:
    """The dangerous middle state. Signing in as one account and skipping the isolation checks
    would report a pass for the property those checks exist to prove."""
    partial = {name: value for name, value in CREDENTIALS.items() if name != dropped}
    found, missing = credentials_from_env(partial)
    assert found is None
    assert missing == (dropped,)


def test_the_first_account_supplied_twice_is_not_a_second_account() -> None:
    """The configuration mistake that reads as a production data leak.

    Account A's address in account B's variables satisfies "both are set" and signs in twice
    perfectly well. Every isolation check then reports that one account can read and delete the
    other's data — true, because there is only one account, and indistinguishable in a log from a
    broken policy. So it is reported the way an absent second account is reported, naming the same
    two variables, and the isolation checks skip.
    """
    same = {
        **CREDENTIALS,
        "WEATHRA_LIVE_USER_B_EMAIL": CREDENTIALS["WEATHRA_LIVE_USER_A_EMAIL"].upper(),
    }
    found, missing = credentials_from_env(same)
    assert missing == SECOND_ACCOUNT_VARIABLES
    assert found is not None
    assert found.has_second_account is False, "one account was accepted as two"


def test_a_genuine_second_account_is_still_accepted() -> None:
    """The other half: the guard above must not reject the configuration it exists to protect."""
    found, missing = credentials_from_env(CREDENTIALS)
    assert missing == ()
    assert found is not None and found.has_second_account


def test_a_token_does_not_print_itself_but_is_still_the_token() -> None:
    """pytest renders every fixture argument into a traceback, so the repr is the leak path."""
    token = Token("header.payload.signature")
    assert "signature" not in repr(token)
    assert f"Bearer {token}" == "Bearer header.payload.signature"
    assert token == "header.payload.signature"


def test_credentials_do_not_print_themselves() -> None:
    """Same route, the other object: a failed check must not print an account or a client key."""
    found, _ = credentials_from_env(CREDENTIALS)
    assert found is not None
    rendered = repr(found)
    for secret in (*found.secrets, found.user_a_email, found.user_b_email or ""):
        assert secret not in rendered, "a credential is rendered into every traceback"
    assert "project.supabase.co" in rendered, "the project URL is public and worth keeping"


def test_signing_in_returns_the_token_and_nothing_else() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["grant_type"] == "password"
        assert request.headers["apikey"] == CREDENTIALS["WEATHRA_LIVE_SUPABASE_ANON_KEY"]
        return httpx.Response(
            200, json={"access_token": "a-real-looking-token", "token_type": "bearer"}
        )

    found, _ = credentials_from_env(CREDENTIALS)
    assert found is not None
    with httpx.Client(transport=_transport(handler)) as client:
        assert (
            sign_in(client, found, found.user_a_email, found.user_a_password)
            == "a-real-looking-token"
        )


def test_a_refused_sign_in_says_so_without_quoting_the_provider() -> None:
    """The provider's body carries the account's identity, so the failure names none of it."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant", "email": "a@weathra.test"})

    found, _ = credentials_from_env(CREDENTIALS)
    assert found is not None
    with (
        httpx.Client(transport=_transport(handler)) as client,
        pytest.raises(LiveCheckError) as caught,
    ):
        sign_in(client, found, found.user_a_email, found.user_a_password)
    assert "a@weathra.test" not in str(caught.value)
    assert "400" in str(caught.value)


def test_a_sign_in_with_no_token_in_the_answer_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token_type": "bearer"})

    found, _ = credentials_from_env(CREDENTIALS)
    assert found is not None
    with (
        httpx.Client(transport=_transport(handler)) as client,
        pytest.raises(LiveCheckError, match="no access token"),
    ):
        sign_in(client, found, found.user_a_email, found.user_a_password)


# ------------------------------------------------------------------ redaction


def test_redaction_removes_credentials_from_reported_text() -> None:
    secret = "a-password-nobody-should-read"
    assert secret not in redact(f"signing in with {secret} failed", secret)
    assert "«redacted»" in redact(f"signing in with {secret} failed", secret)


def test_redaction_removes_the_longest_match_first() -> None:
    """A shorter secret contained in a longer one must not survive by being replaced inside it."""
    scrubbed = redact("token=abcdefghij-suffix", "abcdefghij", "abcdefghij-suffix")
    assert "abcdefghij" not in scrubbed


def test_redaction_ignores_values_too_short_to_be_credentials() -> None:
    """Redacting "a" would replace every letter in the message and destroy the finding."""
    assert redact("the path /me answered 401", "/me") == "the path /me answered 401"


def test_a_failure_message_is_redacted() -> None:
    """The place a bearer token would otherwise reach a public log."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="failed for token abcdefghijklmnop")

    with read_only_client(transport=_transport(handler)) as client:
        response = fetch(client, "GET", "https://weathra.test/api/v1/me")
    with pytest.raises(LiveCheckError) as caught:
        assert_not_server_error(response, "abcdefghijklmnop")
    assert "abcdefghijklmnop" not in str(caught.value)
