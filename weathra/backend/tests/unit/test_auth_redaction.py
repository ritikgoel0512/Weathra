"""Task 4.7 — token material stays out of logs and error bodies."""

from __future__ import annotations

import logging

import pytest

from tests.auth_support import TokenFactory
from weathra.redaction import PLACEHOLDER, RedactingFilter, install_redaction, redact

SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.c2VydmljZV9yb2xl.c2lnbmF0dXJl"


@pytest.mark.parametrize(
    "message",
    [
        "validating eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl now",
        "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl",
        f"service key {SERVICE_ROLE_KEY}",
    ],
)
def test_a_compact_token_is_redacted(message: str) -> None:
    cleaned = redact(message)
    assert "eyJ" not in cleaned
    assert PLACEHOLDER in cleaned


def test_a_bearer_value_that_is_not_a_token_is_still_redacted() -> None:
    cleaned = redact("Authorization: Bearer sbp_1234567890abcdef")
    assert "sbp_1234567890abcdef" not in cleaned
    assert PLACEHOLDER in cleaned


@pytest.mark.parametrize(
    "message",
    [
        "access_token=abc123def456",
        'refresh_token: "abc123def456"',
        "SUPABASE_SERVICE_ROLE_KEY=abc123def456",
        "api_key = abc123def456",
        "password='abc123def456'",
        "secret: abc123def456",
    ],
)
def test_a_named_secret_is_redacted(message: str) -> None:
    assert "abc123def456" not in redact(message)


def test_a_connection_string_password_is_redacted() -> None:
    cleaned = redact("postgresql+asyncpg://weathra_request:sup3rs3cret@db.example:5432/postgres")
    assert "sup3rs3cret" not in cleaned
    assert "weathra_request" in cleaned, "the user is diagnostic; only the password is a secret"
    assert "db.example" in cleaned


def test_ordinary_text_is_left_alone() -> None:
    message = "forecast for Berlin retrieved from open-meteo in 214ms (cache miss)"
    assert redact(message) == message


def test_the_reason_survives_redaction() -> None:
    """The point is a diagnosable log, not a blank one."""
    cleaned = redact(
        "authentication failed: token_expired (The access token has expired.) on /api/v1/me"
    )
    assert "token_expired" in cleaned
    assert "/api/v1/me" in cleaned


def test_an_empty_string_is_handled() -> None:
    assert redact("") == ""


# --------------------------------------------------------------------------- the log filter


def _record(message: str, *args: object, **extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="weathra.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args or None,
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_the_filter_redacts_the_message(token_factory: TokenFactory) -> None:
    token = token_factory.valid()
    record = _record(f"received {token}")
    assert RedactingFilter().filter(record) is True
    assert token not in record.getMessage()


def test_the_filter_redacts_positional_arguments(token_factory: TokenFactory) -> None:
    token = token_factory.valid()
    record = _record("received %s for %s", token, "/api/v1/me")
    RedactingFilter().filter(record)
    rendered = record.getMessage()
    assert token not in rendered
    assert "/api/v1/me" in rendered


def test_the_filter_redacts_mapping_arguments(token_factory: TokenFactory) -> None:
    token = token_factory.valid()
    record = _record("received %(token)s", **{})
    record.args = {"token": token}
    RedactingFilter().filter(record)
    assert token not in record.getMessage()


def test_the_filter_redacts_structured_extras(token_factory: TokenFactory) -> None:
    token = token_factory.valid()
    record = _record("authentication failed", reason=f"bad token {token}")
    RedactingFilter().filter(record)
    assert token not in record.reason  # type: ignore[attr-defined]


def test_the_filter_leaves_non_string_arguments_alone() -> None:
    record = _record("took %d ms across %d retries", 214, 2)
    RedactingFilter().filter(record)
    assert record.getMessage() == "took 214 ms across 2 retries"


def test_installing_the_filter_is_idempotent() -> None:
    logger = logging.getLogger("weathra.test.redaction.install")
    try:
        first = install_redaction(logger)
        second = install_redaction(logger)
        assert first is second
        assert sum(isinstance(f, RedactingFilter) for f in logger.filters) == 1
    finally:
        logger.filters.clear()


def test_a_token_logged_through_a_filtered_logger_does_not_reach_the_handler(
    token_factory: TokenFactory, caplog: pytest.LogCaptureFixture
) -> None:
    """The backstop, end to end: even a careless call site cannot log a credential."""
    token = token_factory.valid()
    logger = logging.getLogger("weathra.test.redaction.end_to_end")
    install_redaction(logger)
    try:
        with caplog.at_level(logging.INFO, logger=logger.name):
            logger.info("careless: %s", token)
        assert caplog.records
        assert all(token not in record.getMessage() for record in caplog.records)
    finally:
        logger.filters.clear()
