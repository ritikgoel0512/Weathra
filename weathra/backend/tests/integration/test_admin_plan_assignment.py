"""Task 34.7 — administrative plan assignment, in the container it is invoked from.

**The defect.** ``PUT /api/v1/admin/principals/{subject_id}/plan`` opened ``AdministrativeSession``,
which resolves ``DATABASE_URL_PRIVILEGED`` — a credential the request-serving container is
deliberately never given. Against production-shaped settings that dependency raises
``ValueError: DATABASE_URL_PRIVILEGED is not configured`` before the handler runs, so an
administrator using the plan-management screen saw a 500 after their authorization had succeeded.
It was the last administrative operation in that state; `0016`, `0018` and this change's `0019`
between them account for every other one.

**What this file holds, and what it deliberately does not.** The assignment matrix and the three
properties the change must not break: self-service plan selection, a caller's inability to move
anybody but themselves, and the consumption a tier change must leave alone. The end-to-end
"the next request sees the new allowance" criterion is 31.4's and stays in ``test_admin_api.py``;
this file is about *who* may make the write and *what else* it touches.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from tests.api_support import ApiFactory, ApiHarness
from tests.db_support import grant_administrator, insert_profile, new_user_id, session_as
from weathra.db.engine import Engines
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

PREFIX = "/api/v1"


async def administrator(api: ApiHarness) -> str:
    subject = new_user_id()
    await grant_administrator(api.app.state.engines, subject)
    return subject


async def profiled(api: ApiHarness) -> str:
    """A real, profiled principal — the foreign key `user_plans` needs before anybody assigns."""
    subject = new_user_id()
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        await insert_profile(session, subject)
    return subject


async def plan_of(engines: Engines, subject: str) -> str | None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        return await session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = CAST(:u AS uuid)"),
            {"u": subject},
        )


# =========================================================================== the matrix


async def test_an_anonymous_caller_cannot_assign_a_plan(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        person = await profiled(api)
        response = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan", json={"plan_code": "pro"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_missing"
        assert await plan_of(api.app.state.engines, person) is None


async def test_an_ordinary_caller_cannot_assign_a_plan(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        person = await profiled(api)
        response = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan",
            json={"plan_code": "premium"},
            headers=api.authorize(subject=new_user_id()),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
        assert await plan_of(api.app.state.engines, person) is None


async def test_an_administrator_assigns_a_plan_and_it_persists(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The write itself, read back twice: from the database, and from the screen's own listing."""
    async with api_factory() as api:
        admin = await administrator(api)
        person = await profiled(api)

        response = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan",
            json={"plan_code": "pro"},
            headers=api.authorize(subject=admin),
        )
        assert response.status_code == 200, response.text
        assert response.json()["plan_code"] == "pro"

        stored = await plan_of(api.app.state.engines, person)
        listing = await api.client.get(
            f"{PREFIX}/admin/principals?limit=100", headers=api.authorize(subject=admin)
        )

    assert stored == "pro", "the assignment did not survive the request that made it"
    entry = next(item for item in listing.json()["principals"] if item["subject_id"] == person)
    assert entry["plan_code"] == "pro"
    assert entry["assigned_by"] == admin


async def test_a_reassignment_moves_the_principal_in_both_directions(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Up and back down: the row is re-pointed rather than accumulating, and the audit records
    each move with the tier it came from."""
    async with api_factory() as api:
        admin = await administrator(api)
        person = await profiled(api)
        headers = api.authorize(subject=admin)

        for plan in ("premium", "free"):
            assigned = await api.client.put(
                f"{PREFIX}/admin/principals/{person}/plan",
                json={"plan_code": plan},
                headers=headers,
            )
            assert assigned.status_code == 200, assigned.text

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT before, after FROM admin_audit WHERE action = 'plan_assign' "
                        " AND subject_id = :s ORDER BY created_at"
                    ),
                    {"s": person},
                )
            ).all()
            count = await session.scalar(
                text("SELECT count(*) FROM user_plans WHERE user_id = CAST(:u AS uuid)"),
                {"u": person},
            )

    assert count == 1, "a reassignment wrote a second row rather than re-pointing the first"
    assert [(row[0], row[1]) for row in rows] == [
        (None, {"plan_code": "premium"}),
        ({"plan_code": "premium"}, {"plan_code": "free"}),
    ]


# =========================================================================== the audit


async def test_the_assignment_is_recorded_with_who_made_it_and_what_it_changed(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/authentication` requires an administrative action to be attributed, and this is the
    existing contract rather than a new one: the same `record_change`, the same action, the same
    subject vocabulary. Asserted field by field because "an audit row exists" is not the
    requirement — naming the target, both tiers, the administrator and the time is.
    """
    async with api_factory() as api:
        admin = await administrator(api)
        person = await profiled(api)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), 'free')"
                ),
                {"u": person},
            )

        before_request = datetime.now(UTC)
        assigned = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan",
            json={"plan_code": "premium"},
            headers=api.authorize(subject=admin),
        )
        assert assigned.status_code == 200, assigned.text

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            row = (
                await session.execute(
                    text(
                        "SELECT acting_principal, action, subject_kind, subject_id, before, "
                        "after, created_at FROM admin_audit WHERE action = 'plan_assign'"
                    )
                )
            ).one()

    assert str(row[0]) == admin, "the audit row does not name the administrator who acted"
    assert row[1] == "plan_assign"
    assert row[2] == "user_plan"
    assert row[3] == person
    assert row[4] == {"plan_code": "free"}, "the tier the principal came from was lost"
    assert row[5] == {"plan_code": "premium"}
    assert row[6] >= before_request


# =========================================================================== what stays closed


async def test_an_ordinary_caller_cannot_move_another_person_between_tiers(
    engines: Engines, clean_database: None
) -> None:
    """`0015`'s self-service policies stand exactly as they were: they carry a `WITH CHECK` on the
    acting subject, so a caller writing somebody else's row writes no row at all.

    Asserted on the session a request opens, with the ownership predicate deliberately omitted —
    which is the shape of the mistake a handler makes.
    """
    mover, target = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, mover)
        await insert_profile(session, target)
        await session.execute(
            text("INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), 'free')"),
            {"u": target},
        )

    async with session_as(engines, mover) as session:
        with pytest.raises(DBAPIError) as refused:
            await session.execute(
                text(
                    "INSERT INTO user_plans (user_id, plan_code) "
                    "VALUES (CAST(:u AS uuid), 'premium')"
                ),
                {"u": target},
            )
        assert "row-level security" in str(refused.value)

    async with session_as(engines, mover) as session:
        # The update direction too: the row exists, and the policy returns none of it to update.
        await session.execute(
            text("UPDATE user_plans SET plan_code = 'premium' WHERE user_id = CAST(:u AS uuid)"),
            {"u": target},
        )

    assert await plan_of(engines, target) == "free"


async def test_the_assignment_function_refuses_a_caller_without_the_role(
    engines: Engines, clean_database: None
) -> None:
    """`0019`'s gate, called directly — which is what a handler that lost its
    `AdministrativePrincipal` would amount to. The refusal is PostgreSQL's, so it does not depend
    on a Python check being present, and it is refused for a token that *claims* the role too."""
    caller, target = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, caller)
        await insert_profile(session, target)

    for administrative in (False, True):
        async with session_as(engines, caller, administrative=administrative) as session:
            with pytest.raises(DBAPIError) as refused:
                await session.execute(
                    text("SELECT weathra_admin_assign_plan(:u, 'premium', :by)"),
                    {"u": target, "by": caller},
                )
            assert "administrative role" in str(refused.value)

    assert await plan_of(engines, target) is None


async def test_self_service_plan_selection_still_works(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The other way onto a tier, unchanged. A person moves themselves through `PUT /me/plan`, the
    row records *them* as the assigner, and no administrative role is involved."""
    async with api_factory() as api:
        person = await profiled(api)
        headers = api.authorize(subject=person)

        for plan in ("pro", "premium", "free"):
            chosen = await api.client.put(
                f"{PREFIX}/me/plan", json={"plan_code": plan}, headers=headers
            )
            assert chosen.status_code == 200, chosen.text
            assert chosen.json()["plan_code"] == plan

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            row = (
                await session.execute(
                    text(
                        "SELECT plan_code, assigned_by::text FROM user_plans "
                        " WHERE user_id = CAST(:u AS uuid)"
                    ),
                    {"u": person},
                )
            ).one()

    assert row[0] == "free"
    assert row[1] == person, "a self-selection recorded somebody else as the assigner"


async def test_an_administrative_assignment_does_not_reset_what_was_already_consumed(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A tier is what somebody is allowed, not what they have already done.

    `specs/usage-limits` counts consumption per window regardless of plan, so the counter and the
    recorded events survive the move. `0019`'s function reaches one table, which is what makes this
    true by construction rather than by the assignment remembering not to.
    """
    async with api_factory() as api:
        admin = await administrator(api)
        person = await profiled(api)
        engines = api.app.state.engines

        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                    "VALUES (:u, 'requests_per_day', '2026-09-14', 9)"
                ),
                {"u": person},
            )
            await session.execute(
                text(
                    "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                    "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, "
                    "status) VALUES (:e, CAST(:u AS uuid), 'user', 'standard-general', "
                    "'openrouter', 'vendor/model', 'balanced', 'free', 'synthesis', 120, 'success')"
                ),
                {"e": str(uuid.uuid4()), "u": person},
            )

        assigned = await api.client.put(
            f"{PREFIX}/admin/principals/{person}/plan",
            json={"plan_code": "premium"},
            headers=api.authorize(subject=admin),
        )
        assert assigned.status_code == 200, assigned.text

        async with privileged_session(engines.privileged_sessionmaker) as session:
            consumed = await session.scalar(
                text("SELECT consumed FROM usage_counters WHERE subject = :u"), {"u": person}
            )
            events = await session.scalar(
                text("SELECT count(*) FROM llm_usage_events WHERE user_id = CAST(:u AS uuid)"),
                {"u": person},
            )

    assert consumed == 9, "the assignment reset what the principal had already consumed"
    assert events == 1, "the assignment removed recorded usage history"
