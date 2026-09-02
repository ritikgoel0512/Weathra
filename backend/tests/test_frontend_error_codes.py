"""The frontend's copy of the authentication error codes is complete.

`specs/web-ui` requires an expired session to produce the expired-session state and a return to
sign-in, and *not* to be shown as a data or server error. The frontend decides which of the two a
failure is by its `code`, so it holds a list of the codes that mean "there is no valid session" —
including the ones that arrive as a terminal event mid-stream, where there is no status code to
read.

A copied list rots. This is the test that stops it: add an `AuthenticationFailed` subclass to
`weathra/domain/errors.py` and the frontend's list is incomplete until it names the new code, which
is exactly when somebody should be deciding whether an expiring session mid-question routes to
sign-in.

The backend owns the codes, so the assertion lives here rather than in the frontend's suite, where
it would be reading the backend's source to find out what to expect.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from weathra.domain.errors import AuthenticationFailed, all_error_classes

FRONTEND_ERRORS = Path("frontend") / "lib" / "api" / "errors.ts"

_LIST = re.compile(
    r"AUTHENTICATION_ERROR_CODES:\s*readonly string\[\]\s*=\s*\[(?P<body>.*?)\]", re.DOTALL
)


@pytest.fixture(scope="module")
def declared_codes(repo_root: Path) -> set[str]:
    source = (repo_root / FRONTEND_ERRORS).read_text()
    match = _LIST.search(source)
    assert match is not None, f"AUTHENTICATION_ERROR_CODES is not declared in {FRONTEND_ERRORS}"
    return set(re.findall(r'"([a-z_]+)"', match.group("body")))


def _authentication_codes() -> set[str]:
    return {
        error.code
        for error in all_error_classes()
        if issubclass(error, AuthenticationFailed) and error is not AuthenticationFailed
    } | {AuthenticationFailed.code}


def test_every_authentication_code_is_known_to_the_frontend(declared_codes: set[str]) -> None:
    missing = _authentication_codes() - declared_codes
    assert not missing, (
        f"{FRONTEND_ERRORS} does not name {sorted(missing)}. A session that expires with one of "
        "these would be shown as a data error instead of returning the person to sign-in."
    )


def test_the_frontend_claims_no_code_the_backend_does_not_send(declared_codes: set[str]) -> None:
    """The other direction: a stale code left behind after a rename would route a live failure."""
    every_code = {error.code for error in all_error_classes()}
    invented = declared_codes - every_code
    assert not invented, (
        f"{FRONTEND_ERRORS} names codes the backend does not have: {sorted(invented)}"
    )


def test_the_frontend_treats_no_non_authentication_failure_as_a_session_failure(
    declared_codes: set[str],
) -> None:
    """A budget overrun or an unconfigured agent must not send anyone to sign-in."""
    over_claimed = declared_codes - _authentication_codes()
    assert not over_claimed, (
        f"{FRONTEND_ERRORS} treats {sorted(over_claimed)} as an authentication failure, but the "
        "backend does not."
    )


def test_the_agent_unavailable_code_matches(repo_root: Path) -> None:
    """The Analyst names the missing configuration; every other screen stays usable."""
    from weathra.domain.errors import AgentNotConfigured

    source = (repo_root / FRONTEND_ERRORS).read_text()
    assert f'AGENT_NOT_CONFIGURED_CODE = "{AgentNotConfigured.code}"' in source
