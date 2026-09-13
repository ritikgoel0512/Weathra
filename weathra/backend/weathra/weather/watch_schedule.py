"""The scheduled watch pass: check everybody's watches, record what changed, and stop.

``weathra-watch-evaluate``. Invoked hourly from `.github/workflows/weather-watch.yml`, never from a
running server.

**Why it is a CI job and not a thread in the backend.** design.md decision 11 puts scheduled work in
"a scheduled CI job in the MVP, no in-process scheduler", and the reason is the credential rather
than the scheduling. Evaluating watches belonging to *other people* is precisely the work the
request-serving role must not be able to do, so it runs under the privileged connection — and the
deployed backend never holds that connection at all. A thread inside the API would need it
permanently, to buy nothing a cron entry does not already give.

**One provider call per place, not per watch.** `weather/watch_evaluator.py` groups before it
fetches. A pass over forty watches across six cities costs six retrievals, and that ratio is what
decides whether this scales with places or with watches.

**A pass that cannot reach the provider still writes rows.** Every watch at an unreachable place is
recorded `degraded` with the reason. Skipping them would leave the previous state on screen looking
current, which is the specific way a monitoring product lies.

**Running twice in one cadence window does nothing the second time.** Watches checked within half
the cadence are skipped, so an overlapping schedule, a manual dispatch beside a scheduled run, or a
retry after a partial failure cannot double-evaluate — and cannot write a second copy of a
transition that already happened.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import UTC, datetime, timedelta

import httpx
from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.memory.watch_monitoring import due_watches
from weathra.providers.cache import CachedProvider
from weathra.providers.registry import build_provider
from weathra.weather.forecast_service import ForecastService
from weathra.weather.watch_evaluator import evaluate_watches, group_by_place

__all__ = ["WatchPassReport", "main", "run_pass"]

logger = logging.getLogger("weathra.watch.schedule")


class WatchPassReport(BaseModel):
    """What one pass did. Printed as JSON so a workflow log can be read back."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    started_at: datetime
    watches_considered: int = Field(ge=0)
    places_retrieved: int = Field(ge=0)
    evaluations_written: int = Field(ge=0)
    events_written: int = Field(ge=0)
    degraded: int = Field(ge=0, description="Watches whose place could not be retrieved.")
    skipped_recent: int = Field(
        ge=0, description="Watches already checked within half the cadence, so not checked again."
    )


async def run_pass(settings: Settings, *, dry_run: bool = False) -> WatchPassReport:
    """One pass over every enabled watch in the system.

    Privileged throughout: it reads and writes rows belonging to everybody, which is the whole
    reason this is not request-path work.
    """
    started = datetime.now(UTC)
    cadence = timedelta(minutes=settings.watch_cadence_minutes)
    # Half the cadence, not the whole of it: a pass that started a minute late must still do its
    # work, and a full-cadence guard would make every slightly-delayed run a no-op.
    cutoff = started - cadence / 2

    engines = Engines.create(settings)
    async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
        forecasts = ForecastService(
            provider=CachedProvider(build_provider(settings, client), settings=settings),
            geocoder=OpenMeteoGeocoder(settings=settings, client=client),
            settings=settings,
        )
        try:
            async with privileged_session(engines.privileged_sessionmaker) as session:
                every = await due_watches(session)
                due = await due_watches(session, not_evaluated_since=cutoff)
                skipped = len(every) - len(due)

                if dry_run:
                    return WatchPassReport(
                        started_at=started,
                        watches_considered=len(due),
                        places_retrieved=len(group_by_place(due)),
                        evaluations_written=0,
                        events_written=0,
                        degraded=0,
                        skipped_recent=skipped,
                    )

                results = await evaluate_watches(
                    session, watches=due, forecasts=forecasts, cadence=cadence, now=started
                )
                return WatchPassReport(
                    started_at=started,
                    watches_considered=len(due),
                    places_retrieved=len(group_by_place(due)),
                    evaluations_written=len(results),
                    events_written=sum(len(events) for _, _, events in results),
                    degraded=sum(1 for _, evaluation, _ in results if evaluation.error is not None),
                    skipped_recent=skipped,
                )
        finally:
            await engines.dispose()


def main(argv: list[str] | None = None) -> int:
    """``weathra-watch-evaluate``. Invoked by a scheduled job, not by a running server."""
    parser = argparse.ArgumentParser(
        prog="weathra-watch-evaluate",
        description="Evaluate every enabled weather watch against a freshly retrieved forecast, "
        "record what each check found, and write the transitions. Runs under the privileged "
        "database connection.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be evaluated without retrieving anything or writing a row.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = Settings()

    if settings.runtime_mode != "privileged":
        # The same refusal retention makes, for the same reason: under the request-serving
        # configuration the policies would narrow every statement to nothing and this job would
        # report success having evaluated nobody's watches.
        print(
            "Refusing to run: set WEATHRA_RUNTIME_MODE=privileged. The watch pass reads and "
            "writes rows belonging to every user, which the request-serving role cannot do — "
            "under it this job would report success having evaluated nothing.",
            file=sys.stderr,
        )
        return 2

    report = asyncio.run(run_pass(settings, dry_run=args.dry_run))
    print(json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True))
    return 0
