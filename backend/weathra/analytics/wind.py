"""Wind, humidity, dew point, and pressure statistics.

Wind direction is the one measure here that cannot be averaged arithmetically: the mean of 350°
and 10° is 180°, which is the exact opposite of the answer. The prevailing direction is therefore
computed as a **vector mean** — unit vectors summed and converted back to a bearing — and reported
as a compass sector, because a sector is what a person can act on and a degree implies a precision
a wind rose does not have (``specs/deterministic-analytics``).
"""

from __future__ import annotations

import numpy as np

from weathra.analytics.descriptive import maximum, mean, value_range
from weathra.analytics.support import not_computable, scalar, usable_points
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.weather import Measure, Series

__all__ = [
    "COMPASS_SECTORS",
    "compass_sector",
    "humidity_statistics",
    "pressure_statistics",
    "prevailing_direction",
    "wind_statistics",
]

COMPASS_SECTORS = (
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
)

_SECTOR_WIDTH = 360.0 / len(COMPASS_SECTORS)


def compass_sector(degrees: float) -> str:
    """The 16-point compass sector a bearing falls in. 348.75°-11.25° is N."""
    normalized = degrees % 360.0
    index = int((normalized + _SECTOR_WIDTH / 2) // _SECTOR_WIDTH) % len(COMPASS_SECTORS)
    return COMPASS_SECTORS[index]


def prevailing_direction(
    series: Series,
    provenance: Provenance,
    *,
    measure: Measure = Measure.WIND_DIRECTION,
) -> StatisticResult:
    """The vector-mean wind direction, reported as a compass sector.

    The scalar value is the mean bearing in degrees; ``parameters["sector"]`` carries the sector a
    reader sees. A window whose directions cancel out entirely — a perfectly balanced wind rose —
    has no prevailing direction and says so rather than reporting an arbitrary bearing.
    """
    points = usable_points(series, measure)
    unit = series.unit(measure) or "°"
    method = "vector mean of unit direction vectors, reported as a 16-point compass sector"

    if not points.enough_for(Statistic.PREVAILING_DIRECTION):
        return not_computable(
            Statistic.PREVAILING_DIRECTION,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
        )

    radians = np.radians(np.asarray(points.values, dtype=float))
    east = float(np.sum(np.sin(radians)))
    north = float(np.sum(np.cos(radians)))

    if np.isclose(east, 0.0) and np.isclose(north, 0.0):
        return not_computable(
            Statistic.PREVAILING_DIRECTION,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
            reason=(
                "The direction vectors cancel out over this window, so there is no prevailing "
                "direction to report."
            ),
        )

    # Rounded before the modular wrap: due north comes out of arctan2 as a hair below zero, and
    # `% 360` would turn that into 359.999999 — the right direction reported as the wrong number.
    bearing = round(float(np.degrees(np.arctan2(east, north))), 6) % 360.0
    return scalar(
        Statistic.PREVAILING_DIRECTION,
        measure,
        value=bearing,
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
        parameters={"sector": compass_sector(bearing)},
    )


def wind_statistics(
    series: Series,
    provenance: Provenance,
    *,
    speed: Measure = Measure.WIND_SPEED,
    gust: Measure = Measure.WIND_GUST,
    direction: Measure = Measure.WIND_DIRECTION,
) -> tuple[StatisticResult, ...]:
    """Mean speed, maximum sustained speed, maximum gust with its timestamp, and the sector.

    Each is independent: a series carrying speed but no gust reports the gust unavailable and
    still returns the rest.
    """
    return (
        _renamed(mean(series, speed, provenance), Statistic.MEAN_SPEED),
        _renamed(maximum(series, speed, provenance), Statistic.MAXIMUM_SUSTAINED_SPEED),
        _renamed(maximum(series, gust, provenance), Statistic.MAXIMUM_GUST),
        prevailing_direction(series, provenance, measure=direction),
    )


def _renamed(result: StatisticResult, statistic: Statistic) -> StatisticResult:
    """Relabel a generic extreme as the wind statistic it is.

    ``maximum`` and ``mean`` already do the work; naming the result ``maximum_gust`` rather than
    ``maximum`` is what lets an evidence record say which figure is which. The declared minimum is
    updated with it so the result stays internally consistent.
    """
    from weathra.analytics.support import MINIMUM_POINTS

    return result.model_copy(
        update={"statistic": statistic, "minimum_points": MINIMUM_POINTS[statistic]}
    )


def humidity_statistics(
    series: Series,
    provenance: Provenance,
    *,
    humidity: Measure = Measure.RELATIVE_HUMIDITY,
    dew_point: Measure = Measure.DEW_POINT,
) -> tuple[StatisticResult, ...]:
    """Mean and range for relative humidity and dew point."""
    return (
        mean(series, humidity, provenance),
        value_range(series, humidity, provenance),
        mean(series, dew_point, provenance),
        value_range(series, dew_point, provenance),
    )


def pressure_statistics(
    series: Series,
    provenance: Provenance,
    *,
    pressure: Measure = Measure.SURFACE_PRESSURE,
) -> tuple[StatisticResult, ...]:
    """Mean and range for surface pressure."""
    return (
        mean(series, pressure, provenance),
        value_range(series, pressure, provenance),
    )
