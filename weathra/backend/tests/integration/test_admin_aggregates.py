"""Task 34.7 — the administrative aggregates, on the connection the container actually has.

**The defect.** `0016` moved the administrative reads onto the request connection and left four
behind: `GET /admin/usage`, `GET /admin/usage/series`, `GET /admin/principals` and
`GET /admin/principals/administrators` kept `AdministrativeSession`, which resolves
`DATABASE_URL_PRIVILEGED` — a variable the request-serving container is deliberately never given.
All four therefore returned 500 in production *after* authorization had succeeded, which the
administrative screen drew as "Admin data could not be loaded", "The usage trend could not be
loaded" and a failed plans-and-principals panel. `test_admin_read_connection.py` holds the
dependency-graph half of this and needs no database; this file is the behavioural half.

**What is asserted here, and why each half is necessary.**

* The four endpoints answer, with *real* aggregates across principals — not zeros, and not one
  caller's own rows dressed up as an estate total. A fix that returned an empty aggregate would
  turn every panel green and report an estate with no traffic, which is the one reading an operator
  must never be given by accident.
* An empty estate, and a window with nothing in it, are valid responses rather than internal
  errors. This is the other half of the same requirement: "no red panel" must not be bought by
  pretending there is data.
* The gate holds in the database, not merely in the dependency graph. `0018`'s functions test
  `weathra_is_administrative()` and refuse anybody else, so a handler that ever lost its
  `AdministrativePrincipal` would fail loudly rather than quietly return the estate.
* Nothing user-owned leaks through the new path: no subject in a usage aggregate, no saved
  location, no thread, no watch, and the owner policies on the underlying tables are exactly what
  they were — an ordinary caller, administrator or not, still reads only their own rows.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.api_support import ApiFactory, ApiHarness
from tests.db_support import (
    grant_administrator,
    insert_profile,
    insert_saved_location,
    new_user_id,
    session_as,
)
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.telemetry.aggregate import GROUPINGS

pytestmark = pytest.mark.db

PREFIX = "/api/v1"

# The four the browser reported. Named as one list so a case added below covers all of them, and
# so the matrix cannot drift from the set the fix is about.
AGGREGATE_READS: tuple[str, ...] = (
    "/admin/usage?by=model&days=30",
    "/admin/usage/series?days=30&bucket=day",
    "/admin/principals?limit=100",
    "/admin/principals/administrators",
)


async def administrator(api: ApiHarness) -> str:
    subject = new_user_id()
    await grant_administrator(api.app.state.engines, subject)
    return subject


async def record_usage(
    session: AsyncSession,
    *,
    user_id: str | None,
    model: str,
    plan: str | None,
    when: datetime,
    status: str = "success",
    tokens: int = 120,
) -> None:
    """One recorded model call. Written directly, because what is under test is the *read*.

    ``user_id`` is null for an internal call, which is what the generated ``is_internal`` column
    keys off — the split is the database's, not a flag this helper sets.
    """
    await session.execute(
        text(
            "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
            "gateway_provider, gateway_model, policy_id, plan, call_role, prompt_tokens, "
            "completion_tokens, total_tokens, estimated_cost, cost_currency, latency_ms, status, "
            "failure_class, created_at) VALUES (:e, CAST(:u AS uuid), :k, 'standard-general', "
            "'openrouter', :m, 'balanced', :p, 'synthesis', :pt, :ct, :tt, 0.002, 'USD', 150, "
            ":s, :f, :t)"
        ),
        {
            "e": str(uuid.uuid4()),
            "u": user_id,
            "k": "user" if user_id else "internal",
            "m": model,
            "p": plan,
            "pt": tokens // 2,
            "ct": tokens // 2,
            "tt": tokens,
            "s": status,
            "f": None if status == "success" else "timeout",
            "t": when,
        },
    )


async def two_people_and_an_internal_call(engines: Engines) -> tuple[str, str]:
    """Two principals with recorded usage, plus one internal call. The estate under test."""
    first, second = new_user_id(), new_user_id()
    now = datetime.now(UTC)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        for user_id, plan in ((first, "premium"), (second, "free")):
            await insert_profile(session, user_id)
            await session.execute(
                text("INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), :p)"),
                {"u": user_id, "p": plan},
            )
            await insert_saved_location(session, user_id)

        await record_usage(
            session, user_id=first, model="vendor/big", plan="premium", when=now - timedelta(days=1)
        )
        await record_usage(
            session, user_id=second, model="vendor/small", plan="free", when=now - timedelta(days=2)
        )
        await record_usage(
            session,
            user_id=second,
            model="vendor/small",
            plan="free",
            when=now - timedelta(days=2),
            status="failure",
        )
        # The lab's own traffic. Reported apart from every plan's, never folded into it.
        await record_usage(
            session, user_id=None, model="vendor/small", plan=None, when=now - timedelta(hours=3)
        )

    return first, second


# =========================================================================== the matrix


@pytest.mark.parametrize("path", AGGREGATE_READS)
async def test_an_anonymous_caller_is_refused(
    api_factory: ApiFactory, seeded_reference_data: None, path: str
) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}{path}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_missing"


@pytest.mark.parametrize("path", AGGREGATE_READS)
async def test_an_ordinary_authenticated_caller_is_refused(
    api_factory: ApiFactory, seeded_reference_data: None, path: str
) -> None:
    """403 and not 500, which is the distinction the defect erased: before this fix every caller
    got the same internal error, so a refusal and a broken endpoint looked identical."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}{path}", headers=api.authorize(subject=new_user_id())
        )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize("path", AGGREGATE_READS)
async def test_an_administrator_is_answered(
    api_factory: ApiFactory, seeded_reference_data: None, path: str
) -> None:
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}{path}", headers=api.authorize(subject=await administrator(api))
        )

    assert response.status_code == 200, response.text


# =========================================================================== real data


async def test_usage_by_model_reports_every_principals_calls(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The point of the endpoint: an aggregate over the estate, not over the administrator.

    The administrator here has recorded no call of their own, so a reader that quietly fell back to
    the acting principal's rows would return an empty aggregate — and that is exactly the failure
    an "it returns 200 now" assertion would not catch.
    """
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=model&days=30",
            headers=api.authorize(subject=await administrator(api)),
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["grouped_by"] == "model"

    groups = body["groups"]
    product = {g["group"]: g for g in groups if not g["is_internal"]}
    internal = {g["group"]: g for g in groups if g["is_internal"]}

    assert product["vendor/big"]["calls"] == 1, "the first person's call is missing"
    assert product["vendor/small"]["calls"] == 2, "the second person's calls are missing"
    assert product["vendor/small"]["failures"] == 1
    assert product["vendor/big"]["total_tokens"] == 120
    assert internal["vendor/small"]["calls"] == 1, "internal usage was folded into the product's"


async def test_usage_by_plan_sees_both_tiers(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Plan distribution, which is a cross-person question by construction: one principal is on
    Premium and the other on Free, and an administrator reading their own rows would see neither."""
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=plan&days=30",
            headers=api.authorize(subject=await administrator(api)),
        )

    assert response.status_code == 200, response.text
    plans = {g["group"] for g in response.json()["groups"] if not g["is_internal"]}
    assert plans == {"premium", "free"}


@pytest.mark.parametrize("by", sorted(GROUPINGS))
async def test_every_supported_grouping_is_answered(
    api_factory: ApiFactory, seeded_reference_data: None, by: str
) -> None:
    """`0018`'s allowlist and `GROUPINGS` must be the same list.

    They are two copies of one fact — the dimensions `specs/llm-telemetry` requires — and the
    failure mode of a copy is drift: a dimension the API offers and the function refuses is a 500
    on a control the screen already draws.
    """
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/usage?by={by}&days=30",
            headers=api.authorize(subject=await administrator(api)),
        )

    assert response.status_code == 200, response.text
    assert response.json()["grouped_by"] == by


async def test_the_trend_is_dense_and_carries_the_estate(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A bucket per day of the window, both halves of the internal split, zeros where idle."""
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/usage/series?days=7&bucket=day",
            headers=api.authorize(subject=await administrator(api)),
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["bucket"] == "day"

    # Eight buckets for a seven-day window, not seven: the start is floored to the bucket, the way
    # `date_trunc` floors it, so the partial day the window opens in is a bucket of its own.
    points = body["points"]
    assert len(points) == 2 * 8, "the series is not dense across the requested period"
    assert sum(point["calls"] for point in points if not point["is_internal"]) == 3
    assert sum(point["calls"] for point in points if point["is_internal"]) == 1
    assert any(point["calls"] == 0 for point in points), "an idle bucket was dropped rather than 0"


async def test_an_hour_bucket_is_answered_too(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The short-period control the screen switches to under two days."""
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/usage/series?days=1&bucket=hour",
            headers=api.authorize(subject=await administrator(api)),
        )

    assert response.status_code == 200, response.text
    points = response.json()["points"]
    assert len(points) == 2 * 25, "twenty-four whole hours plus the partial one the window opens in"
    assert sum(point["calls"] for point in points if point["is_internal"]) == 1


async def test_the_principals_listing_carries_everyone_and_their_tier(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Who is on which tier — the plans-and-principals panel's whole content."""
    async with api_factory() as api:
        first, second = await two_people_and_an_internal_call(api.app.state.engines)
        admin = await administrator(api)
        response = await api.client.get(
            f"{PREFIX}/admin/principals?limit=100", headers=api.authorize(subject=admin)
        )

    assert response.status_code == 200, response.text
    body = response.json()
    by_subject = {entry["subject_id"]: entry for entry in body["principals"]}

    assert {first, second} <= set(by_subject), "a principal was missing from the listing"
    assert by_subject[first]["plan_code"] == "premium"
    assert by_subject[second]["plan_code"] == "free"
    assert by_subject[first]["administrative"] is False
    assert body["count"] == len(body["principals"])


async def test_the_administrators_listing_names_the_role_holders(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        admin = await administrator(api)
        response = await api.client.get(
            f"{PREFIX}/admin/principals/administrators", headers=api.authorize(subject=admin)
        )

    assert response.status_code == 200, response.text
    grants = response.json()["grants"]
    assert [grant["subject_id"] for grant in grants] == [admin]
    assert grants[0]["role"] == "administrator"


# =========================================================================== empty data


@pytest.mark.parametrize("path", AGGREGATE_READS)
async def test_an_empty_estate_is_an_empty_answer_rather_than_an_error(
    api_factory: ApiFactory, seeded_reference_data: None, path: str
) -> None:
    """Nothing recorded, nobody but the administrator, and every panel still answers.

    A deployment on its first day is this state, and a 500 here would be indistinguishable from the
    defect being fixed.
    """
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}{path}", headers=api.authorize(subject=await administrator(api))
        )

    assert response.status_code == 200, response.text


async def test_an_empty_period_is_a_series_of_zeros(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Usage exists, but not in the window asked for. The trend is zeros, not an empty response:
    this table records every call, so an empty bucket is an idle period rather than an unobserved
    one, and a chart must be able to draw it as a continuous line."""
    async with api_factory() as api:
        engines = api.app.state.engines
        async with privileged_session(engines.privileged_sessionmaker) as session:
            person = new_user_id()
            await insert_profile(session, person)
            await record_usage(
                session,
                user_id=person,
                model="vendor/big",
                plan="free",
                when=datetime.now(UTC) - timedelta(days=200),
            )

        headers = api.authorize(subject=await administrator(api))
        series = await api.client.get(
            f"{PREFIX}/admin/usage/series?days=7&bucket=day", headers=headers
        )
        summary = await api.client.get(f"{PREFIX}/admin/usage?by=model&days=7", headers=headers)

    assert series.status_code == 200, series.text
    points = series.json()["points"]
    assert len(points) == 2 * 8
    assert all(point["calls"] == 0 for point in points)
    assert all(point["total_tokens"] is None for point in points)

    assert summary.status_code == 200, summary.text
    assert summary.json()["groups"] == []


async def test_an_empty_estate_still_reports_the_window_it_was_asked_about(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The window is the response's own, so a screen showing "last 30 days" over no data is not
    quietly showing a different period."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/admin/usage?by=model&days=7",
            headers=api.authorize(subject=await administrator(api)),
        )

    body = response.json()
    start = datetime.fromisoformat(body["window"]["start"])
    end = datetime.fromisoformat(body["window"]["end"])
    assert timedelta(days=6, hours=23) < end - start < timedelta(days=7, hours=1)


# =========================================================================== the gate


async def test_the_database_refuses_the_aggregate_to_a_caller_without_the_role(
    engines: Engines, clean_database: None
) -> None:
    """The gate is `weathra_is_administrative()`, and it is in the database rather than only in the
    dependency graph.

    Asserted on the session an ordinary request opens, calling the function directly — which is
    what a handler that lost its `AdministrativePrincipal` would amount to. The refusal is
    PostgreSQL's, so it does not depend on any Python check being present.
    """
    ordinary = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, ordinary)

    async with session_as(engines, ordinary) as session:
        for statement, params in (
            ("SELECT * FROM weathra_admin_usage_aggregate('model', NULL, NULL)", {}),
            (
                "SELECT * FROM weathra_admin_usage_series('day', now() - interval '1 day', now())",
                {},
            ),
            ("SELECT * FROM weathra_admin_principals(10)", {}),
            ("SELECT * FROM weathra_admin_administrators('administrator')", {}),
        ):
            with pytest.raises(DBAPIError) as raised:
                await session.execute(text(statement), params)
            assert "administrative role" in str(raised.value)
            await session.rollback()


async def test_a_token_claiming_the_role_does_not_satisfy_the_database_gate(
    engines: Engines, clean_database: None
) -> None:
    """`0011` made the predicate read `admin_roles` rather than a claim, and this is that property
    seen from the new path: a session whose claims assert the role is refused exactly as one that
    does not."""
    claimant = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, claimant)

    async with session_as(engines, claimant, administrative=True) as session:
        with pytest.raises(DBAPIError):
            await session.execute(
                text("SELECT * FROM weathra_admin_usage_aggregate('model', NULL, NULL)")
            )


async def test_the_function_refuses_a_grouping_that_is_not_a_dimension(
    engines: Engines, clean_database: None
) -> None:
    """The allowlist is inside the function as well as in `GROUPINGS`, so a caller that reached the
    database with anything else — `user_id` above all — is refused there too."""
    admin = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, admin)
    await grant_administrator(engines, admin)

    async with session_as(engines, admin) as session:
        with pytest.raises(DBAPIError) as raised:
            await session.execute(
                text("SELECT * FROM weathra_admin_usage_aggregate('user_id', NULL, NULL)")
            )
        assert "aggregation dimension" in str(raised.value)


# =========================================================================== what does not leak


async def test_the_aggregates_carry_no_subject_and_no_personal_row(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """31.5's rule, asserted over the new path: measures leave, rows do not.

    Both principals have a saved location and a plan, and neither subject id nor either location
    appears anywhere in the two usage responses. A grouping that reached `user_id` would fail this
    even though every count in the body would still be correct.
    """
    async with api_factory() as api:
        first, second = await two_people_and_an_internal_call(api.app.state.engines)
        headers = api.authorize(subject=await administrator(api))
        summary = await api.client.get(f"{PREFIX}/admin/usage?by=model&days=30", headers=headers)
        series = await api.client.get(
            f"{PREFIX}/admin/usage/series?days=7&bucket=day", headers=headers
        )

    for response in (summary, series):
        assert response.status_code == 200, response.text
        assert first not in response.text
        assert second not in response.text
        assert "Berlin" not in response.text, "a saved location reached a usage aggregate"
        for field in ("user_id", "subject_id", "request_id", "agent_run_id", "event_id"):
            assert field not in response.text


async def test_the_principals_listing_carries_only_the_permitted_fields(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Subject, tier, assignment and the administrative flag. Nothing else is in this database to
    return, and nothing else is returned."""
    async with api_factory() as api:
        await two_people_and_an_internal_call(api.app.state.engines)
        response = await api.client.get(
            f"{PREFIX}/admin/principals?limit=100",
            headers=api.authorize(subject=await administrator(api)),
        )

    permitted = {
        "subject_id",
        "plan_code",
        "plan_name",
        "assigned_at",
        "assigned_by",
        "administrative",
    }
    for entry in response.json()["principals"]:
        assert set(entry) == permitted
    assert "Berlin" not in response.text


async def test_the_owner_policies_still_scope_an_administrators_own_session(
    engines: Engines, clean_database: None
) -> None:
    """`0018` adds no policy, and this is what that buys: an administrator's ordinary session reads
    their own rows and nobody else's, from every table the aggregates touch.

    So holding the role does not widen what a query on the request path can see — only what the
    four gated functions will compute. `specs/authentication`'s "the administrative role grants no
    access to another user's data" is therefore still true of the tables themselves.
    """
    admin, other = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        for user_id, plan in ((admin, "free"), (other, "premium")):
            await insert_profile(session, user_id)
            await session.execute(
                text("INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), :p)"),
                {"u": user_id, "p": plan},
            )
            await insert_saved_location(session, user_id)
            await record_usage(
                session, user_id=user_id, model="vendor/big", plan=plan, when=datetime.now(UTC)
            )
    await grant_administrator(engines, admin)

    async with session_as(engines, admin) as session:
        events = (await session.execute(text("SELECT user_id FROM llm_usage_events"))).scalars()
        plans = (await session.execute(text("SELECT user_id FROM user_plans"))).scalars()
        locations = (await session.execute(text("SELECT user_id FROM saved_locations"))).scalars()
        roles = (await session.execute(text("SELECT subject_id FROM admin_roles"))).scalars()

        assert {str(row) for row in events} == {admin}
        assert {str(row) for row in plans} == {admin}
        assert {str(row) for row in locations} == {admin}
        assert {str(row) for row in roles} == {admin}


async def test_one_person_still_cannot_read_anothers_records_through_the_api(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The ordinary isolation, re-asserted because this change touched the tables it rests on.

    `/me/usage` is the personal reader that shares its query with the administrative one, so it is
    the place a widening would show up first.
    """
    async with api_factory() as api:
        first, second = await two_people_and_an_internal_call(api.app.state.engines)

        mine: dict[str, Any] = (
            await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=first))
        ).json()
        theirs: dict[str, Any] = (
            await api.client.get(f"{PREFIX}/me/usage", headers=api.authorize(subject=second))
        ).json()

    assert second not in str(mine)
    assert first not in str(theirs)
