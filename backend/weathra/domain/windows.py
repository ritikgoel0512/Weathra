"""Building a ``Period`` from a location's own calendar.

The primitive behind every window in the system: a local calendar day is turned into UTC bounds
using the *location's* timezone, never the server's. "Thursday" means Thursday there, and a day is
not always 24 hours long — a DST transition makes one 23 and another 25, and computing bounds by
adding ``timedelta(days=1)`` to a UTC instant silently gets both wrong.

``weather/windows.py`` builds request-level resolution on top of this (task 8.1); this module is
kept in ``domain/`` because ``providers/`` needs it too and may not import upward.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

from weathra.domain.location import Location
from weathra.domain.weather import Period

__all__ = ["local_day_bounds", "period_from_local_dates", "period_from_utc_instants"]


def local_day_bounds(location: Location, day: date) -> tuple[datetime, datetime]:
    """The UTC instants a local calendar day starts and ends at.

    Uses ``fold=0`` at midnight, which is what a person means by "that day" even in the rare zone
    whose transition lands on midnight itself.
    """
    zone = location.zoneinfo
    start_local = datetime.combine(day, time.min, tzinfo=zone)
    end_local = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone)
    return start_local.astimezone(UTC), end_local.astimezone(UTC)


def period_from_local_dates(location: Location, start: date, end_inclusive: date) -> Period:
    """A period covering whole local days from ``start`` to ``end_inclusive``.

    Half-open in UTC terms: the end bound is midnight local time *after* the last day, so a
    seven-day window is 168 hours except across a DST transition, where it is honestly 167 or 169.
    """
    if end_inclusive < start:
        raise ValueError(
            f"A period's end ({end_inclusive.isoformat()}) must not precede its start "
            f"({start.isoformat()})."
        )
    start_utc, _ = local_day_bounds(location, start)
    _, end_utc = local_day_bounds(location, end_inclusive)
    return period_from_utc_instants(location, start_utc, end_utc)


def period_from_utc_instants(location: Location, start: datetime, end: datetime) -> Period:
    """A period from two UTC instants, with the local bounds resolved in the location's zone."""
    zone = location.zoneinfo
    start_utc = start.astimezone(UTC)
    end_utc = end.astimezone(UTC)
    return Period(
        start_utc=start_utc,
        end_utc=end_utc,
        start_local=start_utc.astimezone(zone),
        end_local=end_utc.astimezone(zone),
        timezone=location.timezone,
    )
