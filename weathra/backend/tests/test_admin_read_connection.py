"""Task 34.5 — administrative reads do not need the privileged connection.

**The defect this exists for.** Every administrative endpoint returned 500 in production while
authentication and authorization both succeeded: no 401, no 403, and no handler ever ran. The cause
was one dependency they all shared. ``administrative_db`` opens the *privileged* connection, and the
request-serving container is deliberately never given that credential —
``test_secret_storage.py::test_the_render_service_never_holds_the_privileged_database_url`` asserts
it, and explains that migrations run from GitHub Actions precisely so the browser-facing container
never holds a connection that bypasses Row Level Security. So ``resolve_url`` raised
``DATABASE_URL_PRIVILEGED is not configured`` inside the dependency, every time, for every route.

**Why nothing caught it.** ``test_admin_api.py`` is ``db``-marked, and a ``db`` run has both
credentials. The administrative surface was therefore exercised only in the one environment where
the connection it asked for exists. A test that needs a database cannot notice a variable the
database it is given happens to have.

So this one needs no database. It reads the dependency graph of the registered routes, which is
where the fault actually was, and it fails in the ordinary suite rather than in a ``db`` run.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.routing import APIRoute

from weathra.api.app import build_app
from weathra.api.routers.admin.deps import administrative_db, administrative_read_db
from weathra.config import Settings

ADMIN_PREFIX = "/api/v1/admin"

# The reads that cross from one person's rows to another's. They keep the privileged connection
# because an administrative policy on a user-owned table would grant an administrator access to
# other people's data, which `specs/authentication` forbids. See the test at the bottom of the file.
CROSS_PERSON_READS = frozenset(
    {
        f"{ADMIN_PREFIX}/usage",
        f"{ADMIN_PREFIX}/usage/series",
        f"{ADMIN_PREFIX}/principals",
        # Not cross-person exactly, but the same rule: an administrator enumerating the other
        # administrators is a widening 34.5 does not need, so `admin_roles` keeps its owner policy
        # alone and this endpoint keeps the privileged connection.
        f"{ADMIN_PREFIX}/principals/administrators",
    }
)

# What `render.yaml` gives the web service: the restricted connection, and no privileged one.
PRODUCTION_SHAPED = Settings(
    supabase_url="https://project.supabase.co",
    database_url="postgresql://request_user:pw@db.example.com:5432/postgres",
    cors_allowed_origins="https://weathra-bice.vercel.app",
)


def _routes_with_paths(holder: object, prefix: str = "") -> Iterator[tuple[str, APIRoute]]:
    """Every `APIRoute` under *holder*, with the path it is actually served at.

    FastAPI 0.141 keeps an included router as one `_IncludedRouter` entry rather than flattening
    its routes into `app.routes`, so a single pass over the application finds twenty-one entries
    and none of the endpoints. The router's own routes carry their path relative to the include, and
    the prefix lives on the include context beside them.
    """
    for route in getattr(holder, "routes", ()):
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
            continue
        included = getattr(route, "original_router", None)
        if included is None:
            continue
        context = getattr(route, "include_context", None)
        yield from _routes_with_paths(included, prefix + getattr(context, "prefix", ""))


def _admin_routes() -> Iterator[tuple[str, APIRoute]]:
    for path, route in _routes_with_paths(build_app(PRODUCTION_SHAPED)):
        if path.startswith(ADMIN_PREFIX):
            yield path, route


def _dependency_callables(route: APIRoute) -> set[object]:
    """Every callable in the route's resolved dependency tree."""
    found: set[object] = set()
    pending = list(route.dependant.dependencies)
    while pending:
        dependant = pending.pop()
        if dependant.call is not None:
            found.add(dependant.call)
        pending.extend(dependant.dependencies)
    return found


def test_the_production_configuration_has_no_privileged_connection() -> None:
    """The premise. If this ever changes, the tests below are asserting nothing."""
    assert PRODUCTION_SHAPED.database_url is not None
    assert PRODUCTION_SHAPED.database_url_privileged is None
    assert PRODUCTION_SHAPED.runtime_mode == "request_serving"


def test_every_administrative_read_uses_the_request_connection() -> None:
    """A ``GET`` under ``/admin`` must not depend on the connection this container cannot have."""
    offences: list[str] = []

    for path, route in _admin_routes():
        if "GET" not in (route.methods or set()) or path in CROSS_PERSON_READS:
            continue
        dependencies = _dependency_callables(route)
        if administrative_db in dependencies:
            offences.append(f"GET {path} opens the privileged connection")
        elif administrative_read_db not in dependencies:
            offences.append(f"GET {path} takes neither administrative session")

    assert not offences, "administrative reads that cannot work in production:\n  " + "\n  ".join(
        offences
    )


def test_every_administrative_read_is_still_behind_the_role() -> None:
    """Moving off the privileged connection must not have moved the refusal with it.

    `administrative_read_db` depends on `AdministrativePrincipal`, so the 401 and the 403 are
    produced before a session is opened — exactly as they were. Asserted because the change that
    would break it looks like a simplification: the read session does not *need* the principal for
    authorization, only for its claims, and dropping the annotation would compile.
    """
    from weathra.auth.deps import require_administrator

    for path, route in _admin_routes():
        assert require_administrator in _dependency_callables(route), (
            f"{sorted(route.methods or set())} {path} does not require the administrative role"
        )


def _get_route(path: str) -> APIRoute:
    route = next(
        (r for served, r in _admin_routes() if served == path and "GET" in (r.methods or set())),
        None,
    )
    assert route is not None, f"{path} is not a registered GET route"
    return route


@pytest.mark.parametrize(
    "path",
    [
        f"{ADMIN_PREFIX}/policies",
        f"{ADMIN_PREFIX}/lab/comparisons",
        f"{ADMIN_PREFIX}/models",
        f"{ADMIN_PREFIX}/plans",
    ],
)
def test_each_endpoint_the_browser_reported_as_failing(path: str) -> None:
    """Four of the seven paths observed returning 500 against production, named individually.

    A parametrised list rather than a loop, so a regression names the endpoint it broke. These four
    read operational tables only — the catalog, the policies, the plans and the lab's own records —
    and `0016` makes all of them reachable behind `weathra_is_administrative()`.
    """
    route = _get_route(path)
    assert administrative_db not in _dependency_callables(route)
    assert administrative_read_db in _dependency_callables(route)


@pytest.mark.parametrize(
    "path",
    [
        f"{ADMIN_PREFIX}/usage",
        f"{ADMIN_PREFIX}/usage/series",
        f"{ADMIN_PREFIX}/principals",
        f"{ADMIN_PREFIX}/principals/administrators",
    ],
)
def test_the_three_that_read_across_people_stay_privileged(path: str) -> None:
    """The other three, and why they are not fixed with the rest.

    `/admin/usage` and `/admin/usage/series` aggregate `llm_usage_events`; `/admin/principals` joins
    `profiles` and `user_plans`. All three are user-owned tables, and an administrative read policy
    on one would let an administrator read other people's rows — which `specs/authentication`
    forbids and `test_saas_rls.py::test_a_new_user_owned_table_carries_an_owner_policy` refuses
    outright, rejecting any administrative policy on a user-owned table that does not pin the
    internal subject.

    So they keep the privileged connection, which means they keep failing in the request-serving
    container. That is a blocker stated honestly rather than a policy that quietly widens what an
    administrator can see, and the fix for them is a design decision — an aggregate that returns
    measures and no rows would satisfy both rules, and is not this change.

    Asserted so the state is deliberate: a later change that moves one of these onto the read
    session without answering that question fails here.
    """
    route = _get_route(path)
    assert administrative_db in _dependency_callables(route)
    assert administrative_read_db not in _dependency_callables(route)


def test_every_administrative_write_keeps_the_privileged_connection() -> None:
    """The other half, and the reason this is not simply "stop using the privileged session".

    `0016` grants the restricted role `SELECT` and nothing more, so a write on the read session
    would be refused by PostgreSQL. Writes stay where they were, which is to say they stay out of
    the request-serving container — and `34.5`'s promotion is blocked by that, honestly, rather
    than by a mistake.
    """
    for path, route in _admin_routes():
        methods = route.methods or set()
        if methods <= {"GET", "HEAD", "OPTIONS"}:
            continue
        assert administrative_read_db not in _dependency_callables(route), (
            f"{sorted(methods)} {path} writes on the read session, which cannot write"
        )
