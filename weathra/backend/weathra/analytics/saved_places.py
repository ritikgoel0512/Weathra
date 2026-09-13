"""Comparing the places somebody saved — arithmetic over readings already retrieved.

`specs/deterministic-analytics` puts every computed figure in this package, and a cross-location
summary is a computed figure like any other: the same readings produce the same answer, with no I/O,
no clock and no language model.

**Nothing here retrieves anything.** It is handed the current conditions the caller already has and
returns which of them is warmest, coolest, wettest and windiest, how far apart the extremes sit, and
how many are reporting rain. Every one of those is a `max`, a `min` or a count over values a
provider reported — there is no ranking model, no score, and no weighting anybody would have to
take on trust.

**A place with no reading is not a place at the bottom of the ranking.** A provider that could not
be reached is absent from every comparison rather than being counted as zero, because a city ranked
coldest for want of a reading is the same class of lie as a silent provider looking like calm
weather.

**Two is the minimum.** Comparing one place against nothing is not a comparison, and the screen says
so in words rather than printing a table with one row in it.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.weather import Measure

__all__ = [
    "COMPARED",
    "PlaceExtreme",
    "PlaceReading",
    "PlacesComparison",
    "compare_places",
]

# The measures a saved-place comparison ranks on, and the direction each is interesting in.
#
# Four, because these are the four a person actually asks across cities — where is it warmest, where
# is it coldest, where is it raining, where is it blowing — and every one of them is a quantity the
# current-conditions call already carries. A measure absent from this table is not compared, which
# is what keeps the summary to facts somebody wanted rather than every field the provider sent.
COMPARED: tuple[Measure, ...] = (
    Measure.TEMPERATURE,
    Measure.PRECIPITATION,
    Measure.WIND_SPEED,
)


class PlaceExtreme(BaseModel):
    """One end of one comparison: which place, and the reading that put it there."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    saved_id: str
    name: str = Field(description="The canonical place name, as a person reads it.")
    value: float
    unit: str | None = None


class PlacesComparison(BaseModel):
    """What the saved places' current readings say about each other.

    Every field is optional because every field depends on at least two places having reported the
    measure it ranks. A comparison with a warmest and no windiest is a comparison where nobody
    reported wind, and saying nothing about wind is the correct answer to that.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    compared: int = Field(ge=0, description="Places with a reading. Never the number saved.")
    warmest: PlaceExtreme | None = None
    coolest: PlaceExtreme | None = None
    temperature_spread: float | None = Field(
        default=None, description="Warmest less coolest, where both exist."
    )
    temperature_unit: str | None = None
    wettest: PlaceExtreme | None = None
    windiest: PlaceExtreme | None = None
    reporting_precipitation: int = Field(
        default=0,
        ge=0,
        description="Places whose current reading carries precipitation above zero.",
    )


class PlaceReading(BaseModel):
    """One saved place's current reading, as the comparison needs it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    saved_id: str
    name: str
    values: dict[Measure, float | None] = Field(default_factory=dict)
    units: dict[Measure, str] = Field(default_factory=dict)


def _ranked(
    readings: Sequence[PlaceReading], measure: Measure, *, highest: bool
) -> PlaceExtreme | None:
    """The place at one end of one measure, or nothing where fewer than two reported it.

    Two rather than one, deliberately: "the warmest of the places that reported a temperature" is
    a statement about a comparison, and with one reading there is nothing to have been warmer than.
    """
    scored = [
        (value, reading)
        for reading in readings
        if isinstance(value := reading.values.get(measure), (int, float))
    ]
    if len(scored) < 2:
        return None

    value, reading = (max if highest else min)(scored, key=lambda pair: pair[0])
    return PlaceExtreme(
        saved_id=reading.saved_id,
        name=reading.name,
        value=float(value),
        unit=reading.units.get(measure),
    )


def compare_places(readings: Sequence[PlaceReading]) -> PlacesComparison | None:
    """The cross-location summary, or nothing where there is not enough to compare.

    Returns ``None`` rather than an empty comparison below two readings, so the screen branches on
    "is there a comparison" instead of on whether four optional fields happen to be null.
    """
    if len(readings) < 2:
        return None

    warmest = _ranked(readings, Measure.TEMPERATURE, highest=True)
    coolest = _ranked(readings, Measure.TEMPERATURE, highest=False)

    return PlacesComparison(
        compared=len(readings),
        warmest=warmest,
        coolest=coolest,
        temperature_spread=(
            None if warmest is None or coolest is None else round(warmest.value - coolest.value, 2)
        ),
        temperature_unit=None if warmest is None else warmest.unit,
        # Ranked highest only: "where is it driest" asks about a measure that is zero almost
        # everywhere almost always, so a table naming a driest city would be reporting a tie.
        wettest=_ranked(readings, Measure.PRECIPITATION, highest=True),
        windiest=_ranked(readings, Measure.WIND_SPEED, highest=True),
        reporting_precipitation=sum(
            1
            for reading in readings
            if isinstance(value := reading.values.get(Measure.PRECIPITATION), (int, float))
            and value > 0
        ),
    )
