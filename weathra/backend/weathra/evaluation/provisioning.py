"""The evaluation test user: provisioned repeatably, authenticated, and recorded without its key.

``specs/evaluation`` requires a run to authenticate as a real user, to provision that user if it
does not exist, and to do both without manual intervention — a suite that needed somebody to click
"create account" first is a suite that will not run in CI.

**Two modes, and the difference is where the token comes from.**

* **Offline** mints a token locally from a generated key pair whose public half is fed to the JWKS
  cache. No Supabase call, no credential, no network — which is what makes the deterministic
  metrics runnable in CI (``specs/evaluation``: "deterministic metrics run without external
  services"). The user is provisioned directly through the privileged connection.
* **Live** asks Supabase Auth to create the user with the service-role key and to issue a session
  for it. That key is a privileged credential and this is one of the four places design.md decision
  19 permits it: evaluation test-user provisioning, alongside migrations and retention.

**The identity is recorded; the credential never is.** ``TestIdentity`` carries the subject and the
email, and holds the access token in a ``SecretStr`` that the run record does not serialize. A run
record is an artifact people read and CI archives, and a token in one is a token in a log.

**The email is derived, not random.** ``evaluation+<slug>@weathra.test`` so re-running provisions
the *same* user and a run's data does not accumulate a new account each time.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from enum import StrEnum

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import text

from weathra.auth.jwks import JwksCache
from weathra.auth.roles import ADMINISTRATOR_ROLE
from weathra.auth.tokens import TokenValidator
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session

__all__ = ["EvaluationMode", "TestIdentity", "provision_test_user"]

logger = logging.getLogger("weathra.evaluation.provisioning")

# Derived from the dataset rather than random, so a re-run provisions the same user.
TEST_USER_EMAIL = "evaluation+weathra-mvp@weathra.test"

# A fixed subject in offline mode, so a run's records are recognisable and a re-run reuses them.
OFFLINE_TEST_SUBJECT = "e0a1f2b3-0000-4000-8000-e5a1a7100001"


class EvaluationMode(StrEnum):
    """Where a run gets its weather, its inference, and its tokens."""

    OFFLINE = "offline"
    LIVE = "live"


class TestIdentity(BaseModel):
    """The evaluation user, as a run records it.

    The token is a ``SecretStr`` and is excluded from serialization: a run record is archived by CI
    and read by people, and a credential in one is a credential in a log.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str = Field(min_length=1, description="The auth subject the run acts as.")
    email: str = Field(min_length=1, description="Derived, so a re-run reuses the same account.")
    mode: EvaluationMode
    provisioned_now: bool = Field(default=False, description="True when this run created the user.")
    access_token: SecretStr = Field(exclude=True, repr=False)

    def authorization(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token.get_secret_value()}"}

    def recorded(self) -> dict[str, str | bool]:
        """What goes in the run record: the identity, and nothing that could authenticate as it."""
        return {
            "user_id": self.user_id,
            "email": self.email,
            "mode": self.mode.value,
            "provisioned_now": self.provisioned_now,
        }


@dataclass(frozen=True, slots=True)
class OfflineTokens:
    """A locally-minted key pair and the validator that trusts it.

    The same mechanism the test suite uses (design.md decision 20): the public half is fed to the
    JWKS cache in memory, so token validation is the real code path and no Supabase call happens.
    """

    validator: TokenValidator
    token: str
    subject: str


def _build_offline_tokens(settings: Settings) -> OfflineTokens:
    """Mint a token for the evaluation user, and a validator that will accept it."""
    import time

    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_id = "weathra-evaluation-key"

    def jwks_document() -> dict[str, object]:
        public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        return {"keys": [{**public, "kid": key_id, "alg": "RS256", "use": "sig"}]}

    now = int(time.time())
    claims = {
        "sub": OFFLINE_TEST_SUBJECT,
        "email": TEST_USER_EMAIL,
        "email_verified": True,
        "aud": settings.supabase_jwt_audience,
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": now + 3_600,
        "role": "authenticated",
        # Deliberately *no* role claim. An evaluation run is internal traffic and must be
        # accounted against the internal allowance (`specs/usage-limits`), but as of `0011` that
        # is a row in `admin_roles`, not something a token can assert — `_ensure_role_row` below
        # writes it. A claim here would be ignored, which is the property group 31 exists to
        # establish, so putting one in would only mislead the next reader.
    }
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": key_id})

    def handler(request: httpx.Request) -> httpx.Response:
        # Only the key-set URL is answered; anything else is a bug worth failing loudly on.
        if str(request.url) != settings.jwks_url:
            raise AssertionError(f"an offline evaluation run reached {request.url}")
        return httpx.Response(200, json=jwks_document())

    cache = JwksCache(
        jwks_url=settings.jwks_url,
        ttl_seconds=settings.supabase_jwks_cache_ttl_seconds,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return OfflineTokens(
        validator=TokenValidator(settings=settings, jwks=cache),
        token=token,
        subject=OFFLINE_TEST_SUBJECT,
    )


async def _ensure_profile_row(engines: Engines, user_id: str) -> bool:
    """Create the profile row directly, under the privileged connection.

    Privileged because the run needs the user to exist *before* it authenticates as them, and the
    request-serving role cannot insert a profile for a subject whose claims it is not carrying.
    Returns whether this call created it.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        inserted = (
            await session.execute(
                text(
                    "INSERT INTO profiles (user_id) VALUES (:user_id) "
                    "ON CONFLICT DO NOTHING RETURNING user_id"
                ),
                {"user_id": user_id},
            )
        ).all()
    return bool(inserted)


async def _ensure_role_row(engines: Engines, user_id: str) -> None:
    """Give the evaluation subject the administrative role, under the privileged connection.

    An evaluation run's usage is internal (`specs/usage-limits`), and since `0011` "internal" means
    holding the role in `admin_roles` rather than carrying a claim. Privileged because the request
    role is granted no write on that table at all — which is the point of the table.

    Not audited, and that is deliberate rather than an omission: `record_change` attributes a grant
    to an acting administrative principal, and a harness provisioning its own fixture is not one.
    The grant is idempotent, scoped to a subject the dataset derives, and undone with the run's
    database. A row in `admin_audit` claiming an administrator did this would be the fiction.

    Without it a fifty-case dataset spends a Free tier's daily allowance a third of the way
    through the run and every case after that measures a 429, which is how this was found.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO admin_roles (subject_id, role) VALUES (CAST(:user AS uuid), :role) "
                "ON CONFLICT (subject_id, role) DO NOTHING"
            ),
            {"user": user_id, "role": ADMINISTRATOR_ROLE},
        )


async def _provision_live_user(
    settings: Settings, client: httpx.AsyncClient
) -> tuple[str, str, bool]:
    """Create the evaluation user in Supabase Auth and obtain a session for it.

    The service-role key is used here and nowhere on a request path — design.md decision 19 names
    evaluation provisioning as one of the four permitted uses, and ``Settings`` refuses to start
    with the key present in request-serving mode.
    """
    key = settings.supabase_service_role_key
    if key is None:
        raise ValueError(
            "A live evaluation run needs SUPABASE_SERVICE_ROLE_KEY to provision its test user. "
            "Run in offline mode, or supply the key to the evaluation job only — never to the "
            "request-serving service."
        )

    base = str(settings.supabase_url).rstrip("/")
    secret = key.get_secret_value()
    headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}
    password = f"weathra-evaluation-{uuid.uuid4().hex}"

    created = await client.post(
        f"{base}/auth/v1/admin/users",
        headers=headers,
        json={
            "email": TEST_USER_EMAIL,
            "password": password,
            "email_confirm": True,
        },
    )

    provisioned_now = created.status_code in {200, 201}
    if not provisioned_now:
        # The user already exists, which is the normal case on a re-run. Its password is unknown,
        # so it is reset to this run's — the account exists only for evaluation.
        listed = await client.get(
            f"{base}/auth/v1/admin/users",
            headers=headers,
            params={"filter": TEST_USER_EMAIL},
        )
        listed.raise_for_status()
        users = listed.json().get("users") or []
        existing = next((user for user in users if user.get("email") == TEST_USER_EMAIL), None)
        if existing is None:
            raise ValueError(
                f"Supabase Auth refused to create {TEST_USER_EMAIL} "
                f"({created.status_code}) and does not report it as existing."
            )
        updated = await client.put(
            f"{base}/auth/v1/admin/users/{existing['id']}",
            headers=headers,
            json={"password": password, "email_confirm": True},
        )
        updated.raise_for_status()

    session = await client.post(
        f"{base}/auth/v1/token",
        headers={"apikey": secret},
        params={"grant_type": "password"},
        json={"email": TEST_USER_EMAIL, "password": password},
    )
    session.raise_for_status()
    payload = session.json()

    token = payload.get("access_token")
    subject = (payload.get("user") or {}).get("id")
    if not token or not subject:
        raise ValueError(
            "Supabase Auth issued a session with no access token or no subject; the evaluation "
            "run cannot authenticate."
        )
    return str(subject), str(token), provisioned_now


async def provision_test_user(
    settings: Settings,
    engines: Engines,
    *,
    mode: EvaluationMode,
    client: httpx.AsyncClient | None = None,
) -> tuple[TestIdentity, TokenValidator | None]:
    """The evaluation user, authenticated, plus the validator a run should trust.

    Returns the validator only in offline mode, where it is the locally-seeded one the app must be
    given; a live run uses the app's own validator against the real project.
    """
    if mode is EvaluationMode.OFFLINE:
        offline = _build_offline_tokens(settings)
        provisioned = await _ensure_profile_row(engines, offline.subject)
        await _ensure_role_row(engines, offline.subject)
        logger.info(
            "offline evaluation user %s %s",
            offline.subject,
            "provisioned" if provisioned else "already present",
        )
        return (
            TestIdentity(
                user_id=offline.subject,
                email=TEST_USER_EMAIL,
                mode=mode,
                provisioned_now=provisioned,
                access_token=SecretStr(offline.token),
            ),
            offline.validator,
        )

    if client is None:  # pragma: no cover - the runner always supplies one
        raise ValueError("A live evaluation run needs an HTTP client to reach Supabase Auth.")

    subject, token, provisioned_now = await _provision_live_user(settings, client)
    await _ensure_profile_row(engines, subject)
    await _ensure_role_row(engines, subject)
    logger.info(
        "live evaluation user %s %s",
        subject,
        "provisioned" if provisioned_now else "already present",
    )

    return (
        TestIdentity(
            user_id=subject,
            email=TEST_USER_EMAIL,
            mode=mode,
            provisioned_now=provisioned_now,
            access_token=SecretStr(token),
        ),
        None,
    )
