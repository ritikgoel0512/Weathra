"""Tasks 8.6 and 8.7 against a real PostgreSQL — snapshot capture and What Changed?.

These need a database rather than a double for two reasons that are the point of the feature: the
snapshot table's *absence* of a user column is a schema fact, and "one user's request benefits
another user's What Changed?" is only meaningful with two different principals writing and reading
the same shared rows.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests import factories as f
from tests.db_support import claims_for, new_user_id
from weathra.auth.rls import administrative_session, session_for
from weathra.db.engine import Engines
from weathra.domain.identity import Principal
from weathra.domain.weather import Forecast, Measure
from weathra.weather.snapshots import (
    CHANGED_MEASURES,
    capture,
    compare_with_previous,
    previous_snapshot,
)

pytestmark = [pytest.mark.db, pytest.mark.usefixtures("clean_database")]


def principal_for(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


def forecast_at(
    retrieved_at: datetime,
    *,
    maxima: list[float | None] | None = None,
    minima: list[float | None] | None = None,
    rain: list[float | None] | None = None,
) -> Forecast:
    """A 3-day forecast for Berlin, retrieved at a given instant."""
    return f.forecast(
        daily=f.series(
            {
                Measure.TEMPERATURE_MAX: maxima or [12.0, 14.0, 16.0],
                Measure.TEMPERATURE_MIN: minima or [4.0, 5.0, 6.0],
                Measure.PRECIPITATION_SUM: rain or [0.0, 1.0, 2.0],
            }
        ),
        horizon_days=3,
        retrieved_at=retrieved_at,
    )


BASE = datetime(2026, 3, 1, 6, 0, tzinfo=UTC)


# =========================================================================== 8.6 capture


async def test_a_snapshot_is_written_on_retrieval(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        result = await capture(session, forecast_at(BASE))

    assert result.stored is True
    assert result.snapshot_id

    async with administrative_session(engines) as admin:
        assert await admin.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 1


async def test_a_snapshot_carries_no_user_column_at_all(engines: Engines) -> None:
    """The one table in the schema that deliberately has no owner."""
    async with administrative_session(engines) as admin:
        columns = {
            row[0]
            for row in await admin.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'forecast_snapshots'"
                )
            )
        }
    assert "user_id" not in columns
    assert {"location_id", "window_start", "window_end", "provider", "retrieved_at"} <= columns


async def test_a_snapshot_records_its_location_window_provider_and_units(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    forecast = forecast_at(BASE)
    async with session_for(engines, actor) as session:
        await capture(session, forecast)

    async with administrative_session(engines) as admin:
        row = (
            await admin.execute(
                text(
                    "SELECT location_id, provider, unit_system, retrieved_at "
                    "FROM forecast_snapshots"
                )
            )
        ).one()
    location_id, provider, unit_system, retrieved_at = row
    assert location_id == f.BERLIN.identifier
    assert provider == "open-meteo"
    assert unit_system == "metric"
    assert retrieved_at.replace(tzinfo=UTC) == BASE


def unstorable_forecast() -> Forecast:
    """A forecast the database will refuse: `provider` is a VARCHAR(64).

    A real storage failure rather than a mocked one, so the savepoint is what is actually being
    tested — and so the test would fail if `capture` merely caught the exception without
    containing it.
    """
    return forecast_at(BASE).model_copy(update={"provider": "x" * 200})


async def test_a_storage_failure_does_not_fail_the_retrieval(engines: Engines) -> None:
    """specs/forecast-analysis: the forecast is still returned, and the failure is logged.

    The surrounding transaction must survive: the request that triggered the snapshot has its own
    work to commit, and a bookkeeping write cannot be allowed to abort it.
    """
    actor = principal_for(new_user_id())

    async with session_for(engines, actor) as session:
        result = await capture(session, unstorable_forecast())

        assert result.stored is False
        assert result.reason is not None
        assert "snapshot storage failed" in result.reason

        # The transaction is still usable — this is the part a bare try/except would fail.
        assert await session.scalar(text("SELECT 1")) == 1

    async with administrative_session(engines) as admin:
        assert await admin.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 0


async def test_a_good_snapshot_still_commits_after_a_failed_one(engines: Engines) -> None:
    """The savepoint contains the failure rather than poisoning what follows."""
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        assert (await capture(session, unstorable_forecast())).stored is False
        assert (await capture(session, forecast_at(BASE))).stored is True

    async with administrative_session(engines) as admin:
        assert await admin.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 1


async def test_a_capture_failure_is_logged_with_no_stack_escaping(
    engines: Engines, caplog: pytest.LogCaptureFixture
) -> None:
    actor = principal_for(new_user_id())
    with caplog.at_level("WARNING", logger="weathra.weather.snapshots"):
        async with session_for(engines, actor) as session:
            await capture(session, unstorable_forecast())

    messages = [record.getMessage() for record in caplog.records]
    assert any("snapshot capture failed" in message for message in messages)
    assert not any("Traceback" in message for message in messages)


# =========================================================================== 8.7 What Changed?


async def test_no_prior_snapshot_is_stated_plainly(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, forecast_at(BASE))

    assert changed.comparison_available is False
    assert changed.changes == ()
    assert changed.previous_retrieved_at is None
    assert "nothing to compare against yet" in changed.statement
    assert "not a change" in changed.statement


async def test_forecast_movement_is_reported_per_day_with_both_retrieval_times(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    earlier = forecast_at(BASE, maxima=[12.0, 14.0, 16.0], rain=[0.0, 1.0, 2.0])
    later = forecast_at(BASE + timedelta(hours=6), maxima=[15.0, 14.2, 11.0], rain=[0.0, 4.0, 2.0])

    async with session_for(engines, actor) as session:
        await capture(session, earlier)

    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, later)

    assert changed.comparison_available is True
    assert changed.previous_retrieved_at == BASE
    assert changed.current_retrieved_at == BASE + timedelta(hours=6)

    by_key = {(change.local_date, change.measure): change for change in changed.changes}
    first_day = sorted({date for date, _ in by_key})[0]
    warmer = by_key[(first_day, Measure.TEMPERATURE_MAX)]
    assert warmer.change == pytest.approx(3.0)
    assert warmer.material is True
    assert "+3" in warmer.statement


async def test_immaterial_movement_is_reported_as_unchanged(engines: Engines) -> None:
    """0.2 °C is not news, and the statement says which margin it was measured against."""
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(session, forecast_at(BASE, maxima=[12.0, 14.0, 16.0]))

    later = forecast_at(BASE + timedelta(hours=3), maxima=[12.2, 14.1, 15.9])
    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, later)

    temperature = [
        change for change in changed.changes if change.measure is Measure.TEMPERATURE_MAX
    ]
    assert temperature
    assert all(change.material is False for change in temperature)
    assert all("unchanged" in change.statement for change in temperature)
    assert "unchanged since" in changed.statement


async def test_one_users_request_benefits_another_users_what_changed(
    engines: Engines,
) -> None:
    """The coverage argument for keying snapshots by location rather than by requester."""
    first = principal_for(new_user_id())
    second = principal_for(new_user_id())

    async with session_for(engines, first) as session:
        result = await capture(session, forecast_at(BASE, maxima=[12.0, 14.0, 16.0]))
    assert result.stored is True

    later = forecast_at(BASE + timedelta(hours=6), maxima=[18.0, 14.0, 16.0])
    async with session_for(engines, second) as session:
        changed = await compare_with_previous(session, later)

    assert changed.comparison_available is True, (
        "a snapshot captured for one user was invisible to another"
    )
    assert changed.previous_retrieved_at == BASE


async def test_only_a_strictly_earlier_snapshot_is_compared_against(
    engines: Engines,
) -> None:
    """Comparing a snapshot against itself would report no change and imply a second check."""
    actor = principal_for(new_user_id())
    forecast = forecast_at(BASE)

    async with session_for(engines, actor) as session:
        await capture(session, forecast)

    async with session_for(engines, actor) as session:
        assert await previous_snapshot(session, forecast) is None
        changed = await compare_with_previous(session, forecast)
    assert changed.comparison_available is False


async def test_the_most_recent_earlier_snapshot_wins(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(session, forecast_at(BASE, maxima=[5.0, 5.0, 5.0]))
        await capture(session, forecast_at(BASE + timedelta(hours=2), maxima=[10.0, 10.0, 10.0]))

    later = forecast_at(BASE + timedelta(hours=4), maxima=[12.0, 10.0, 10.0])
    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, later)

    assert changed.previous_retrieved_at == BASE + timedelta(hours=2)
    first_day = min(change.local_date for change in changed.changes)
    warmer = next(
        change
        for change in changed.changes
        if change.local_date == first_day and change.measure is Measure.TEMPERATURE_MAX
    )
    assert warmer.previous == 10.0


async def test_a_different_window_is_not_compared_against(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(
            session,
            f.forecast(
                daily=f.series({Measure.TEMPERATURE_MAX: [12.0] * 7}),
                horizon_days=7,
                retrieved_at=BASE,
            ),
        )

    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, forecast_at(BASE + timedelta(hours=6)))
    assert changed.comparison_available is False


async def test_a_different_unit_system_is_not_compared_against(engines: Engines) -> None:
    """Comparing 12 °C against 54 °F would report a 42-degree jump."""
    from weathra.domain.weather import UnitSystem

    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(
            session,
            f.forecast(
                daily=f.series(
                    {Measure.TEMPERATURE_MAX: [54.0, 57.0, 61.0]}, unit_system=UnitSystem.IMPERIAL
                ),
                unit_system=UnitSystem.IMPERIAL,
                horizon_days=3,
                retrieved_at=BASE,
            ),
        )

    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, forecast_at(BASE + timedelta(hours=6)))
    assert changed.comparison_available is False


async def test_days_are_matched_by_local_date_rather_than_by_position(
    engines: Engines,
) -> None:
    """Two retrievals of "the next 3 days" either side of local midnight cover shifted windows."""
    actor = principal_for(new_user_id())
    earlier = forecast_at(BASE, maxima=[12.0, 14.0, 16.0])
    async with session_for(engines, actor) as session:
        await capture(session, earlier)

    # Same window, but the second day's value moved. Matching by date pairs 14.0 with 20.0.
    later = forecast_at(BASE + timedelta(hours=6), maxima=[12.0, 20.0, 16.0])
    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, later)

    moved = [
        change
        for change in changed.changes
        if change.measure is Measure.TEMPERATURE_MAX and change.material
    ]
    assert len(moved) == 1
    assert moved[0].previous == 14.0
    assert moved[0].current == 20.0


async def test_an_absent_measure_on_either_side_is_reported_as_uncomparable(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(session, forecast_at(BASE, rain=[0.0, 1.0, 2.0]))

    later = forecast_at(BASE + timedelta(hours=6), rain=[None, 1.0, 2.0])
    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(session, later)

    uncomparable = [
        change
        for change in changed.changes
        if change.measure is Measure.PRECIPITATION_SUM and change.change is None
    ]
    assert uncomparable
    assert "cannot be compared" in uncomparable[0].statement
    assert uncomparable[0].material is False


async def test_every_changed_measure_is_covered(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(session, forecast_at(BASE))

    async with session_for(engines, actor) as session:
        changed = await compare_with_previous(
            session,
            forecast_at(BASE + timedelta(hours=6)),
        )

    assert {change.measure for change in changed.changes} == set(CHANGED_MEASURES)


async def test_the_restricted_role_may_write_a_snapshot(engines: Engines) -> None:
    """Snapshots are shared and append-only for the request path; the grant has to allow it."""
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        current = await session.scalar(text("SELECT current_user"))
        assert current == engines.settings.database_restricted_role
        result = await capture(session, forecast_at(BASE))
    assert result.stored is True


async def test_a_snapshot_row_holds_no_user_identifying_material(
    privileged: AsyncSession, engines: Engines
) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await capture(session, forecast_at(BASE))

    async with administrative_session(engines) as admin:
        rendered = str(
            (await admin.execute(text("SELECT * FROM forecast_snapshots"))).mappings().all()
        )
    assert actor.user_id not in rendered
    assert (actor.email or "@") not in rendered
