"""Task 2.4 — the Principal is built only from validated claims and carries no token material."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from weathra.domain.identity import (
    CREDENTIAL_CLAIM_KEYS,
    Principal,
    compose_thread_key,
)

CLAIMS: dict[str, object] = {
    "sub": "11111111-1111-4111-8111-111111111111",
    "email": "person@example.com",
    "email_verified": True,
    "aud": "authenticated",
    "iss": "https://project.supabase.co/auth/v1",
    "exp": 4_102_444_800,
    "role": "authenticated",
}

RAW_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl"


def test_built_from_a_validated_claim_set() -> None:
    principal = Principal.from_claims(CLAIMS)
    assert principal.user_id == CLAIMS["sub"]
    assert principal.email == "person@example.com"
    assert principal.email_verified is True
    assert principal.claim("role") == "authenticated"


def test_a_claim_set_with_no_subject_is_refused() -> None:
    for claims in ({}, {"sub": ""}, {"sub": "   "}, {"sub": 42}, {"email": "a@b.c"}):
        with pytest.raises(ValueError, match="non-empty 'sub' claim"):
            Principal.from_claims(claims)


def test_the_subject_is_stripped() -> None:
    assert Principal.from_claims({"sub": "  abc  "}).user_id == "abc"


def test_email_is_optional_because_a_token_may_not_carry_it() -> None:
    principal = Principal.from_claims({"sub": "abc"})
    assert principal.email is None
    assert principal.email_verified is True


def test_an_unverified_email_claim_is_preserved_for_inspection() -> None:
    assert Principal.from_claims({"sub": "abc", "email_verified": False}).email_verified is False


def test_a_confirmation_timestamp_counts_as_verification() -> None:
    principal = Principal.from_claims({"sub": "abc", "email_confirmed_at": "2026-03-01T12:00:00Z"})
    assert principal.email_verified is True


def test_a_non_string_email_is_dropped_rather_than_coerced() -> None:
    assert Principal.from_claims({"sub": "abc", "email": 12345}).email is None


# --------------------------------------------------------------------- no token material


@pytest.mark.parametrize("key", sorted(CREDENTIAL_CLAIM_KEYS))
def test_credential_bearing_claims_are_refused(key: str) -> None:
    with pytest.raises((ValidationError, ValueError), match="credential material"):
        Principal.from_claims({**CLAIMS, key: RAW_TOKEN})


def test_credential_claim_names_are_matched_case_insensitively() -> None:
    with pytest.raises((ValidationError, ValueError), match="credential material"):
        Principal.from_claims({**CLAIMS, "Access_Token": RAW_TOKEN})


def test_no_field_holds_the_token() -> None:
    principal = Principal.from_claims(CLAIMS)
    serialized = principal.model_dump_json()
    assert RAW_TOKEN not in serialized
    assert "token" not in {name.lower() for name in Principal.model_fields}


def test_extra_fields_cannot_smuggle_a_token_in() -> None:
    with pytest.raises(ValidationError):
        Principal(user_id="abc", access_token=RAW_TOKEN)  # type: ignore[call-arg]


def test_string_and_repr_forms_are_log_safe() -> None:
    """An authentication failure is logged with its reason and never with the token or the email."""
    principal = Principal.from_claims(CLAIMS)
    for rendered in (str(principal), repr(principal)):
        assert principal.user_id in rendered
        assert "person@example.com" not in rendered
        assert RAW_TOKEN not in rendered


# --------------------------------------------------------------------- immutability


def test_a_principal_is_frozen() -> None:
    principal = Principal.from_claims(CLAIMS)
    with pytest.raises(ValidationError):
        principal.user_id = "someone-else"  # type: ignore[misc]


def test_claims_cannot_be_mutated_after_validation() -> None:
    principal = Principal.from_claims(CLAIMS)
    with pytest.raises(TypeError):
        principal.claims["sub"] = "someone-else"  # type: ignore[index]


def test_mutating_the_source_mapping_does_not_change_the_principal() -> None:
    claims = dict(CLAIMS)
    principal = Principal.from_claims(claims)
    claims["sub"] = "someone-else"
    assert principal.user_id == CLAIMS["sub"]


# --------------------------------------------------------------------- ownership helpers


def test_ownership_compares_against_the_subject() -> None:
    principal = Principal.from_claims(CLAIMS)
    assert principal.owns(str(CLAIMS["sub"])) is True
    assert principal.owns("22222222-2222-4222-8222-222222222222") is False
    assert principal.owns(None) is False


def test_a_thread_key_always_contains_the_acting_users_subject() -> None:
    principal = Principal.from_claims(CLAIMS)
    key = principal.thread_key("thread-7")
    assert key == f"{CLAIMS['sub']}:thread-7"
    assert key.startswith(principal.user_id)


def test_a_thread_identifier_may_not_contain_the_separator() -> None:
    """Otherwise a caller could shape an identifier that reads as someone else's owner half."""
    principal = Principal.from_claims(CLAIMS)
    with pytest.raises(ValueError, match="may not contain"):
        principal.thread_key("22222222-2222-4222-8222-222222222222:thread-7")


def test_composing_a_thread_key_requires_both_halves() -> None:
    with pytest.raises(ValueError, match="acting user's subject"):
        compose_thread_key("", "thread-1")
    with pytest.raises(ValueError, match="thread identifier"):
        compose_thread_key("user-1", "")


def test_two_users_cannot_produce_the_same_thread_key_for_one_thread_id() -> None:
    first = Principal.from_claims({"sub": "user-a"})
    second = Principal.from_claims({"sub": "user-b"})
    assert first.thread_key("t1") != second.thread_key("t1")
