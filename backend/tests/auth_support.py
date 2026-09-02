"""Token fixtures: a local signing key pair and a factory for every token shape.

This is the mechanism behind design.md decision 20's authentication row and task 18.1: tokens are
minted locally by a key pair whose public half is fed to the JWKS cache, so the whole
authentication suite runs with **no Supabase network call at all**. Every rejection case the specs
name — expired, wrong issuer, wrong audience, bad signature, unknown key id, malformed,
unverified-email — is a token this factory can produce.

Two key pairs exist on purpose. The second one signs the "bad signature" token: a token that is
structurally perfect and correctly claims a *published* key id, but was signed by a key nobody
published. Flipping a character in a valid token would test base64 decoding instead.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from weathra.auth.jwks import JwksCache
from weathra.auth.tokens import TokenValidator
from weathra.config import Settings

ISSUER = "https://project.supabase.co/auth/v1"
AUDIENCE = "authenticated"
PRIMARY_KEY_ID = "weathra-test-key-1"
IMPOSTOR_KEY_ID = "weathra-test-key-impostor"
UNPUBLISHED_KEY_ID = "weathra-test-key-never-published"

USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"


def _generate() -> rsa.RSAPrivateKey:
    # 2048 bits: the smallest size PyJWT will sign with that is not a toy, and fast enough to
    # generate per session.
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@dataclass(slots=True)
class KeyPair:
    key_id: str
    private_key: rsa.RSAPrivateKey

    def as_jwk(self) -> dict[str, Any]:
        """The public half, in the shape a JWKS endpoint publishes."""
        public = jwt.algorithms.RSAAlgorithm.to_jwk(self.private_key.public_key(), as_dict=True)
        return {**public, "kid": self.key_id, "alg": "RS256", "use": "sig"}


@dataclass(slots=True)
class TokenFactory:
    """Mints the tokens the authentication suite needs, valid and otherwise."""

    signing: KeyPair
    impostor: KeyPair
    issuer: str = ISSUER
    audience: str = AUDIENCE

    # ---------------------------------------------------------------- the published key set

    def jwks_document(self) -> dict[str, Any]:
        """What the project's key-set endpoint serves. The impostor's key is *not* in it."""
        return {"keys": [self.signing.as_jwk()]}

    # ---------------------------------------------------------------- tokens

    def _encode(
        self,
        claims: dict[str, Any],
        *,
        key: KeyPair | None = None,
        key_id: str | None = None,
        algorithm: str = "RS256",
    ) -> str:
        pair = key or self.signing
        return jwt.encode(
            claims,
            pair.private_key,
            algorithm=algorithm,
            headers={"kid": key_id or pair.key_id},
        )

    def claims(
        self,
        *,
        subject: str = USER_A,
        email: str | None = None,
        email_verified: bool = True,
        issuer: str | None = None,
        audience: str | None = None,
        expires_in: int = 3_600,
        issued_at: int | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        now = issued_at if issued_at is not None else int(time.time())
        return {
            "sub": subject,
            "email": email if email is not None else f"{subject[:8]}@example.test",
            "email_verified": email_verified,
            "aud": audience if audience is not None else self.audience,
            "iss": issuer if issuer is not None else self.issuer,
            "iat": now,
            "exp": now + expires_in,
            "role": "authenticated",
            **extra,
        }

    def valid(self, *, subject: str = USER_A, **kwargs: Any) -> str:
        return self._encode(self.claims(subject=subject, **kwargs))

    def expired(self, *, subject: str = USER_A, seconds_ago: int = 3_600) -> str:
        now = int(time.time())
        return self._encode(
            self.claims(subject=subject, issued_at=now - seconds_ago - 60, expires_in=60)
        )

    def wrong_issuer(self, *, subject: str = USER_A) -> str:
        return self._encode(
            self.claims(subject=subject, issuer="https://elsewhere.example/auth/v1")
        )

    def wrong_audience(self, *, subject: str = USER_A) -> str:
        return self._encode(self.claims(subject=subject, audience="some-other-audience"))

    def bad_signature(self, *, subject: str = USER_A) -> str:
        """Signed by an unpublished key while claiming a published key id."""
        return self._encode(
            self.claims(subject=subject), key=self.impostor, key_id=self.signing.key_id
        )

    def unknown_key_id(self, *, subject: str = USER_A) -> str:
        return self._encode(self.claims(subject=subject), key_id=UNPUBLISHED_KEY_ID)

    def unverified_email(self, *, subject: str = USER_A) -> str:
        return self._encode(self.claims(subject=subject, email_verified=False))

    def no_subject(self) -> str:
        claims = self.claims()
        claims.pop("sub")
        return self._encode(claims)

    def no_expiry(self, *, subject: str = USER_A) -> str:
        claims = self.claims(subject=subject)
        claims.pop("exp")
        return self._encode(claims)

    def no_key_id(self, *, subject: str = USER_A) -> str:
        return jwt.encode(
            self.claims(subject=subject),
            self.signing.private_key,
            algorithm="RS256",
        )

    def unsigned(self, *, subject: str = USER_A) -> str:
        """``alg: none``. Refused before the key set is even consulted."""
        return jwt.encode(
            self.claims(subject=subject),
            key="",  # `none` takes no key; PyJWT still wants the argument
            algorithm="none",
            headers={"kid": "none"},
        )

    @staticmethod
    def malformed() -> str:
        return "not-a-token"

    @staticmethod
    def truncated() -> str:
        return "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0"


def build_factory() -> TokenFactory:
    return TokenFactory(
        signing=KeyPair(PRIMARY_KEY_ID, _generate()),
        impostor=KeyPair(IMPOSTOR_KEY_ID, _generate()),
    )


def settings_for(factory: TokenFactory, **overrides: Any) -> Settings:
    """Settings whose issuer and audience match the factory's."""
    values: dict[str, Any] = {
        "supabase_url": "https://project.supabase.co",
        "supabase_jwt_issuer": factory.issuer,
        "supabase_jwt_audience": factory.audience,
    }
    values.update(overrides)
    return Settings(**values)


def seeded_cache(
    factory: TokenFactory,
    *,
    settings: Settings | None = None,
    ttl_seconds: int = 600,
    clock: Any = None,
    fetch_recorder: list[str] | None = None,
) -> JwksCache:
    """A JWKS cache served by an in-memory transport carrying the factory's public key.

    No network: the transport answers the key-set URL directly. A request to anything else raises,
    so an accidental outbound call is a test failure rather than a slow test.
    """
    resolved = settings or settings_for(factory)

    def handler(request: httpx.Request) -> httpx.Response:
        if fetch_recorder is not None:
            fetch_recorder.append(str(request.url))
        if str(request.url) != resolved.jwks_url:
            raise AssertionError(f"unexpected outbound request to {request.url}")
        return httpx.Response(200, json=factory.jwks_document())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    kwargs: dict[str, Any] = {
        "jwks_url": resolved.jwks_url,
        "ttl_seconds": ttl_seconds,
        "client": client,
    }
    if clock is not None:
        kwargs["clock"] = clock
    return JwksCache(**kwargs)


def validator_for(
    factory: TokenFactory, *, settings: Settings | None = None, ttl_seconds: int = 600
) -> TokenValidator:
    resolved = settings or settings_for(factory)
    return TokenValidator(
        settings=resolved, jwks=seeded_cache(factory, settings=resolved, ttl_seconds=ttl_seconds)
    )
