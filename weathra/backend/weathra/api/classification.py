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
    "ADMINISTRATIVE_PATHS",
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
    """One endpoint, its access, whether it is administrative, and why.

    ``administrative`` is a second axis rather than a third ``Access``, and the distinction is
    load-bearing. Every administrative endpoint is *also* protected — it requires a validated token
    before it requires a role — and collapsing the two into one enum would let a reader believe an
    "administrative" endpoint might not be protected, or that the 401 and the 403 are the same
    refusal. `specs/http-api` asks for exactly this pairing: "classified as protected and
    administrative".
    """

    path: str
    access: Access
    reason: str
    administrative: bool = False


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
    EndpointClassification(
        "/weather/scenario",
        Access.PUBLIC,
        "Stated assumptions applied to a real forecast. Hypothetical, and labelled so.",
    ),
    # ------------------------------------------ protected: writes the shared snapshot history
    EndpointClassification(
        "/travel/intelligence",
        Access.PROTECTED,
        "One trip analysed from a single forecast retrieval. Records that retrieval in the shared "
        "snapshot history so a later trip can say what moved, which is the same reason "
        "/weather/changes is not public.",
    ),
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
        "/me/watches",
        Access.PROTECTED,
        "Lists and creates the acting user's weather watches.",
    ),
    EndpointClassification(
        "/me/watches/{watch_id}",
        Access.PROTECTED,
        "Changes or removes one of the acting user's watches.",
    ),
    EndpointClassification(
        "/me/watches/{watch_id}/evaluate",
        Access.PROTECTED,
        "Checks one of the acting user's watches against the current forecast, on request.",
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
    # ---------------------------------------------------- protected *and* administrative
    #
    # Each requires the administrative role held in `admin_roles`, and each says the same thing in
    # its reason: what it administers, so a reader of the published contract knows what the role
    # is for without reading the routers.
    EndpointClassification(
        "/admin/models",
        Access.PROTECTED,
        "Lists and creates model catalog entries.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/models/{catalog_key}",
        Access.PROTECTED,
        "Edits one model catalog entry.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/models/{catalog_key}/enable",
        Access.PROTECTED,
        "Returns a model to resolution.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/models/{catalog_key}/disable",
        Access.PROTECTED,
        "Withdraws a model from resolution, refused for the last one serving a call role.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/policies",
        Access.PROTECTED,
        "Lists and creates model policies.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/policies/{policy_id}/audit",
        Access.PROTECTED,
        "Reads one policy's audit trail, with the comparison runs each change cited.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/policies/{policy_id}/candidates",
        Access.PROTECTED,
        "Re-points a policy's ordered candidate list — a model promotion.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/policies/{policy_id}/fallback",
        Access.PROTECTED,
        "Sets or clears a policy's declared fallback.",
        administrative=True,
    ),
    EndpointClassification(
        "/plans",
        Access.PUBLIC,
        "The subscription tiers and what each allows. A pricing question, not a per-caller one: "
        "no subject is read and the answer is the same signed in or out.",
    ),
    EndpointClassification(
        "/admin/plans",
        Access.PROTECTED,
        "Lists the subscription plans.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/plans/{plan_code}/policies",
        Access.PROTECTED,
        "Re-points a plan at different policies, per call role.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/plans/{plan_code}/allowances",
        Access.PROTECTED,
        "Sets one of a plan's usage allowances.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/allowances",
        Access.PROTECTED,
        "Lists the usage allowances, per plan and for the internal subject.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/allowances/internal",
        Access.PROTECTED,
        "Sets one of the internal allowances that lab, evaluation and administrative traffic "
        "is accounted against.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/principals",
        Access.PROTECTED,
        "Lists the principals and the plan each is on. A subject and a tier; Weathra holds no "
        "contact detail to list.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/principals/administrators",
        Access.PROTECTED,
        "Lists who holds the administrative role and who granted it.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/principals/{subject_id}/plan",
        Access.PROTECTED,
        "Assigns a principal to a subscription plan.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/principals/{subject_id}/role",
        Access.PROTECTED,
        "Grants and revokes the administrative role.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/lab/comparisons",
        Access.PROTECTED,
        "Runs one question or dataset subset across several enabled models, and lists the runs. "
        "Internal usage, bounded, and it changes no policy.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/lab/comparisons/{run_id}",
        Access.PROTECTED,
        "One comparison and its per-model results, readable after a compared model is disabled.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/usage",
        Access.PROTECTED,
        "Aggregate language model usage by model, policy, plan, call role, status and period, "
        "with internal usage separated. Measures only — never a row, and never one person's.",
        administrative=True,
    ),
    EndpointClassification(
        "/admin/usage/series",
        Access.PROTECTED,
        "The same usage measures as a time series over the period, bucketed by hour or day, "
        "with internal usage separated. Measures only — never a row, and never one person's.",
        administrative=True,
    ),
    EndpointClassification(
        "/evidence",
        Access.PROTECTED,
        "The acting user's own stored evidence records, newest first. Owner-scoped in the query "
        "and by Row Level Security behind it; a caller sees their rows or none.",
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
ADMINISTRATIVE_PATHS: tuple[str, ...] = tuple(
    entry.path for entry in _CLASSIFICATIONS if entry.administrative
)


def classifications() -> tuple[EndpointClassification, ...]:
    return _CLASSIFICATIONS


def classification_for(path: str) -> EndpointClassification | None:
    """The classification of one path, with the version prefix already stripped."""
    for entry in _CLASSIFICATIONS:
        if entry.path == path:
            return entry
    return None
