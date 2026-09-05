"""The acting user.

``Principal`` is the *only* representation of who a request is acting as. It is produced from a
token that has already been validated — signature, issuer, audience, expiry — and from nothing
else. There is no second identity path: no opaque profile id, no header, no query parameter, no body
field. Design.md decision 4 states the reason plainly: two identity paths mean two authorization
paths and a standing risk that a handler reads the wrong one.

It carries no token material. The compact JWT that produced it is validated and discarded; what
remains is the claim set. That is what makes "no token in a log record, an error body, or an
evidence record" a property of the type rather than a rule everyone has to remember
(``specs/authentication``).
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

__all__ = ["CREDENTIAL_CLAIM_KEYS", "Principal", "compose_thread_key"]

# Claim names that would carry credential material. A token bearing one of these is refused rather
# than quietly carried around inside a Principal.
CREDENTIAL_CLAIM_KEYS = frozenset(
    {
        "access_token",
        "refresh_token",
        "id_token",
        "provider_token",
        "provider_refresh_token",
        "password",
        "encrypted_password",
        "authorization",
        "api_key",
        "secret",
        "client_secret",
        "service_role_key",
    }
)

THREAD_KEY_SEPARATOR = ":"


def compose_thread_key(user_id: str, thread_id: str) -> str:
    """The LangGraph checkpointer key, ``{user_id}:{thread_id}`` (design.md decision 11).

    The checkpointer owns its own schema, so ownership cannot simply be a column we add. Composing
    the key means a thread key is meaningless without the owning user inside it — but that is
    obscurity, not a gate. The actual gate is the ``threads`` row we own, checked before the graph
    is ever invoked. Both mechanisms are needed; neither alone would do.
    """
    if not user_id:
        raise ValueError("A thread key requires the acting user's subject.")
    if not thread_id:
        raise ValueError("A thread key requires a thread identifier.")
    if THREAD_KEY_SEPARATOR in thread_id:
        raise ValueError(
            f"A thread identifier may not contain {THREAD_KEY_SEPARATOR!r}; it would make the "
            "composed key ambiguous about which part is the owner."
        )
    if THREAD_KEY_SEPARATOR in user_id:
        # The checkpoint tables' Row Level Security policies recover the owner with
        # `split_part(thread_id, ':', 1)`, so a subject containing the separator would split into a
        # prefix of itself and never match — the policy would deny the owner their own memory. A
        # Supabase subject is a UUID and never contains one; refusing here is what makes "the text
        # before the first colon is the owner" true by construction rather than by convention.
        raise ValueError(
            f"An auth subject may not contain {THREAD_KEY_SEPARATOR!r}; the composed key would be "
            "ambiguous about where the owner ends."
        )
    return f"{user_id}{THREAD_KEY_SEPARATOR}{thread_id}"


class Principal(BaseModel):
    """A validated identity: the auth subject, the email the token reported, and its claims."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str = Field(
        min_length=1,
        description=(
            "The Supabase Auth subject (the token's `sub`). The ownership key every user-owned "
            "table carries. There is no separate internal profile id."
        ),
    )
    email: str | None = Field(
        default=None, description="As reported by the token. Contact data itself stays in Auth."
    )
    email_verified: bool = Field(
        default=True,
        description=(
            "From the token's claim. A token carrying an unverified email is rejected before a "
            "Principal is built; the field exists so the decision is inspectable."
        ),
    )
    claims: Mapping[str, Any] = Field(
        default_factory=dict,
        description="The validated claim set, minus anything that could be credential material.",
    )

    @field_validator("claims", mode="before")
    @classmethod
    def _refuse_credential_claims(cls, value: object) -> object:
        if isinstance(value, Mapping):
            offending = {str(key).lower() for key in value} & CREDENTIAL_CLAIM_KEYS
            if offending:
                raise ValueError(
                    "A Principal must not carry token or credential material; refusing claims: "
                    f"{sorted(offending)}"
                )
        return value

    @field_validator("claims", mode="after")
    @classmethod
    def _freeze_claims(cls, value: Mapping[str, Any]) -> Mapping[str, Any]:
        return MappingProxyType(dict(value))

    @field_serializer("claims")
    def _serialize_claims(self, value: Mapping[str, Any]) -> dict[str, Any]:
        # The read-only view is not itself serializable; a plain copy is what goes on the wire.
        return dict(value)

    @classmethod
    def from_claims(cls, claims: Mapping[str, Any]) -> Self:
        """Build a principal from an already-validated claim set.

        The only sanctioned constructor on the request path. It refuses a claim set with no
        subject, because an identity with no owner is not an identity — and every user-owned read
        and write is scoped by that subject.
        """
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject.strip():
            raise ValueError("A validated token must carry a non-empty 'sub' claim.")

        email = claims.get("email")
        raw_verified = claims.get("email_verified", claims.get("email_confirmed_at"))
        if raw_verified is None:
            verified = True  # the claim is absent from some token shapes; expiry is the real gate
        elif isinstance(raw_verified, bool):
            verified = raw_verified
        else:
            verified = bool(raw_verified)

        return cls(
            user_id=subject.strip(),
            email=email if isinstance(email, str) else None,
            email_verified=verified,
            claims=claims,
        )

    def claim(self, name: str, default: Any = None) -> Any:
        """One validated claim. Never a source of identity — ``user_id`` is."""
        return self.claims.get(name, default)

    def thread_key(self, thread_id: str) -> str:
        """The composed checkpointer key for one of this user's threads.

        A caller cannot build a key for someone else's thread through this path: the owner half is
        always the acting principal's own subject.
        """
        return compose_thread_key(self.user_id, thread_id)

    def owns(self, user_id: str | None) -> bool:
        """Whether a stored row's owner is this principal."""
        return user_id is not None and user_id == self.user_id

    def __str__(self) -> str:
        """Log-safe: the subject only. Never the email, never a claim, never a token."""
        return f"principal({self.user_id})"

    def __repr__(self) -> str:
        return f"Principal(user_id={self.user_id!r})"
