"""The error hierarchy (design.md decision 16).

Every failure the system can name is a ``WeathraError`` subclass carrying a stable machine-readable
``code``, a human-readable message, and optional field-level ``details``.

Nothing here knows about HTTP. The status mapping lives in ``api/errors.py`` and is applied exactly
once, so a service, a provider, or an MCP tool can raise the condition it actually observed without
deciding how a browser should see it.

Two rules the hierarchy exists to keep honest:

* An error is never presented as weather data. A caller receives a coded failure, not a success
  envelope carrying zeros (``specs/weather-providers``, ``specs/safety-grounding``).
* No error message or ``details`` payload may carry credential material, a token, or a raw upstream
  payload. Constructors take a message the caller wrote; provider adapters build theirs from the
  status and the provider name, never from the response body.
"""

from __future__ import annotations

from typing import Any, ClassVar

__all__ = [
    "AGENT_UNAVAILABLE_MESSAGE",
    "AgentBudgetExceeded",
    "AgentNotConfigured",
    "AnalyticsNotPossible",
    "AuthenticationFailed",
    "AuthorizationFailed",
    "EmailNotVerified",
    "EvidenceNotFound",
    "LocationNotFound",
    "McpUnavailable",
    "MemoryUnavailable",
    "NoDataForRange",
    "NotFound",
    "ProviderNotFound",
    "ProviderRateLimited",
    "ProviderTimeout",
    "ProviderUnavailable",
    "RangeOutsideCoverage",
    "RecordNotFound",
    "SavedLocationLimitReached",
    "SigningKeysUnavailable",
    "ThreadNotFound",
    "TokenAudienceInvalid",
    "TokenExpired",
    "TokenIssuerInvalid",
    "TokenMalformed",
    "TokenMissing",
    "TokenSignatureInvalid",
    "TokenUnknownKey",
    "ToolNotFound",
    "UnsupportedCriterion",
    "UnsupportedHorizon",
    "UnsupportedMeasure",
    "ValidationFailed",
    "VectorIndexMismatch",
    "WeathraError",
    "all_error_classes",
]


class WeathraError(Exception):
    """Base of every named failure.

    Subclasses declare a stable ``code``. The code is part of the API contract: clients branch on
    it, the evaluation suite counts it, and it must not change with a reworded message.
    """

    code: ClassVar[str] = "internal_error"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        if not message or not message.strip():
            raise ValueError(f"{type(self).__name__} requires a message")
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = dict(details or {})

    def __str__(self) -> str:
        return self.message

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, message={self.message!r})"


# --------------------------------------------------------------------------- validation


class ValidationFailed(WeathraError):
    """A request or argument is malformed, out of range, or internally inconsistent."""

    code: ClassVar[str] = "validation_failed"


class UnsupportedHorizon(ValidationFailed):
    """A forecast horizon beyond the selected provider's declared maximum.

    Never silently truncated: the error states the maximum the provider supports.
    """

    code: ClassVar[str] = "unsupported_horizon"


class RangeOutsideCoverage(ValidationFailed):
    """A historical range that starts before the archive, is inverted, or runs into the future."""

    code: ClassVar[str] = "range_outside_coverage"


class UnsupportedMeasure(ValidationFailed):
    """A threshold or statistic was requested on a measure the series does not carry."""

    code: ClassVar[str] = "unsupported_measure"


class UnsupportedCriterion(ValidationFailed):
    """A comparison criterion outside the supported set. The error lists the supported ones."""

    code: ClassVar[str] = "unsupported_criterion"


class SavedLocationLimitReached(ValidationFailed):
    """A save that would exceed the configured saved-location limit.

    A validation failure rather than a forbidden request: the caller may retry after removing one,
    and the message states the limit so they know how many that is (``specs/memory``).
    """

    code: ClassVar[str] = "saved_location_limit_reached"


class ProviderNotFound(ValidationFailed):
    """A provider name that is not registered. The error lists the registered names."""

    code: ClassVar[str] = "provider_not_found"


class ToolNotFound(ValidationFailed):
    """An MCP tool name the server does not expose. The error lists the available names."""

    code: ClassVar[str] = "tool_not_found"


class AnalyticsNotPossible(ValidationFailed):
    """There is nothing to analyse — an empty series, or too few usable points for any statistic.

    A statistic that cannot be computed while others can is *reported* not-computable in the
    result rather than raised; this is only for the case where the whole request has no basis.
    """

    code: ClassVar[str] = "analytics_not_possible"


# --------------------------------------------------------------------------- not found


class NotFound(WeathraError):
    """A named thing does not exist — or does not exist *for this caller*.

    An ownership miss raises a not-found rather than a forbidden, so a probe cannot tell "exists
    but is not yours" from "does not exist" (``specs/authentication``).
    """

    code: ClassVar[str] = "not_found"


class LocationNotFound(NotFound):
    """A place name matched no known location. No nearest or partial match is substituted."""

    code: ClassVar[str] = "location_not_found"


class NoDataForRange(NotFound):
    """The provider holds no data covering the requested location or range.

    Distinct from a provider outage: the provider answered, and the answer was "nothing here".
    """

    code: ClassVar[str] = "no_data_for_range"


class EvidenceNotFound(NotFound):
    """An unknown evidence identifier, or one belonging to another user. Identical either way."""

    code: ClassVar[str] = "evidence_not_found"


class ThreadNotFound(NotFound):
    """An unknown conversation thread, or one owned by another user. Identical either way."""

    code: ClassVar[str] = "thread_not_found"


class RecordNotFound(NotFound):
    """A user-owned record missing from the acting user's scope — a saved location, a preference."""

    code: ClassVar[str] = "record_not_found"


# --------------------------------------------------------------------------- identity


class AuthenticationFailed(WeathraError):
    """No valid identity could be established for the request.

    Subclasses are distinguishable by code so a client can tell an expired session from a
    malformed token, and so a systemic rejection is diagnosable. A failure is logged with its
    reason and never with the token (``specs/authentication``).
    """

    code: ClassVar[str] = "authentication_failed"


class TokenMissing(AuthenticationFailed):
    """A protected endpoint was called with no bearer token."""

    code: ClassVar[str] = "token_missing"


class TokenMalformed(AuthenticationFailed):
    """The credential is not a well-formed token at all."""

    code: ClassVar[str] = "token_malformed"


class TokenExpired(AuthenticationFailed):
    """A well-formed token past its expiry, beyond the permitted clock-skew leeway."""

    code: ClassVar[str] = "token_expired"


class TokenSignatureInvalid(AuthenticationFailed):
    """The signature did not verify against the project's published signing keys."""

    code: ClassVar[str] = "token_signature_invalid"


class TokenIssuerInvalid(AuthenticationFailed):
    """A well-formed token from a different issuer."""

    code: ClassVar[str] = "token_issuer_invalid"


class TokenAudienceInvalid(AuthenticationFailed):
    """A well-formed token for a different audience."""

    code: ClassVar[str] = "token_audience_invalid"


class TokenUnknownKey(AuthenticationFailed):
    """The token names a key id absent from the key set even after an immediate refetch."""

    code: ClassVar[str] = "token_unknown_key"


class EmailNotVerified(AuthenticationFailed):
    """A token carrying an unverified-email claim.

    Defence in depth: with email confirmation required on the project, an unverified account has
    no access token at all, so this should be unreachable. It is rejected anyway.
    """

    code: ClassVar[str] = "email_not_verified"


class AuthorizationFailed(WeathraError):
    """A validated identity that is not permitted to do this.

    Reached only where the existence of the target is not itself a secret; an ownership miss on a
    user-owned record raises ``NotFound`` instead.
    """

    code: ClassVar[str] = "forbidden"


# --------------------------------------------------------------------------- dependencies


class ProviderUnavailable(WeathraError):
    """The upstream provider could not be reached after the permitted retries."""

    code: ClassVar[str] = "provider_unavailable"


class ProviderTimeout(WeathraError):
    """The upstream provider did not respond within the configured timeout."""

    code: ClassVar[str] = "provider_timeout"


class ProviderRateLimited(WeathraError):
    """The upstream provider reported the caller rate-limited. Distinct from unavailability."""

    code: ClassVar[str] = "provider_rate_limited"


class McpUnavailable(WeathraError):
    """The configured MCP server is unreachable. Named with its address at startup."""

    code: ClassVar[str] = "mcp_unavailable"


class MemoryUnavailable(WeathraError):
    """The memory store is unreachable.

    Stateless capabilities continue to serve; a follow-up reports context unavailable rather than
    answering as though context had been applied (``specs/memory``).
    """

    code: ClassVar[str] = "memory_unavailable"


class SigningKeysUnavailable(WeathraError):
    """The signing-key set could not be fetched, so no token can be validated right now.

    Distinguishable from a rejected token: the credential may be perfectly good.
    """

    code: ClassVar[str] = "signing_keys_unavailable"


class VectorIndexMismatch(WeathraError):
    """The configured embedding model or dimension differs from the stored index.

    Querying across a mismatch would produce meaningless similarity, so it is refused and
    re-indexing is reported as required (``specs/rag-knowledge``).
    """

    code: ClassVar[str] = "vector_index_mismatch"


# What a person is told when inference cannot answer, wherever that is discovered — at
# construction, at a request, or mid-stream. It says what is unavailable and what still works, and
# names nothing about how the service is configured: no environment variable, no credential, no
# provider setting. An operator's checklist read out to a visitor is useless to them and a small
# disclosure of how the service is wired. The diagnosis belongs in the log and in `details`.
#
# It lives beside `AgentNotConfigured` because every site that raises it needs the same words, and
# a message duplicated across three modules is a message that drifts.
AGENT_UNAVAILABLE_MESSAGE = (
    "Weather intelligence is temporarily unavailable. Forecasts, history, analytics, comparison "
    "and your saved locations are all unaffected."
)


class AgentNotConfigured(WeathraError):
    """The agent surface was called with no inference credential configured.

    Names the missing configuration. Every non-agent capability keeps working.
    """

    code: ClassVar[str] = "agent_not_configured"


class AgentBudgetExceeded(WeathraError):
    """A run hit its step or wall-clock bound.

    Normally caught by the graph, which returns a partial result reporting what it gathered rather
    than surfacing this to a caller.
    """

    code: ClassVar[str] = "agent_budget_exceeded"


def all_error_classes() -> list[type[WeathraError]]:
    """Every concrete error class, breadth-first from ``WeathraError``.

    Used by the code-uniqueness test and by the API's status-mapping completeness test, so a new
    error cannot be added without both noticing.
    """
    seen: list[type[WeathraError]] = []
    frontier: list[type[WeathraError]] = [WeathraError]
    while frontier:
        current = frontier.pop(0)
        if current not in seen:
            seen.append(current)
        frontier.extend(sorted(current.__subclasses__(), key=lambda cls: cls.__name__))
    return seen
