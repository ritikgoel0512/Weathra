"""Weather Watch — the conditions one person asked Weathra to check.

Five routes, all owner-scoped by the same mechanism as every other user-owned surface: the request
session carries the validated subject, and the policy on ``weather_watches`` returns nothing to a
query about anybody else. No route takes an owner as a parameter, so there is nothing for a caller
to supply that could name somebody else's watch.

**Evaluated on a schedule, and the response says which one.** A watch is checked by the scheduled
evaluator (`.github/workflows/weather-watch.yml`, hourly), once immediately when it is created, and
again whenever somebody presses refresh. What comes back is the result of the most recent of those,
with the moment attached and the next expected one beside it. "Scheduled" is not "continuous": the
response's ``monitoring_note`` states the cadence in a sentence so a surface cannot quietly imply a
live feed, and there are no alerts of any kind.

**One contract for the whole screen.** ``GET /me/watch-dashboard`` returns the summary, the watched
places, every watch, the selected watch's series and evidence, and the recent activity — together,
from one read. Five panels each fetching their own version of the same data is how two panels come
to disagree about whether a condition is met.

**Not a warning service.** The disclaimer is part of the payload rather than a caption a screen may
forget: an official severe-weather warning comes from a meteorological agency, and this is a
threshold check against one provider's forecast.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.analytics.watch import (
    WatchChange,
    WatchOutcome,
    WatchState,
    changes_between,
    evidence_for,
)
from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import provider_for, resolve_for_saving
from weathra.auth.deps import RequiredPrincipal
from weathra.auth.profiles import ensure_profile
from weathra.domain.location import Location, location_identifier
from weathra.domain.weather import Measure, Series, UnitSystem
from weathra.memory.watch_monitoring import (
    WatchEvaluationRecord,
    WatchEventRecord,
    WatchHistory,
    record_creation,
)
from weathra.memory.watches import WATCHABLE, WatchRecord, WatchStore, now
from weathra.weather.forecast_service import ForecastService
from weathra.weather.watch_evaluator import WATCH_WINDOW_DAYS, evaluate_watches

__all__ = ["router"]

logger = logging.getLogger("weathra.api.watches")

router = APIRouter(tags=["watches"])

WatchId = Annotated[str, Path(min_length=1, max_length=64, description="One of your watches.")]

EVALUATION_NOTE = (
    "Checked on a schedule, when a watch is created, and when you press refresh. Weathra does not "
    "monitor continuously and sends no alerts."
)

DISCLAIMER = (
    "Weather Watch is analytical assistance, not an official severe-weather or emergency warning "
    "service. Always follow your local meteorological agency."
)


class WatchRequest(BaseModel):
    """A place, a measure, a direction and a number."""

    model_config = ConfigDict(extra="forbid")

    location: str | None = None
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    label: str | None = Field(default=None, max_length=200)
    measure: Measure
    comparison: str = Field(description="'above' or 'below'.")
    threshold: float


class WatchEdit(BaseModel):
    """What may be changed about a watch. The place and the measure are its identity."""

    model_config = ConfigDict(extra="forbid")

    comparison: str | None = None
    threshold: float | None = None
    label: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None


class WatchesResponse(BaseModel):
    """Your watches, and how they came to be evaluated."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    watches: tuple[WatchRecord, ...]
    watchable: tuple[str, ...] = Field(
        description="The measures a watch may name — the ones the provider actually reports."
    )
    evaluation_note: str = EVALUATION_NOTE
    disclaimer: str = DISCLAIMER


def _forecasts(
    request: Request, weather: WeatherFor, geocoder: Places, settings: Configuration
) -> ForecastService:
    """The retrieval service a check runs through, with the provider this request resolved to."""
    return ForecastService(
        provider=provider_for(request, weather, None, settings),
        geocoder=geocoder,
        settings=settings,
    )


async def _check(
    request: Request,
    watches: tuple[WatchRecord, ...],
    *,
    principal: RequiredPrincipal,
    session: CurrentSession,
    weather: WeatherFor,
    geocoder: Places,
    settings: Configuration,
) -> tuple[WatchRecord, ...]:
    """Check some watches now, through the same routine the scheduled pass uses.

    The routine is shared deliberately: a refresh that computed state differently from the schedule
    would make "why does it say something else than it did an hour ago" unanswerable. Disabled
    watches are not checked — a paused watch is one nobody asked about.
    """
    enabled = tuple(watch for watch in watches if watch.enabled)
    if not enabled:
        return watches

    results = await evaluate_watches(
        session,
        watches=[(principal.user_id, watch) for watch in enabled],
        forecasts=_forecasts(request, weather, geocoder, settings),
        cadence=timedelta(minutes=settings.watch_cadence_minutes),
    )
    updated = {record.id: record for record, _, _ in results}
    return tuple(updated.get(watch.id, watch) for watch in watches)


@router.get("/me/watches", response_model=WatchesResponse, summary="Your weather watches")
async def list_watches(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
    evaluate: Annotated[
        bool,
        Query(
            description="Check each enabled watch against the current forecast before returning."
        ),
    ] = False,
) -> WatchesResponse:
    """Every watch you have, optionally checked as it is read.

    Evaluation is opt-in rather than automatic because it costs a provider call per watched place,
    and a listing that quietly made ten of them would be a listing nobody could afford to poll.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)
    store = WatchStore(session, principal)

    watches = await store.list()
    if evaluate:
        watches = await _check(
            request,
            watches,
            principal=principal,
            session=session,
            weather=weather,
            geocoder=geocoder,
            settings=settings,
        )

    return WatchesResponse(
        count=len(watches),
        watches=watches,
        watchable=tuple(sorted(measure.value for measure in WATCHABLE)),
    )


@router.post(
    "/me/watches", response_model=WatchRecord, status_code=201, summary="Watch a condition"
)
async def create_watch(
    request: Request,
    body: WatchRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
) -> WatchRecord:
    """Ask Weathra to check a condition at a place, and check it once straight away.

    **The immediate check is the point.** A watch created into `pending` would sit on the screen
    saying nothing at all until the schedule next came round, which for an hourly cadence is up to
    an hour of a product that looks broken. So creation resolves the place, persists the watch,
    records its first event, and evaluates it — and what comes back already has a state, a reading
    and its evidence.

    Asking twice about the same measure at the same place updates the threshold rather than
    refusing: that is a person changing their mind, not an error.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    place = await resolve_for_saving(
        geocoder, location=body.location, latitude=body.latitude, longitude=body.longitude
    )
    watch = await WatchStore(session, principal).create(
        location=place,
        measure=body.measure,
        comparison=body.comparison,
        threshold=body.threshold,
        label=body.label,
    )
    await record_creation(
        session,
        user_id=principal.user_id,
        watch=watch,
        place=(watch.label or "").strip() or watch.location.display_name,
        at=now(),
    )

    checked = await _check(
        request,
        (watch,),
        principal=principal,
        session=session,
        weather=weather,
        geocoder=geocoder,
        settings=settings,
    )
    return checked[0]


@router.patch("/me/watches/{watch_id}", response_model=WatchRecord, summary="Change a watch")
async def update_watch(
    request: Request,
    watch_id: WatchId,
    body: WatchEdit,
    principal: RequiredPrincipal,
    session: CurrentSession,
) -> WatchRecord:
    annotate(request, acting_user_id=principal.user_id)
    return await WatchStore(session, principal).update(
        watch_id,
        comparison=body.comparison,
        threshold=body.threshold,
        label=body.label,
        enabled=body.enabled,
    )


@router.delete("/me/watches/{watch_id}", status_code=204, summary="Remove a watch")
async def remove_watch(
    request: Request,
    watch_id: WatchId,
    principal: RequiredPrincipal,
    session: CurrentSession,
) -> None:
    annotate(request, acting_user_id=principal.user_id)
    await WatchStore(session, principal).delete(watch_id)


@router.post(
    "/me/watches/{watch_id}/evaluate", response_model=WatchRecord, summary="Check a watch now"
)
async def evaluate_one(
    request: Request,
    watch_id: WatchId,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
) -> WatchRecord:
    """Check one watch against the current forecast, now, because somebody asked."""
    annotate(request, acting_user_id=principal.user_id)
    watch = await WatchStore(session, principal).get(watch_id)

    checked = await _check(
        request,
        (watch,),
        principal=principal,
        session=session,
        weather=weather,
        geocoder=geocoder,
        settings=settings,
    )
    return checked[0]


# ============================================================== the screen's one contract


class WatchSummary(BaseModel):
    """The four figures across the top of the screen. Each is counted, none is estimated."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    active_watch_count: int = Field(ge=0, description="Enabled watches. A paused one is not one.")
    monitored_location_count: int = Field(
        ge=0, description="Distinct places those watches are about."
    )
    changes_detected: int = Field(
        ge=0, description="Recorded transitions in the window below. Not evaluations — transitions."
    )
    changes_window_hours: int = Field(ge=1)
    met_count: int = Field(ge=0, description="Watches whose condition held at their last check.")
    last_evaluation_at: datetime | None = None
    next_evaluation_at: datetime | None = Field(
        default=None, description="When the schedule is next expected to reach these watches."
    )
    cadence_minutes: int = Field(ge=1, description="How often the scheduled evaluator runs.")


class WatchedLocation(BaseModel):
    """One place, with what is watched there and what the last retrieval said about it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location_id: str
    location: Location
    watch_count: int = Field(ge=1)
    met_count: int = Field(ge=0)
    state: WatchState = Field(description="The most consequential of its watches' states.")
    conditions: dict[Measure, float] = Field(
        default_factory=dict,
        description="The headline measures at the hour the watches were read from. Real, and "
        "absent where the provider reported nothing.",
    )
    units: dict[Measure, str] = Field(default_factory=dict)
    provider: str | None = None
    last_evaluated_at: datetime | None = None


class WatchDetail(BaseModel):
    """One watch in full: its series, its threshold, why it is where it is, and what moved."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    watch: WatchRecord
    series: Series | None = Field(
        default=None,
        description="The forecast the threshold is drawn against. Absent where retrieval failed.",
    )
    outcome: WatchOutcome | None = None
    evidence: str | None = Field(
        default=None, description="One deterministic sentence. No language model is involved."
    )
    changes: tuple[WatchChange, ...] = Field(
        default=(), description="Deterministic differences from the previous evaluation."
    )
    provider: str | None = None
    retrieved_at: datetime | None = None
    evaluated_at: datetime | None = None
    evaluation_count: int = Field(default=0, ge=0)


class WatchDashboard(BaseModel):
    """Everything the Weather Watch screen draws, from one read of one endpoint."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    summary: WatchSummary
    watched_locations: tuple[WatchedLocation, ...] = ()
    watches: tuple[WatchRecord, ...] = ()
    selected: WatchDetail | None = None
    activity: tuple[WatchEventRecord, ...] = ()
    watchable: tuple[str, ...] = ()
    # Required rather than defaulted, so the contract says they are always sent. A screen that had
    # to cope with an absent safety disclaimer would need its own copy of the sentence, and two
    # copies of a safety sentence is one that can drift.
    monitoring_note: str = Field(description="How often watches are checked, in one sentence.")
    disclaimer: str = Field(description="What Weather Watch is not. Always present.")


# How far back "changes detected" counts. A day, because a watch is checked hourly and a figure
# over a shorter window would spend most of its life at zero while the schedule was between passes.
CHANGES_WINDOW_HOURS = 24

# The order states are ranked in when one place has several watches. A place with anything met is a
# place worth looking at first; a place Weathra could not check is the next most useful thing to
# know, because it is the one state that is about us rather than about the weather.
STATE_RANK: dict[WatchState, int] = {
    WatchState.MET: 0,
    WatchState.DEGRADED: 1,
    WatchState.NO_READING: 2,
    WatchState.NOT_MET: 3,
    WatchState.PENDING: 4,
    WatchState.PAUSED: 5,
}


@router.get(
    "/me/watch-dashboard",
    response_model=WatchDashboard,
    summary="Everything the Weather Watch screen draws",
)
async def watch_dashboard(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
    watch_id: Annotated[
        str | None,
        Query(description="Which watch to detail. Defaults to the most consequential one."),
    ] = None,
) -> WatchDashboard:
    """The whole screen, from the stored history plus one retrieval for the selected watch's plot.

    **It does not evaluate.** Reading a dashboard must not cost a provider call per watch, or
    opening the screen twice would cost twice as much as monitoring does. What is returned is what
    the schedule and the explicit refreshes have already recorded, with each figure's moment
    attached. The one retrieval is the series behind the selected watch's chart, which is the only
    thing on the screen that cannot come from a stored row.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    store = WatchStore(session, principal)
    history = WatchHistory(session, principal)

    watches = await store.list()
    latest = await history.latest_evaluations()
    since = now() - timedelta(hours=CHANGES_WINDOW_HOURS)

    enabled = tuple(watch for watch in watches if watch.enabled)
    evaluated = [watch.last_evaluated_at for watch in watches if watch.last_evaluated_at]
    expected = [watch.next_evaluation_at for watch in enabled if watch.next_evaluation_at]

    summary = WatchSummary(
        active_watch_count=len(enabled),
        monitored_location_count=len({_place_id(watch) for watch in enabled}),
        changes_detected=await history.count_events_since(since),
        changes_window_hours=CHANGES_WINDOW_HOURS,
        met_count=sum(1 for watch in watches if watch.state is WatchState.MET),
        last_evaluation_at=max(evaluated, default=None),
        next_evaluation_at=min(expected, default=None),
        cadence_minutes=settings.watch_cadence_minutes,
    )

    selected = _select(watches, watch_id)
    return WatchDashboard(
        summary=summary,
        watched_locations=_locations(watches, latest),
        watches=watches,
        selected=None
        if selected is None
        else await _detail(
            request,
            selected,
            history=history,
            latest=latest.get(selected.id),
            weather=weather,
            geocoder=geocoder,
            settings=settings,
        ),
        activity=await history.events(limit=20),
        watchable=tuple(sorted(measure.value for measure in WATCHABLE)),
        monitoring_note=EVALUATION_NOTE,
        disclaimer=DISCLAIMER,
    )


def _place_id(watch: WatchRecord) -> str:
    return location_identifier(watch.location.latitude, watch.location.longitude)


def _select(watches: tuple[WatchRecord, ...], requested: str | None) -> WatchRecord | None:
    """Which watch the detail panels are about.

    A named one wins. Otherwise the most consequential: met before degraded before everything else,
    and within a rank the most recently checked, because that is the one whose evidence is freshest.
    A requested id that is not in the listing is not an error — the screen falls back rather than
    failing, since the usual cause is a watch that was deleted in another tab.
    """
    if requested:
        found = next((watch for watch in watches if watch.id == requested), None)
        if found is not None:
            return found

    ranked = sorted(
        watches,
        key=lambda watch: (
            STATE_RANK.get(watch.state, 9),
            -(watch.last_evaluated_at.timestamp() if watch.last_evaluated_at else 0.0),
        ),
    )
    return ranked[0] if ranked else None


def _locations(
    watches: tuple[WatchRecord, ...], latest: dict[str, WatchEvaluationRecord]
) -> tuple[WatchedLocation, ...]:
    """The watched places, each carrying what its own last retrieval said.

    Grouped here rather than in SQL because the grouping key is the rounded place identifier the
    rest of the system uses, and two watches created from "London" and "london, england" must land
    on one card. Ordered by how much attention the place wants.
    """
    grouped: dict[str, list[WatchRecord]] = {}
    for watch in watches:
        grouped.setdefault(_place_id(watch), []).append(watch)

    cards: list[WatchedLocation] = []
    for place_id, members in grouped.items():
        # The freshest evaluation at this place is the one whose conditions the card shows: they
        # are all readings of the same series, so the newest is the least stale.
        evaluations = [found for watch in members if (found := latest.get(watch.id)) is not None]
        newest = max(evaluations, key=lambda entry: entry.evaluated_at, default=None)

        cards.append(
            WatchedLocation(
                location_id=place_id,
                location=members[0].location,
                watch_count=len(members),
                met_count=sum(1 for watch in members if watch.state is WatchState.MET),
                state=min((watch.state for watch in members), key=lambda s: STATE_RANK.get(s, 9)),
                conditions={}
                if newest is None or newest.evidence is None
                else newest.evidence.conditions,
                units={} if newest is None or newest.evidence is None else newest.evidence.units,
                provider=None if newest is None else newest.provider,
                last_evaluated_at=None if newest is None else newest.evaluated_at,
            )
        )

    return tuple(
        sorted(cards, key=lambda card: (STATE_RANK.get(card.state, 9), card.location.display_name))
    )


async def _detail(
    request: Request,
    watch: WatchRecord,
    *,
    history: WatchHistory,
    latest: WatchEvaluationRecord | None,
    weather: WeatherFor,
    geocoder: Places,
    settings: Configuration,
) -> WatchDetail:
    """One watch in full, including the series its threshold is drawn against.

    The series is retrieved rather than stored: a forecast window is a few hundred numbers, storing
    one per evaluation would make the history table an order of magnitude larger than the facts in
    it, and the retrieval is cached. Every *figure* — the reading, the margin, the crossing — comes
    from the stored evaluation, so the chart and the evidence beside it are the same run even when
    the provider has moved on between the evaluation and this read.
    """
    recent = await history.evaluations(watch.id, limit=2)
    previous = recent[1] if len(recent) > 1 else None

    series: Series | None = None
    try:
        retrieved = await _forecasts(request, weather, geocoder, settings).forecast(
            watch.location, days=WATCH_WINDOW_DAYS, unit_system=UnitSystem.METRIC
        )
        series = retrieved.hourly
    except Exception:  # the plot is the one part that may be missing; the figures are stored
        logger.warning("could not retrieve the plot series for watch %s", watch.id)

    outcome = None if latest is None else latest.outcome
    changes: tuple[WatchChange, ...] = ()
    if outcome is not None and previous is not None and previous.outcome is not None:
        changes = changes_between(
            previous=previous.outcome,
            previous_state=previous.state,
            current=outcome,
            current_state=watch.state,
            place=(watch.label or "").strip() or watch.location.display_name,
        )

    return WatchDetail(
        watch=watch,
        series=series,
        outcome=outcome,
        evidence=None
        if outcome is None
        else evidence_for(
            outcome,
            provider=None if latest is None else latest.provider,
            place=(watch.label or "").strip() or watch.location.display_name,
        ),
        changes=changes,
        provider=None if latest is None else latest.provider,
        retrieved_at=None if latest is None else latest.retrieved_at,
        evaluated_at=None if latest is None else latest.evaluated_at,
        evaluation_count=len(recent),
    )
