"""Resolving a request's window to concrete UTC bounds.

Built on ``domain/windows.py``'s primitive, which turns a local calendar day into UTC instants
using the *location's* timezone. This module adds the request-level shapes: a forecast horizon
counted in local days, a past date range, and a calendar period repeated across years for a
baseline.

The rule the whole module exists to hold: **a window is resolved from the location's zone, never
the server's.** "The next 7 days in Reykjavík" starts at midnight in Reykjavík whatever the machine
answering thinks the date is. A day is also not reliably 24 hours long — a DST transition makes one
23 and another 25 — so bounds are computed by asking the zone, not by adding ``timedelta(days=1)``
to an instant.

``today_at`` takes the current instant as an argument rather than reading the clock, so a caller
can be tested and the one clock read in a request lives at its edge.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from weathra.domain.location import Location
from weathra.domain.weather import Period
from weathra.domain.windows import local_day_bounds, period_from_local_dates

__all__ = [
    "baseline_periods",
    "forecast_window",
    "historical_window",
    "local_date_of",
    "today_at",
]


def today_at(location: Location, now: datetime) -> date:
    """The local calendar date at a location, for a given instant.

    The difference matters: at 23:30 UTC on 1 March it is already 2 March in Berlin and still
    1 March in New York. Every "today" in a request path resolves through here.
    """
    return now.astimezone(location.zoneinfo).date()


def local_date_of(location: Location, moment: datetime) -> date:
    """The local calendar date an instant falls on at a location."""
    return moment.astimezone(location.zoneinfo).date()


def forecast_window(location: Location, now: datetime, days: int) -> Period:
    """The next ``days`` local calendar days, starting with today at the location.

    Inclusive of today: "the next 7 days" is today plus the six that follow, which is what a
    provider returns for ``forecast_days=7`` and what a person means.
    """
    if days < 1:
        raise ValueError(f"A forecast window covers at least one day; {days} was requested.")
    start = today_at(location, now)
    return period_from_local_dates(location, start, start + timedelta(days=days - 1))


def historical_window(location: Location, start: date, end: date) -> Period:
    """A past range as whole local calendar days, inclusive of both bounds."""
    return period_from_local_dates(location, start, end)


def baseline_periods(
    location: Location,
    *,
    start: date,
    end: date,
    years: int,
    reference_year: int | None = None,
) -> tuple[tuple[int, Period], ...]:
    """The same calendar period in each of the ``years`` preceding years, newest first.

    For "the 10-year baseline for this calendar week", the caller passes the week's start and end
    and gets ten (year, period) pairs to retrieve. The year is returned alongside so a baseline can
    report *which* years it actually used rather than only how many.

    29 February is the awkward case: a period containing it simply loses that day in a non-leap
    year, because shifting it to 28 February would double-count that date. The year is still
    included, with one fewer day, and the point counts in the result make that visible.
    """
    if years < 1:
        raise ValueError(f"A baseline covers at least one year; {years} was requested.")
    if end < start:
        raise ValueError(
            f"A baseline period's end ({end.isoformat()}) must not precede its start "
            f"({start.isoformat()})."
        )

    anchor = reference_year if reference_year is not None else start.year
    span_days = (end - start).days

    periods: list[tuple[int, Period]] = []
    for offset in range(1, years + 1):
        year = anchor - offset
        shifted_start = _same_day_in(start, year)
        if shifted_start is None:
            # 29 February in a non-leap year: start the period on 1 March instead of skipping the
            # year, so a decade of baselines does not silently become nine.
            shifted_start = date(year, 3, 1)
        shifted_end = shifted_start + timedelta(days=span_days)
        periods.append((year, period_from_local_dates(location, shifted_start, shifted_end)))

    return tuple(periods)


def _same_day_in(day: date, year: int) -> date | None:
    """The same month and day in another year, or ``None`` when it does not exist there."""
    try:
        return day.replace(year=year)
    except ValueError:
        return None


def hours_ahead(reference: datetime, moment: datetime) -> float:
    """How far into the horizon an instant sits, in hours. Never negative."""
    delta = (moment.astimezone(UTC) - reference.astimezone(UTC)).total_seconds() / 3600.0
    return max(delta, 0.0)


def day_bounds(location: Location, day: date) -> tuple[datetime, datetime]:
    """Re-exported so callers need only this module for window work."""
    return local_day_bounds(location, day)
