"""Which endpoints are public and which are protected, declared in exactly one place.

``specs/authentication`` and ``specs/http-api`` both require every endpoint to be *explicitly*
classified, the classification to be documented, and public endpoints to be limited to those
serving no user-owned data. A classification spread across fifteen route decorators is a
classification nobody can read and a test cannot check, so it lives here as data.

The list is the authority in three directions at once:

* the **routers** attach ``require_principal`` to a protected route and ``optional_principal`` to
  a public one, and the completeness test asserts the wiring matches this table;
* the **OpenAPI schema** gets its security metadata from it, so the documented classification and
  the enforced one cannot drift;
* the **tests** enumerate it, so an endpoint added without a classification fails rather than
  quietly defaulting to whichever is more permissive.

**Why public is the shorter list, and what "public" means.** A public endpoint takes parameters and
returns weather. It reads no user-owned row — with exactly one exception, which the spec names:
when a caller happens to be signed in, their unit preference applies. That is why public routes use
``optional_principal`` rather than no principal at all, and why the exception is worth stating out
loud rather than leaving as an oddity in the code.
"""

from __future__ import annotations

from enum import StrEnum
from typing import NamedTuple

__all__ = [
    "PROTECTED_PATHS",
    "PUBLIC_PATHS",
    "Access",
    "EndpointClassification",
    "classification_for",
    "classifications",
]


class Access(StrEnum):
    """The two kinds of endpoint. There is no third."""

    PUBLIC = "public"
    PROTECTED = "protected"


class EndpointClassification(NamedTuple):
    """One endpoint, its access, and why it is classified that way."""

    path: str
    access: Access
    reason: str


# Paths are relative to the version prefix, which is configuration. Written without it so a
# deployment that changes the prefix does not change the classification.
_CLASSIFICATIONS: tuple[EndpointClassification, ...] = (
    # ---------------------------------------------------------------- public: no user-owned data
    EndpointClassification(
        "/health",
        Access.PUBLIC,
        "Liveness. A load balancer cannot present a token.",
    ),
    EndpointClassification(
        "/ready",
        Access.PUBLIC,
        "Readiness. Reports what is configured and reachable, and no credential material.",
    ),
    EndpointClassification(
        "/locations/search",
        Access.PUBLIC,
        "Geocoding a free-text query. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/locations/resolve",
        Access.PUBLIC,
        "Resolving one place from a name or coordinates. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/current",
        Access.PUBLIC,
        "Current conditions for supplied parameters. Applies the caller's units when signed in.",
    ),
    EndpointClassification(
        "/weather/forecast",
        Access.PUBLIC,
        "A forecast for supplied parameters. Applies the caller's units when signed in.",
    ),
    EndpointClassification(
        "/weather/history",
        Access.PUBLIC,
        "Archive observations for a supplied range. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/history/comparison",
        Access.PUBLIC,
        "Compares two supplied past periods. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/history/baseline",
        Access.PUBLIC,
        "A baseline over supplied years. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/history/baseline/comparison",
        Access.PUBLIC,
        "Places a supplied past period against its baseline. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/analysis",
        Access.PUBLIC,
        "Deterministic analytics over a supplied window. Reads no user-owned row.",
    ),
    EndpointClassification(
        "/weather/comparison",
        Access.PUBLIC,
        "Ranking supplied candidates. Reads no user-owned row.",
    ),
    # ------------------------------------------ protected: writes the shared snapshot history
    EndpointClassification(
        "/weather/changes",
        Access.PROTECTED,
        "Forecast movement since the last snapshot. Records the retrieval it compares, and is not "
        "one of the endpoints specs/http-api admits to the public surface.",
    ),
    # ---------------------------------------------------------------- protected: user-owned data
    EndpointClassification(
        "/agent/ask",
        Access.PROTECTED,
        "Uses and writes the acting user's thread memory and stores an owned evidence record.",
    ),
    EndpointClassification(
        "/agent/stream",
        Access.PROTECTED,
        "The same run, streamed. Same memory and same owned record.",
    ),
    EndpointClassification(
        "/me",
        Access.PROTECTED,
        "The acting user's own profile and effective preferences.",
    ),
    EndpointClassification(
        "/me/preferences",
        Access.PROTECTED,
        "Reads, updates, and deletes the acting user's preferences.",
    ),
    EndpointClassification(
        "/me/locations",
        Access.PROTECTED,
        "Lists and adds the acting user's saved locations.",
    ),
    EndpointClassification(
        "/me/locations/{saved_id}",
        Access.PROTECTED,
        "Removes one of the acting user's saved locations.",
    ),
    EndpointClassification(
        "/me/usage",
        Access.PROTECTED,
        "The acting user's own plan, allowances and consumption. No other subject's, and no "
        "internal usage.",
    ),
    EndpointClassification(
        "/me/data",
        Access.PROTECTED,
        "Deletes the acting user's Weathra application data.",
    ),
    EndpointClassification(
        "/evidence/{evidence_id}",
        Access.PROTECTED,
        "One of the acting user's stored evidence records.",
    ),
    EndpointClassification(
        "/threads",
        Access.PROTECTED,
        "The acting user's conversation threads.",
    ),
    EndpointClassification(
        "/threads/{thread_id}",
        Access.PROTECTED,
        "One of the acting user's threads, and its deletion.",
    ),
)

PUBLIC_PATHS: tuple[str, ...] = tuple(
    entry.path for entry in _CLASSIFICATIONS if entry.access is Access.PUBLIC
)
PROTECTED_PATHS: tuple[str, ...] = tuple(
    entry.path for entry in _CLASSIFICATIONS if entry.access is Access.PROTECTED
)


def classifications() -> tuple[EndpointClassification, ...]:
    return _CLASSIFICATIONS


def classification_for(path: str) -> EndpointClassification | None:
    """The classification of one path, with the version prefix already stripped."""
    for entry in _CLASSIFICATIONS:
        if entry.path == path:
            return entry
    return None
