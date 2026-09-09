"""Security metadata in the schema, generated from the one classification table.

``specs/http-api`` requires each endpoint's public/protected classification to appear in the
OpenAPI schema's security metadata — not only in the documentation prose, and not only in the
code. Doing that by hand on every route decorator would be twenty chances for the documented
classification to diverge from the enforced one, so it is derived from
``api/classification.py`` after the routers are mounted.

The result is that the schema, the runtime dependencies, and the tests all read the same table. An
endpoint added without an entry gets no security metadata *and* fails the classification test,
which is the outcome worth designing for: the failure is loud and in the right place.

Each operation also gets its classification in prose, because a person reading the interactive
documentation should not have to know what an empty ``security`` array means.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from weathra.api.classification import Access, classification_for

__all__ = ["BEARER_SCHEME_NAME", "apply_security_metadata"]

logger = logging.getLogger("weathra.api.openapi")

BEARER_SCHEME_NAME = "SupabaseAccessToken"

_SCHEME: dict[str, Any] = {
    "type": "http",
    "scheme": "bearer",
    "bearerFormat": "JWT",
    "description": (
        "A Supabase Auth access token, presented as `Authorization: Bearer <token>`. Weathra "
        "validates the signature against the project's published signing keys and never issues, "
        "stores, or refreshes a credential of its own."
    ),
}


def apply_security_metadata(app: FastAPI, *, prefix: str) -> None:
    """Install a schema generator that stamps each operation with its classification."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema

        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        schema.setdefault("components", {}).setdefault("securitySchemes", {})[
            BEARER_SCHEME_NAME
        ] = _SCHEME

        # No global `security`: a default would make an unclassified endpoint *look* protected
        # while being open, which is the failure mode worth preventing. Every operation says.
        unclassified: list[str] = []

        for path, operations in schema.get("paths", {}).items():
            relative = path[len(prefix) :] if path.startswith(prefix) else path
            entry = classification_for(relative)

            for method, operation in operations.items():
                if method.lower() not in {"get", "post", "put", "patch", "delete"}:
                    continue

                if entry is None:
                    unclassified.append(f"{method.upper()} {path}")
                    continue

                protected = entry.access is Access.PROTECTED
                operation["security"] = [{BEARER_SCHEME_NAME: []}] if protected else []
                operation.setdefault("responses", {})
                if protected:
                    operation["responses"].setdefault(
                        "401",
                        {"description": "No valid access token was presented."},
                    )

                # "**Protected. Administrative.**" — both, in that order, because that is the
                # order a caller meets them: a validated token first, then the role
                # (`specs/http-api`). A single label would leave a reader guessing whether an
                # administrative endpoint also needs authentication.
                labels = entry.access.value.capitalize()
                if entry.administrative:
                    labels = f"{labels}. Administrative"
                classification = (
                    f"**{labels}.** {entry.reason}" if entry.reason else f"**{labels}.**"
                )
                existing = operation.get("description") or ""
                operation["description"] = (
                    f"{classification}\n\n{existing}".strip() if existing else classification
                )

        if unclassified:
            # Logged loudly rather than raised: the schema is generated on request, and a broken
            # docs page is a worse way to learn this than a startup log and a failing test.
            logger.error(
                "these operations have no entry in api/classification.py and carry no security "
                "metadata: %s",
                ", ".join(sorted(unclassified)),
            )

        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]
