"""Weather Watch as a monitored thing: the history, the transitions, and whose they are.

`tests/unit/test_watch_analytics.py` holds the arithmetic. This holds what happens when it is
written down — which is where a monitoring product's real failures live:

* an evaluation that updates the watch but records no history, so "what changed" has nothing to
  compare against and the activity feed stays empty forever;
* a transition written on every pass rather than on every change, so the feed fills with "still not
  met" and buries the one line that mattered;
* a scheduled pass that reads one person's watches while acting as nobody, and therefore either
  sees nothing or — far worse — sees everybody's and writes them back under the wrong owner.

The last of these is the one this file exists for. The pass is privileged by necessity, so its
ownership is not enforced by a policy during the pass; it is enforced by the pass carrying each
watch's own owner into every row it writes, and by the policies then keeping those rows apart when
a *request* reads them back.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.analytics.watch import WatchOutcome, WatchState
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import Measure
from weathra.memory.watch_monitoring import (
    WatchEvidence,
    WatchHistory,
    due_watches,
    record_creation,
    record_evaluation,
)
from weathra.memory.watches import WatchRecord, WatchStore

pytestmark = pytest.mark.db

LONDON = Location(
    display_name="London",
    latitude=51.5072,
    longitude=-0.1276,
    timezone="Europe/London",
    country="United Kingdom",
    country_code="GB",
    region="England",
)
MUNICH = Location(
    display_name="Munich",
    latitude=48.1374,
    longitude=11.5755,
    timezone="Europe/Berlin",
    country="Germany",
    country_code="DE",
    region="Bavaria",
)

AT = datetime(2026, 9, 13, 12, tzinfo=UTC)


def _principal(user_id: str) -> Principal:
    return Principal(user_id=user_id, claims=claims_for(user_id))


def _evidence(value: float | None, *, met: bool | None, threshold: float = 25.0) -> WatchEvidence:
    return WatchEvidence(
        outcome=WatchOutcome(
            measure=Measure.TEMPERATURE,
            comparison="above",
            threshold=threshold,
            unit="°C",
            value=value,
            met=met,
            margin=None if value is None else value - threshold,
        ),
        conditions={} if value is None else {Measure.TEMPERATURE: value},
        units={Measure.TEMPERATURE: "°C"},
    )


async def _watch(
    session: AsyncSession,
    user: str,
    *,
    location: Location = LONDON,
    threshold: float = 25.0,
) -> WatchRecord:
    return await WatchStore(session, _principal(user)).create(
        location=location,
        measure=Measure.TEMPERATURE,
        comparison="above",
        threshold=threshold,
    )


# ------------------------------------------------------------------ the history is written


async def test_an_evaluation_writes_history_as_well_as_state(
    engines: Engines, clean_database: None
) -> None:
    """The watch's own columns are a *reading* of the history, not a substitute for it."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)

        updated, evaluation, _ = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.3, met=True),
            place="London",
            evaluated_at=AT,
            provider="open-meteo",
            retrieved_at=AT,
            next_evaluation_at=AT + timedelta(hours=1),
        )

        stored = await WatchHistory(session, _principal(user)).evaluations(watch.id)

    assert updated.state is WatchState.MET
    assert updated.next_evaluation_at is not None, "the screen's 'next check' figure is real"
    assert len(stored) == 1
    assert stored[0].id == evaluation.id
    # The evidence a screen shows is traceable to one retrieval rather than to whatever the
    # provider happens to say now.
    assert stored[0].provider == "open-meteo"
    assert stored[0].retrieved_at is not None
    assert stored[0].outcome is not None and stored[0].outcome.margin == pytest.approx(1.3)


async def test_a_transition_is_written_once_and_a_repeat_is_written_never(
    engines: Engines, clean_database: None
) -> None:
    """Three passes, one change. A feed that logged every pass would bury the line that mattered."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)

        watch, _, first = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(22.0, met=False),
            place="London",
            evaluated_at=AT,
            provider="open-meteo",
            retrieved_at=AT,
        )
        watch, _, second = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.3, met=True),
            place="London",
            evaluated_at=AT + timedelta(hours=1),
            provider="open-meteo",
            retrieved_at=AT + timedelta(hours=1),
        )
        watch, _, third = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.4, met=True),
            place="London",
            evaluated_at=AT + timedelta(hours=2),
            provider="open-meteo",
            retrieved_at=AT + timedelta(hours=2),
        )

        feed = await WatchHistory(session, _principal(user)).events()

    assert first == (), "a first evaluation has nothing to differ from"
    # Two things changed on that pass and both are true: the condition turned over, and the
    # reading moved 4.3 °C to do it. The transition leads, because it is the consequential one.
    assert [event.event_type for event in second] == ["condition_met", "reading_moved"]
    assert third == (), "still met, and 0.1 °C is under the floor: nothing to say"
    # Both belong to the same instant, so their order within it is the database's business rather
    # than a fact worth asserting; what matters is that three passes produced exactly these two.
    assert sorted(event.event_type for event in feed) == ["condition_met", "reading_moved"]
    assert watch.previous_state is WatchState.MET


async def test_a_watch_carries_its_creation_as_the_first_thing_in_its_feed(
    engines: Engines, clean_database: None
) -> None:
    """A feed whose earliest entry is an evaluation has no beginning."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        await record_creation(session, user_id=user, watch=watch, place="London", at=AT)

        feed = await WatchHistory(session, _principal(user)).events()

    assert [event.event_type for event in feed] == ["watch_created"]
    assert "London" in feed[0].summary
    assert "above 25" in feed[0].summary


async def test_changes_are_counted_as_transitions_rather_than_as_checks(
    engines: Engines, clean_database: None
) -> None:
    """The KPI says "changes detected", so it counts transitions rather than checks."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        for index, (value, met) in enumerate([(22.0, False), (26.3, True), (26.4, True)]):
            watch, _, _ = await record_evaluation(
                session,
                user_id=user,
                watch=watch,
                evidence=_evidence(value, met=met),
                place="London",
                evaluated_at=AT + timedelta(hours=index),
                provider="open-meteo",
                retrieved_at=AT + timedelta(hours=index),
            )

        counted = await WatchHistory(session, _principal(user)).count_events_since(
            AT - timedelta(hours=1)
        )

    # Three checks. The middle one turned the condition over and moved the reading 4.3 °C doing
    # it — two changes — and the third moved 0.1 °C, which is the model landing a hair away and is
    # not one. The figure counts what the activity feed shows, so the two cannot disagree.
    assert counted == 2


async def test_a_degraded_pass_is_recorded_rather_than_skipped(
    engines: Engines, clean_database: None
) -> None:
    """Skipping it would leave the previous state on screen looking current."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        watch, _, _ = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.3, met=True),
            place="London",
            evaluated_at=AT,
            provider="open-meteo",
            retrieved_at=AT,
        )
        watch, evaluation, events = await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(None, met=None),
            place="London",
            evaluated_at=AT + timedelta(hours=1),
            provider=None,
            retrieved_at=None,
            error="Open-Meteo did not respond in time.",
        )

    assert watch.state is WatchState.DEGRADED
    assert watch.last_error == "Open-Meteo did not respond in time."
    assert evaluation.error is not None
    assert [event.event_type for event in events] == ["reading_lost"]


# ------------------------------------------------------------------ the scheduled pass


async def test_the_scheduled_pass_sees_every_owner_and_keeps_them_apart(
    engines: Engines, clean_database: None
) -> None:
    """The pass is privileged, so ownership is carried rather than enforced — then read back apart.

    This is the property the whole design rests on. `due_watches` reaches everybody's rows; what
    stops one person's evaluation landing under another's name is that the owner travels with each
    watch into every row written for it, and the policies then keep them apart on the way back out.
    """
    alice, bob = new_user_id(), new_user_id()
    async with session_as(engines, alice) as session:
        await insert_profile(session, alice)
        await _watch(session, alice, location=LONDON)
    async with session_as(engines, bob) as session:
        await insert_profile(session, bob)
        await _watch(session, bob, location=MUNICH, threshold=30.0)

    # The pass: privileged, and therefore holding both.
    async with privileged_session(engines.privileged_sessionmaker) as session:
        due = await due_watches(session)
        assert {owner for owner, _ in due} == {alice, bob}, "the pass reaches every owner"

        for owner, watch in due:
            await record_evaluation(
                session,
                user_id=owner,
                watch=watch,
                evidence=_evidence(26.3, met=True),
                place=watch.location.display_name,
                evaluated_at=AT,
                provider="open-meteo",
                retrieved_at=AT,
            )

    # And back out through the request path, where the policies apply.
    async with session_as(engines, alice) as session:
        hers = await WatchHistory(session, _principal(alice)).latest_evaluations()
        her_watches = await WatchStore(session, _principal(alice)).list()
    async with session_as(engines, bob) as session:
        his = await WatchHistory(session, _principal(bob)).latest_evaluations()

    assert len(hers) == 1 and len(his) == 1
    assert set(hers) != set(his), "neither can see the other's evaluation"
    assert her_watches[0].location.display_name == "London"
    assert her_watches[0].state is WatchState.MET


async def test_a_recently_checked_watch_is_not_checked_again_in_the_same_window(
    engines: Engines, clean_database: None
) -> None:
    """An overlapping run, a manual dispatch beside a scheduled one, or a retry after a failure."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.3, met=True),
            place="London",
            evaluated_at=AT,
            provider="open-meteo",
            retrieved_at=AT,
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        fresh = await due_watches(session, not_evaluated_since=AT - timedelta(minutes=30))
        stale = await due_watches(session, not_evaluated_since=AT + timedelta(hours=1))

    assert fresh == (), "checked inside the window, so not checked again"
    assert len(stale) == 1, "and due once the window has passed"


async def test_a_paused_watch_is_not_reached_by_the_schedule(
    engines: Engines, clean_database: None
) -> None:
    """A paused watch is one nobody asked about; evaluating it would spend a call to say so."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        store = WatchStore(session, _principal(user))
        paused = await store.update(watch.id, enabled=False)

    assert paused.state is WatchState.PAUSED, "and it reads back as paused, not as its last reading"

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await due_watches(session) == ()


async def test_deleting_a_watch_takes_its_history_with_it(
    engines: Engines, clean_database: None
) -> None:
    """A feed referring to a watch nobody can open is a feed with dangling rows in it."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        watch = await _watch(session, user)
        await record_creation(session, user_id=user, watch=watch, place="London", at=AT)
        await record_evaluation(
            session,
            user_id=user,
            watch=watch,
            evidence=_evidence(26.3, met=True),
            place="London",
            evaluated_at=AT,
            provider="open-meteo",
            retrieved_at=AT,
        )

        await WatchStore(session, _principal(user)).delete(watch.id)

        history = WatchHistory(session, _principal(user))
        assert await history.evaluations(watch.id) == ()
        assert await history.events() == ()
