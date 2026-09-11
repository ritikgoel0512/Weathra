"""Task 2.1 — the error hierarchy's stable codes, and the rules that keep it honest."""

from __future__ import annotations

import pytest

from weathra.domain import errors as e

# The stable code of every class in the hierarchy. Changing an entry here is an API change.
EXPECTED_CODES: dict[type[e.WeathraError], str] = {
    e.WeathraError: "internal_error",
    # validation
    e.ValidationFailed: "validation_failed",
    e.UnsupportedHorizon: "unsupported_horizon",
    e.RangeOutsideCoverage: "range_outside_coverage",
    e.UnsupportedMeasure: "unsupported_measure",
    e.UnsupportedCriterion: "unsupported_criterion",
    e.ProviderNotFound: "provider_not_found",
    e.ToolNotFound: "tool_not_found",
    e.AnalyticsNotPossible: "analytics_not_possible",
    # not found
    e.NotFound: "not_found",
    e.LocationNotFound: "location_not_found",
    e.NoDataForRange: "no_data_for_range",
    e.EvidenceNotFound: "evidence_not_found",
    e.ThreadNotFound: "thread_not_found",
    e.RecordNotFound: "record_not_found",
    e.SavedLocationLimitReached: "saved_location_limit_reached",
    # identity
    e.AuthenticationFailed: "authentication_failed",
    e.TokenMissing: "token_missing",
    e.TokenMalformed: "token_malformed",
    e.TokenExpired: "token_expired",
    e.TokenSignatureInvalid: "token_signature_invalid",
    e.TokenIssuerInvalid: "token_issuer_invalid",
    e.TokenAudienceInvalid: "token_audience_invalid",
    e.TokenUnknownKey: "token_unknown_key",
    e.EmailNotVerified: "email_not_verified",
    e.AuthorizationFailed: "forbidden",
    # dependencies
    e.ProviderUnavailable: "provider_unavailable",
    e.ProviderTimeout: "provider_timeout",
    e.ProviderRateLimited: "provider_rate_limited",
    e.ProviderAuthenticationFailed: "provider_authentication_failed",
    e.McpUnavailable: "mcp_unavailable",
    e.MemoryUnavailable: "memory_unavailable",
    e.SigningKeysUnavailable: "signing_keys_unavailable",
    e.VectorIndexMismatch: "vector_index_mismatch",
    e.AgentNotConfigured: "agent_not_configured",
    e.AgentBudgetExceeded: "agent_budget_exceeded",
    # entitlement
    e.ModelNotAllowlisted: "model_not_allowlisted",
    e.ModelRoleWouldBeUnavailable: "model_role_would_be_unavailable",
    e.NoEligibleModel: "no_eligible_model",
    e.PolicyUnavailable: "policy_unavailable",
    e.QuotaExceeded: "quota_exceeded",
    e.QuotaUnavailable: "quota_unavailable",
}


@pytest.mark.parametrize(
    ("error_class", "code"),
    list(EXPECTED_CODES.items()),
    ids=[cls.__name__ for cls in EXPECTED_CODES],
)
def test_class_declares_its_stable_code(error_class: type[e.WeathraError], code: str) -> None:
    assert error_class.code == code


@pytest.mark.parametrize(
    "error_class", list(EXPECTED_CODES), ids=[cls.__name__ for cls in EXPECTED_CODES]
)
def test_every_class_carries_a_message(error_class: type[e.WeathraError]) -> None:
    raised = error_class("something specific went wrong")
    assert raised.message == "something specific went wrong"
    assert str(raised) == "something specific went wrong"
    assert isinstance(raised, e.WeathraError)
    assert isinstance(raised, Exception)


@pytest.mark.parametrize(
    "error_class", list(EXPECTED_CODES), ids=[cls.__name__ for cls in EXPECTED_CODES]
)
@pytest.mark.parametrize("empty", ["", "   ", "\n"])
def test_a_message_is_mandatory(error_class: type[e.WeathraError], empty: str) -> None:
    with pytest.raises(ValueError, match="requires a message"):
        error_class(empty)


def test_the_hierarchy_has_no_undeclared_class() -> None:
    """A new error class must be given a code and an expectation here, not slip in unnoticed."""
    discovered = set(e.all_error_classes())
    assert discovered == set(EXPECTED_CODES), {
        "undeclared": sorted(cls.__name__ for cls in discovered - set(EXPECTED_CODES)),
        "stale": sorted(cls.__name__ for cls in set(EXPECTED_CODES) - discovered),
    }


def test_codes_are_unique() -> None:
    codes = [cls.code for cls in e.all_error_classes()]
    duplicates = {code for code in codes if codes.count(code) > 1}
    assert not duplicates, f"duplicated error codes: {sorted(duplicates)}"


def test_details_carry_field_level_context() -> None:
    raised = e.UnsupportedHorizon(
        "The provider supports at most 16 forecast days.",
        details={"field": "days", "requested": 30, "maximum": 16},
    )
    assert raised.details == {"field": "days", "requested": 30, "maximum": 16}


def test_details_default_to_an_empty_mapping_that_is_not_shared() -> None:
    first = e.ValidationFailed("first")
    second = e.ValidationFailed("second")
    first.details["field"] = "days"
    assert second.details == {}


def test_ownership_misses_are_not_found_rather_than_forbidden() -> None:
    """A probe must not be able to tell "exists but not yours" from "does not exist"."""
    for error_class in (e.EvidenceNotFound, e.ThreadNotFound, e.RecordNotFound):
        assert issubclass(error_class, e.NotFound)
        assert not issubclass(error_class, e.AuthorizationFailed)


def test_authentication_subclasses_are_distinguishable() -> None:
    """An expired session must be tellable from a malformed credential."""
    expired = e.TokenExpired("The access token has expired.")
    malformed = e.TokenMalformed("The credential is not a token.")
    assert expired.code != malformed.code
    assert isinstance(expired, e.AuthenticationFailed)
    assert isinstance(malformed, e.AuthenticationFailed)


def test_provider_failure_classes_are_distinguishable() -> None:
    codes = {
        e.ProviderUnavailable.code,
        e.ProviderTimeout.code,
        e.ProviderRateLimited.code,
        e.ProviderAuthenticationFailed.code,
        e.NoDataForRange.code,
    }
    assert len(codes) == 5


def test_a_rejected_credential_is_not_an_absent_one() -> None:
    """Two conditions, two codes, and neither inherits the other — task 25.4, 2026-09-11.

    They were one class until a deployment reported `agent_not_configured` from `/agent/ask` while
    its own readiness probe reported the inference provider configured. Subclassing would have kept
    that: a handler catching "nobody set the secret" would still quietly catch "the secret is
    wrong", which is the behaviour the split exists to end.
    """
    assert e.ProviderAuthenticationFailed.code != e.AgentNotConfigured.code
    assert not issubclass(e.ProviderAuthenticationFailed, e.AgentNotConfigured)
    assert not issubclass(e.AgentNotConfigured, e.ProviderAuthenticationFailed)
    # Not an `AuthenticationFailed` either: the *caller's* session is fine, and routing them to
    # sign-in over a secret of ours would be the wrong remedy offered to the wrong person.
    assert not issubclass(e.ProviderAuthenticationFailed, e.AuthenticationFailed)


def test_horizon_and_coverage_errors_are_validation_failures() -> None:
    assert issubclass(e.UnsupportedHorizon, e.ValidationFailed)
    assert issubclass(e.RangeOutsideCoverage, e.ValidationFailed)
    assert issubclass(e.ProviderNotFound, e.ValidationFailed)


def test_repr_carries_the_code_and_no_stack_material() -> None:
    rendered = repr(e.ProviderTimeout("Open-Meteo did not respond within 10s."))
    assert "provider_timeout" in rendered
    assert "Traceback" not in rendered


def test_domain_errors_know_nothing_about_http() -> None:
    """Decision 16: nothing below api/ knows about HTTP. The status mapping lives in api/errors."""
    source = __import__("pathlib").Path(e.__file__).read_text()
    for forbidden in ("status_code", "HTTPException", "starlette", "fastapi"):
        assert forbidden not in source
    for error_class in e.all_error_classes():
        assert not hasattr(error_class, "status_code")
