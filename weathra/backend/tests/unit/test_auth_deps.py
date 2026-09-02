"""Task 4.3 — the principal dependencies, and the rule that a client cannot assert an identity.

A minimal FastAPI app stands in for the real one (built in group 15), with just enough error
mapping to see a 401. What matters here is which identity the handler acts as, and the headers'
complete failure to influence it.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from tests.auth_support import USER_A, USER_B, TokenFactory, validator_for
from weathra.auth.deps import (
    IDENTITY_ASSERTING_HEADERS,
    OptionalPrincipal,
    RequiredPrincipal,
)
from weathra.domain.errors import AuthenticationFailed, SigningKeysUnavailable


def build_app(token_factory: TokenFactory | None) -> FastAPI:
    app = FastAPI()
    if token_factory is not None:
        app.state.token_validator = validator_for(token_factory)

    @app.exception_handler(AuthenticationFailed)
    async def _unauthenticated(_: Any, failure: AuthenticationFailed) -> JSONResponse:
        return JSONResponse(
            status_code=401, content={"error": {"code": failure.code, "message": failure.message}}
        )

    @app.exception_handler(SigningKeysUnavailable)
    async def _unavailable(_: Any, failure: SigningKeysUnavailable) -> JSONResponse:
        return JSONResponse(
            status_code=503, content={"error": {"code": failure.code, "message": failure.message}}
        )

    @app.get("/protected")
    async def protected(principal: RequiredPrincipal) -> dict[str, Any]:
        return {"acting_as": principal.user_id, "email": principal.email}

    @app.get("/public")
    async def public(principal: OptionalPrincipal) -> dict[str, Any]:
        return {"acting_as": principal.user_id if principal else None}

    return app


@pytest.fixture
def client(token_factory: TokenFactory) -> httpx.AsyncClient:
    app = build_app(token_factory)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://weathra.test")


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- protected routes


async def test_a_valid_token_yields_the_right_subject(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    response = await client.get("/protected", headers=bearer(token_factory.valid()))
    assert response.status_code == 200
    assert response.json()["acting_as"] == USER_A


async def test_a_missing_token_on_a_protected_route_returns_401(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/protected")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_missing"


@pytest.mark.parametrize(
    ("name", "code"),
    [
        ("expired", "token_expired"),
        ("wrong_issuer", "token_issuer_invalid"),
        ("wrong_audience", "token_audience_invalid"),
        ("bad_signature", "token_signature_invalid"),
        ("unknown_key_id", "token_unknown_key"),
        ("unverified_email", "email_not_verified"),
    ],
)
async def test_an_invalid_token_returns_401_with_its_own_code(
    client: httpx.AsyncClient, token_factory: TokenFactory, name: str, code: str
) -> None:
    token = getattr(token_factory, name)()
    response = await client.get("/protected", headers=bearer(token))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == code


@pytest.mark.parametrize(
    "header",
    [
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Token abc123"},
        {"Authorization": "bearer"},
    ],
    ids=["basic", "custom-scheme", "bearer-with-no-value"],
)
async def test_a_non_bearer_credential_is_a_malformed_one(
    client: httpx.AsyncClient, header: dict[str, str]
) -> None:
    response = await client.get("/protected", headers=header)
    assert response.status_code == 401
    assert response.json()["error"]["code"] in {"token_malformed", "token_missing"}


async def test_the_bearer_scheme_is_matched_case_insensitively(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    response = await client.get(
        "/protected", headers={"Authorization": f"bEaReR {token_factory.valid()}"}
    )
    assert response.status_code == 200


async def test_no_error_body_carries_token_material(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    token = token_factory.expired()
    response = await client.get("/protected", headers=bearer(token))
    assert token not in response.text
    assert token.split(".")[1] not in response.text


# --------------------------------------------------------------------------- asserted identity


async def test_a_header_naming_another_user_does_not_change_who_acts(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    """The scenario from specs/authentication, header by header."""
    for header in IDENTITY_ASSERTING_HEADERS:
        response = await client.get(
            "/protected",
            headers={**bearer(token_factory.valid(subject=USER_A)), header: USER_B},
        )
        assert response.status_code == 200, header
        assert response.json()["acting_as"] == USER_A, header


async def test_an_asserted_identity_without_a_token_is_unauthenticated(
    client: httpx.AsyncClient,
) -> None:
    for header in IDENTITY_ASSERTING_HEADERS:
        response = await client.get("/protected", headers={header: USER_B})
        assert response.status_code == 401, header


async def test_a_query_parameter_naming_another_user_is_ignored(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    response = await client.get(
        f"/protected?user_id={USER_B}&profile_id={USER_B}",
        headers=bearer(token_factory.valid(subject=USER_A)),
    )
    assert response.status_code == 200
    assert response.json()["acting_as"] == USER_A


# --------------------------------------------------------------------------- public routes


async def test_a_public_route_serves_an_anonymous_caller(client: httpx.AsyncClient) -> None:
    response = await client.get("/public")
    assert response.status_code == 200
    assert response.json()["acting_as"] is None


async def test_a_public_route_recognizes_a_signed_in_caller(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    """So preferences can be applied, without a token ever being required."""
    response = await client.get("/public", headers=bearer(token_factory.valid()))
    assert response.status_code == 200
    assert response.json()["acting_as"] == USER_A


async def test_a_public_route_still_rejects_an_invalid_token(
    client: httpx.AsyncClient, token_factory: TokenFactory
) -> None:
    """An expired session must be told to sign in again, not silently served the defaults."""
    response = await client.get("/public", headers=bearer(token_factory.expired()))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_expired"


async def test_a_public_route_ignores_an_asserted_identity(client: httpx.AsyncClient) -> None:
    response = await client.get("/public", headers={"X-Weathra-Profile-Id": USER_B})
    assert response.status_code == 200
    assert response.json()["acting_as"] is None


# --------------------------------------------------------------------------- misconfiguration


async def test_an_unconfigured_validator_is_a_dependency_failure_not_a_rejection() -> None:
    """503, not 401: nothing is wrong with the caller's credential."""
    app = build_app(None)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://weathra.test"
    ) as client:
        response = await client.get("/protected", headers={"Authorization": "Bearer x.y.z"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "signing_keys_unavailable"


async def test_an_authentication_failure_is_logged_with_its_reason_and_not_the_token(
    client: httpx.AsyncClient,
    token_factory: TokenFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    token = token_factory.expired()
    with caplog.at_level("INFO", logger="weathra.auth"):
        await client.get("/protected", headers=bearer(token))

    messages = [record.getMessage() for record in caplog.records]
    assert any("token_expired" in message for message in messages), messages
    assert not any(token in message for message in messages)
    assert not any(token.split(".")[1] in message for message in messages)
