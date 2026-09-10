"""Whether a watched condition held — task 34.17.

One comparison, and the null case is the one worth testing. A provider that reported nothing has not
told us the condition is unmet; treating those as the same is how a silent provider becomes calm
weather on somebody's screen.
"""

from __future__ import annotations

import pytest

from weathra.domain.weather import Measure
from weathra.memory.watches import COMPARISONS, WATCHABLE, evaluate_watch


@pytest.mark.parametrize(
    ("comparison", "threshold", "value", "expected"),
    [
        ("above", 20.0, 25.0, True),
        ("above", 20.0, 15.0, False),
        ("below", 5.0, 2.0, True),
        ("below", 5.0, 8.0, False),
    ],
)
def test_a_threshold_is_compared_and_nothing_else(
    comparison: str, threshold: float, value: float, expected: bool
) -> None:
    assert (
        evaluate_watch(
            measure=Measure.TEMPERATURE, comparison=comparison, threshold=threshold, value=value
        )
        is expected
    )


def test_an_absent_reading_is_not_an_unmet_condition() -> None:
    """Null, not False. The provider said nothing; that is not the same as saying no."""
    assert (
        evaluate_watch(measure=Measure.WIND_SPEED, comparison="above", threshold=50.0, value=None)
        is None
    )


def test_the_boundary_is_strict() -> None:
    """Exactly at the threshold is not above it, and not below it either — stated, so nobody has to
    infer which way a watch tips at its own number."""
    assert (
        evaluate_watch(measure=Measure.TEMPERATURE, comparison="above", threshold=20.0, value=20.0)
        is False
    )
    assert (
        evaluate_watch(measure=Measure.TEMPERATURE, comparison="below", threshold=20.0, value=20.0)
        is False
    )


def test_only_measures_the_provider_reports_may_be_watched() -> None:
    """A watch is a promise to check something. Promising to check a measure Open-Meteo does not
    report would be a watch that could only ever stay null."""
    assert Measure.TEMPERATURE in WATCHABLE
    assert Measure.WIND_GUST in WATCHABLE
    # Daily aggregates are not instantaneous readings and are not watchable.
    assert Measure.TEMPERATURE_MAX not in WATCHABLE


def test_there_are_exactly_two_directions() -> None:
    assert set(COMPARISONS) == {"above", "below"}
