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
from weathra.api.routers.admin.deps import administrative_db, administrative_request_db
from weathra.config import Settings

ADMIN_PREFIX = "/api/v1/admin"

# The reads that aggregate across people. `0016` left them on the privileged connection — which is
# to say broken in production — because an administrative *policy* on a user-owned table would
# grant an administrator other people's rows, which `specs/authentication` forbids. `0018` answers
# that without a policy: the crossing happens inside administrator-gated `SECURITY DEFINER`
# functions that return measures and the six columns of a principal listing, so these four now run
# on the request connection like every other administrative read. See the test at the bottom.
AGGREGATE_READS = frozenset(
    {
        f"{ADMIN_PREFIX}/usage",
        f"{ADMIN_PREFIX}/usage/series",
        f"{ADMIN_PREFIX}/principals",
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
        if "GET" not in (route.methods or set()):
            continue
        dependencies = _dependency_callables(route)
        if administrative_db in dependencies:
            offences.append(f"GET {path} opens the privileged connection")
        elif administrative_request_db not in dependencies:
            offences.append(f"GET {path} takes neither administrative session")

    assert not offences, "administrative reads that cannot work in production:\n  " + "\n  ".join(
        offences
    )


def test_every_administrative_read_is_still_behind_the_role() -> None:
    """Moving off the privileged connection must not have moved the refusal with it.

    `administrative_request_db` depends on `AdministrativePrincipal`, so the 401 and the 403 are
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
    and `0016` makes all of them reachable behind `weathra_is_administrative()`. The four that read
    across people are covered by the test below.
    """
    route = _get_route(path)
    assert administrative_db not in _dependency_callables(route)
    assert administrative_request_db in _dependency_callables(route)


@pytest.mark.parametrize("path", sorted(AGGREGATE_READS))
def test_the_four_that_read_across_people_run_on_the_request_connection(path: str) -> None:
    """The other four, and the design decision that let them join the rest.

    `/admin/usage` and `/admin/usage/series` aggregate `llm_usage_events`; `/admin/principals` joins
    `profiles` and `user_plans`; `/admin/principals/administrators` reads `admin_roles`. All four
    are user-owned or owner-scoped, and an administrative read *policy* on any of them would let an
    administrator read other people's rows — which `specs/authentication` forbids and
    `test_saas_rls.py::test_a_new_user_owned_table_carries_an_owner_policy` refuses outright.

    `0016` concluded from that they had to keep the privileged connection, and said plainly that
    they therefore kept failing in the request-serving container. `0018` answers the question it
    left open: the crossing happens inside `SECURITY DEFINER` functions that test
    `weathra_is_administrative()` and return only measures — or, for the listings, only the columns
    the screens are specified to show. No policy is added to any table, every owner policy stands,
    and these four run where every other administrative read runs.

    Asserted per path so a regression names the endpoint it broke.
    """
    route = _get_route(path)
    assert administrative_db not in _dependency_callables(route)
    assert administrative_request_db in _dependency_callables(route)


# The administrative writes that run on the request connection, because the screens that invoke
# them run in the container that serves browsers — the one deliberately never given the privileged
# credential. There are two, each with the mechanism that makes it safe named beside it:
#
# * the audited candidate-order confirmation task 34.8 specifies, which `0017` grants as `UPDATE`
#   on `model_policies` and `INSERT` on `admin_audit`, both behind `weathra_is_administrative()`;
# * the plan assignment the plan-management screen makes, which writes a row its caller does not
#   own and therefore goes through `0019`'s administrator-gated `SECURITY DEFINER` function rather
#   than through a policy — `user_plans` gains neither a grant nor a policy from it.
#
# A third entry here is a deliberate act. Everything else keeps the privileged connection, which is
# to say it keeps running somewhere other than this container.
REQUEST_PATH_WRITES = {
    f"{ADMIN_PREFIX}/policies/{{policy_id}}/candidates": "PUT",
    f"{ADMIN_PREFIX}/principals/{{subject_id}}/plan": "PUT",
}


@pytest.mark.parametrize(("path", "method"), sorted(REQUEST_PATH_WRITES.items()))
def test_the_supported_administrative_writes_run_on_the_request_connection(
    path: str, method: str
) -> None:
    """34.5's promotion and 34.7's plan assignment, each in the container it is invoked from."""
    route = next(
        (r for served, r in _admin_routes() if served == path and method in (r.methods or set())),
        None,
    )
    assert route is not None, f"{path} is not a registered {method} route"
    dependencies = _dependency_callables(route)
    assert administrative_request_db in dependencies
    assert administrative_db not in dependencies


def test_every_other_administrative_write_keeps_the_privileged_connection() -> None:
    """Everything else stays out of the request-serving container.

    `0016` and `0017` between them grant the restricted role `SELECT` on the lab and audit tables,
    `UPDATE` on `model_policies` and `INSERT` on `admin_audit` — and nothing more. `0018` and `0019`
    add no grant at all: what they add is four gated functions and one gated write, each of which
    can do exactly the one thing it names. Any *other* write attempted on that session is refused by
    PostgreSQL, so a route that quietly moved onto it would fail in production rather than here.
    This is what makes the list above a deliberate two.
    """
    for path, route in _admin_routes():
        methods = route.methods or set()
        if methods <= {"GET", "HEAD", "OPTIONS"} or path in REQUEST_PATH_WRITES:
            continue
        assert administrative_request_db not in _dependency_callables(route), (
            f"{sorted(methods)} {path} writes on the request session, which may write only the "
            "candidate order, its audit row, and a plan assignment through 0019's function"
        )
