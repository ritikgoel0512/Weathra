"""The committed OpenAPI document matches the application.

Task 20.11 generates the frontend's TypeScript types from `backend/openapi.json`, which makes that
file the contract between the two applications rather than a convenience dump. A stale snapshot
would mean the frontend's types describe an API the backend no longer serves — and nothing would
say so until a screen read a field that is not there any more.

So this test fails the moment the two disagree, and names the one command that fixes it.
"""

from __future__ import annotations

import json

from scripts.dump_openapi import SNAPSHOT, document, render


def test_the_committed_document_is_current() -> None:
    assert SNAPSHOT.is_file(), "backend/openapi.json is missing; run scripts/dump_openapi.py"

    assert SNAPSHOT.read_text() == render(document()), (
        "backend/openapi.json is out of date. Run `python scripts/dump_openapi.py`, then "
        "`npm run api:types` in frontend/, and commit both."
    )


def test_the_document_carries_the_protected_operations_the_frontend_needs() -> None:
    """The generator reads `security` to decide which calls carry a bearer token.

    If FastAPI ever stopped emitting it — a changed dependency, a route registered without the
    principal dependency — the frontend would generate a client that sends no token to a protected
    endpoint and every screen would fail with a 401. Cheap to assert, expensive to discover.
    """
    schema = json.loads(SNAPSHOT.read_text())

    protected = {
        (method.upper(), path)
        for path, operations in schema["paths"].items()
        for method, operation in operations.items()
        if operation.get("security")
    }

    for expected in (
        ("POST", "/api/v1/agent/ask"),
        ("POST", "/api/v1/agent/stream"),
        ("GET", "/api/v1/me"),
        ("GET", "/api/v1/me/preferences"),
        ("GET", "/api/v1/me/locations"),
        ("GET", "/api/v1/threads"),
    ):
        assert expected in protected, f"{expected[0]} {expected[1]} is not marked protected"

    assert ("GET", "/api/v1/weather/current") not in protected, (
        "the public weather endpoints must stay reachable without a token"
    )
