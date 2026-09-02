#!/usr/bin/env python3
"""Write the backend's OpenAPI document to `backend/openapi.json`.

The document is the contract between the two applications, and the frontend's TypeScript types are
generated from this file (`frontend/scripts/api-types.ts`). Committing it makes the contract a
reviewable artifact: a pull request that changes a response model shows the change to the wire
format beside the change to the code, and the frontend's generated types move in the same commit.

`tests/test_openapi_snapshot.py` fails when the committed file no longer matches the application,
naming this script. So the snapshot cannot drift silently, and regenerating it is one command:

    python scripts/dump_openapi.py

It reaches nothing: `create_app()` builds the routes and the schema without opening a database
connection, an inference client, or a socket.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = BACKEND_ROOT / "openapi.json"


def document() -> dict[str, Any]:
    """The application's OpenAPI document, built with placeholder configuration.

    A project URL is needed to construct `Settings`; nothing about the schema depends on its value,
    and no credential is needed at all — which is the same property the offline test suite relies
    on.
    """
    os.environ.setdefault("SUPABASE_URL", "https://schema.supabase.co")

    from weathra.api.app import create_app

    schema: dict[str, Any] = create_app().openapi()
    return schema


def render(schema: dict[str, Any]) -> str:
    """Stable JSON: sorted keys and a trailing newline, so a diff shows only real changes."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> int:
    rendered = render(document())
    previous = SNAPSHOT.read_text() if SNAPSHOT.exists() else None
    SNAPSHOT.write_text(rendered)

    if previous == rendered:
        print(f"{SNAPSHOT.name} is unchanged", file=sys.stderr)
    else:
        print(f"wrote {SNAPSHOT}", file=sys.stderr)
        print(
            "The API contract changed. Regenerate the frontend types with "
            "`npm run api:types` in frontend/ and review both diffs together.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
