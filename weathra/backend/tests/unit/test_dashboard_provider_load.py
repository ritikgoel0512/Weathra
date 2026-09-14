"""What one Dashboard load costs the weather provider.

Production showed a normal user a rate-limit panel on the Dashboard's last card: "open-meteo
rate-limited the request." Everything above it rendered. This measures the thing that produces
that — how many upstream calls one Dashboard load makes for one location — so the number is a fact
in the suite rather than an estimate in a discussion.

The Dashboard issues five weather requests for its chosen place (`components/dashboard/
dashboard.tsx`): current conditions, the forecast, the analysis, What Changed?, and the climate
baseline. Four of them are forecast-shaped and differ only in what they do with the payload
afterwards; the fifth walks the archive a year at a time.

Driven through the real `CachedProvider` at the seam the application uses — one shared instance per
process, built in the API lifespan (`api/app.py`) and handed to every request — because the whole
question is which of those five calls reach the provider and which are served from the one before.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pytest

from tests.provider_support import StubProvider, provider_settings
from weathra.domain.errors import ProviderRateLimited
from weathra.domain.location import Location
from weathra.domain.weather import Measure, UnitSystem
from weathra.providers.cache import CachedProvider
from weathra.weather.history_service import HistoryService

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.405,
    timezone="Europe/Berlin",
    country="Germany",
)

# The window the Dashboard's baseline card asks about: the forecast's own calendar period.
WINDOW_START = date(2026, 3, 1)
WINDOW_END = date(2026, 3, 7)

# `GET /weather/history/baseline` defaults to ten years (`api/routers/history.py`), and the
# Dashboard sends no `years`, so ten is what production asks for.
DASHBOARD_BASELINE_YEARS = 10


@dataclass(slots=True)
class Load:
    """One Dashboard load's upstream cost, by provider operation."""

    current: int
    forecast: int
    history: int

    @property
    def total(self) -> int:
        return self.current + self.forecast + self.history


def _shared_cache(inner: StubProvider) -> CachedProvider:
    """The provider as the application holds it: one instance, shared by every request."""
    return CachedProvider(inner, settings=provider_settings())


async def _dashboard_load(cached: CachedProvider, inner: StubProvider) -> Load:
    """The five weather retrievals one Dashboard load performs for one place."""
    before = (inner.current_calls, inner.forecast_calls, inner.history_calls)

    # 1. Current conditions.
    await cached.current(BERLIN, unit_system=UnitSystem.METRIC)
    # 2. The forecast. 3. The analysis. 4. What Changed? All three retrieve the same forecast for
    #    the same place over the same horizon and differ only in what they compute from it.
    for _ in range(3):
        await cached.forecast(BERLIN, days=7, unit_system=UnitSystem.METRIC)
    # 5. The climate baseline, which walks the archive one year at a time.
    history = HistoryService(provider=cached, settings=provider_settings())
    await history.baseline(
        BERLIN,
        start=WINDOW_START,
        end=WINDOW_END,
        years=DASHBOARD_BASELINE_YEARS,
        measure=Measure.TEMPERATURE_MEAN,
    )

    return Load(
        current=inner.current_calls - before[0],
        forecast=inner.forecast_calls - before[1],
        history=inner.history_calls - before[2],
    )


@pytest.fixture
def stub() -> StubProvider:
    # `today` well past the window so the archive serves every candidate year rather than clamping.
    return StubProvider(today=date(2026, 6, 1))


async def test_one_dashboard_load_measured(stub: StubProvider) -> None:
    """The number, recorded. A change either way should be deliberate enough to edit this."""
    load = await _dashboard_load(_shared_cache(stub), stub)

    # The four forecast-shaped requests collapse to one upstream call: same place, same horizon,
    # same unit system, so the cache serves three of them. This is the property that must not
    # regress — four cards each fetching the forecast is four times the provider load.
    assert load.current == 1
    assert load.forecast == 1, (
        f"the forecast was retrieved {load.forecast} times for one Dashboard load; the current, "
        "forecast, analysis and What Changed? cards must share one retrieval"
    )
    # The baseline is the expensive half, and it is expensive by construction: one archive request
    # per candidate year, ten of them, because a ten-year climatology is ten years of observations.
    assert load.history == DASHBOARD_BASELINE_YEARS

    assert load.total == 12


async def test_a_second_load_of_the_same_place_costs_nothing(stub: StubProvider) -> None:
    """The cache is the reason a reload is not a second burst.

    Archive entries carry the long TTL because past weather does not change, so the ten-call half
    is paid once per process for a given place and window.
    """
    cached = _shared_cache(stub)
    first = await _dashboard_load(cached, stub)
    second = await _dashboard_load(cached, stub)

    assert first.total == 12
    assert second.total == 0, (
        f"a repeat Dashboard load cost {second.total} upstream calls; the cache is not serving it"
    )


async def test_two_people_looking_at_the_same_place_share_one_retrieval(
    stub: StubProvider,
) -> None:
    """The cache is location-keyed and carries no identity, so it works across people.

    `specs/authentication` classifies a forecast as shared data for exactly this reason: two
    accounts asking about Berlin is one question.
    """
    cached = _shared_cache(stub)
    await _dashboard_load(cached, stub)
    second_person = await _dashboard_load(cached, stub)

    assert second_person.total == 0


"""What a rate-limited archive does to the Dashboard's last card."""


class RateLimitedAfter(StubProvider):
    """An archive that serves *n* years and then refuses, as a limiter reached mid-walk does."""

    def __init__(self, *, serves: int, **keywords: object) -> None:
        super().__init__(**keywords)  # type: ignore[arg-type]
        self._serves = serves

    async def history(self, location, **keywords):  # type: ignore[no-untyped-def]
        if self.history_calls >= self._serves:
            self.history_calls += 1
            raise ProviderRateLimited(
                "open-meteo rate-limited the request.",
                details={"provider": "open-meteo", "status": 429},
            )
        return await super().history(location, **keywords)


async def test_a_limit_reached_mid_walk_stops_rather_than_spending_the_rest() -> None:
    """The loop must not send the remaining years into a limiter that just refused one.

    `providers/http.py` already refuses to retry a 429 at all — the provider policy carries no wait
    budget, so a rate-limited call is reported once rather than attempted three times. This is the
    other half: the *caller* must not turn one refusal into nine more requests.
    """
    inner = RateLimitedAfter(serves=4, today=date(2026, 6, 1))
    cached = CachedProvider(inner, settings=provider_settings())
    history = HistoryService(provider=cached, settings=provider_settings())

    result = await history.baseline(
        BERLIN,
        start=WINDOW_START,
        end=WINDOW_END,
        years=DASHBOARD_BASELINE_YEARS,
        measure=Measure.TEMPERATURE_MEAN,
    )

    # Four served, one refused, and then it stopped: five calls, not ten.
    assert inner.history_calls == 5, (
        f"{inner.history_calls} archive calls were made after a refusal; the walk must stop"
    )
    # And the card still has a real answer, over the years it actually got.
    assert len(result.years_used) == 4
    assert result.years_requested == DASHBOARD_BASELINE_YEARS
    assert result.mean.value is not None


async def test_a_limit_on_the_first_year_is_reported_rather_than_disguised() -> None:
    """Nothing collected and a refusal is the one case the card cannot render.

    It must surface as the rate limit it was, not as "the archive holds no observations" — which
    would be a claim about the data rather than about the limiter, and would send a reader looking
    for missing history that is not missing.
    """
    inner = RateLimitedAfter(serves=0, today=date(2026, 6, 1))
    cached = CachedProvider(inner, settings=provider_settings())
    history = HistoryService(provider=cached, settings=provider_settings())

    with pytest.raises(ProviderRateLimited):
        await history.baseline(
            BERLIN,
            start=WINDOW_START,
            end=WINDOW_END,
            years=DASHBOARD_BASELINE_YEARS,
            measure=Measure.TEMPERATURE_MEAN,
        )

    # One attempt, then reported. No retry, and no walking the remaining nine years.
    assert inner.history_calls == 1


async def test_the_rest_of_the_dashboard_is_unaffected_by_the_baseline_failing() -> None:
    """The four forecast-shaped cards do not share the archive's fate.

    The Dashboard's sections carry their own state, so a refused archive call takes the baseline
    card and nothing else. Asserted at this layer because it is the provider behaviour the screen
    depends on: the forecast retrieval must still be served, from cache, after the archive refused.
    """
    inner = RateLimitedAfter(serves=0, today=date(2026, 6, 1))
    cached = CachedProvider(inner, settings=provider_settings())

    await cached.current(BERLIN, unit_system=UnitSystem.METRIC)
    await cached.forecast(BERLIN, days=7, unit_system=UnitSystem.METRIC)

    history = HistoryService(provider=cached, settings=provider_settings())
    with pytest.raises(ProviderRateLimited):
        await history.baseline(
            BERLIN,
            start=WINDOW_START,
            end=WINDOW_END,
            years=DASHBOARD_BASELINE_YEARS,
            measure=Measure.TEMPERATURE_MEAN,
        )

    # The cards above it still answer, and still without a second upstream call.
    await cached.forecast(BERLIN, days=7, unit_system=UnitSystem.METRIC)
    assert inner.forecast_calls == 1
    assert inner.current_calls == 1
