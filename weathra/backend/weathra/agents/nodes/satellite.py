"""The satellite observation node.

The fifth thing that retrieves, and the only one that retrieves no figure. `weather_satellite`
answers with a picture of a region at a stated time, and this records that: the tool call, the
attribution, and the normalized observation. There are no findings, because there is nothing to put
in one — `docs/satellite-source.md` records that the source supplies imagery and metadata and no
measurement at all, and a `Finding` invented from an image would be exactly the fabrication this
capability is most exposed to.

**Optional by construction.** A failed satellite step is a recorded failure and the run continues:
the forecast, current, historical, analytics and knowledge capabilities answer as they would have.
What the run must never do is answer as though imagery had been retrieved — so the failure is
written into ``failures``, which the synthesis prompt is required to report rather than smooth over.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from weathra.agents.nodes.support import attribution_from, call_tool, record_step
from weathra.agents.plan import Capability, PlanStep
from weathra.agents.state import GraphState, Retrieval
from weathra.domain.evidence import AgentName, StepStatus
from weathra.domain.location import Location
from weathra.domain.satellite import SatelliteObservation
from weathra.mcp.client import McpToolClient

__all__ = ["run_satellite"]

logger = logging.getLogger("weathra.agents.nodes.satellite")

_SATELLITE_TOOL = "weather_satellite"


async def run_satellite(state: GraphState, step: PlanStep, *, client: McpToolClient) -> GraphState:
    """Retrieve the latest available satellite imagery for each location the step names."""
    started = datetime.now(UTC)
    locations = _locations_for(state, step)

    if not locations:
        return record_step(
            state,
            agent=AgentName.SATELLITE,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="No location was resolved, so there was nowhere to look for imagery.",
        )

    working = state
    succeeded = 0

    for location in locations:
        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.SATELLITE,
            tool=_SATELLITE_TOOL,
            arguments={"latitude": location.latitude, "longitude": location.longitude},
        )

        if outcome.failed:
            # Named as *satellite* unavailability rather than as a weather failure. A run that also
            # retrieved a forecast still has an answer, and the person is owed the difference
            # between "no imagery" and "no weather".
            working = working.with_failure(
                f"Satellite imagery for {location.qualified_name} could not be retrieved "
                f"({outcome.error_code}). Nothing was substituted for it."
            )
            continue

        observation = _observation_from(outcome.data, location)
        if observation is None:
            working = working.with_failure(
                f"The satellite tool answered for {location.qualified_name} without an "
                "observation, so none is reported."
            )
            continue

        working = _record(working, outcome.data, observation, step=step, location=location)
        succeeded += 1

    status = StepStatus.SUCCEEDED if succeeded else StepStatus.FAILED
    reason = (
        step.reason
        if succeeded
        else "No satellite imagery could be retrieved for any location in this step."
    )
    return record_step(
        working, agent=AgentName.SATELLITE, started_at=started, status=status, reason=reason
    )


def _locations_for(state: GraphState, step: PlanStep) -> tuple[Location, ...]:
    """The resolved locations this step runs over — the same reading the retrieval nodes do."""
    if not step.named_locations:
        return state.locations

    wanted = {name.strip().casefold() for name in step.named_locations}
    matched = tuple(
        location
        for location in state.locations
        if location.display_name.casefold() in wanted
        or location.qualified_name.casefold() in wanted
    )
    return matched or state.locations


def _observation_from(payload: dict[str, Any], location: Location) -> SatelliteObservation | None:
    """The tool's normalized observation, validated back into the domain model.

    Through the model rather than read field by field: the contract is the model, and a payload that
    no longer satisfies it should fail here rather than reach an answer half-populated.
    """
    block = payload.get("observation")
    if not isinstance(block, dict):
        return None
    try:
        observation = SatelliteObservation.model_validate(block)
    except ValueError:
        logger.warning("the satellite tool returned an observation that failed validation")
        return None
    # The place the node resolved, not the coordinate pair the tool resolved back — the same
    # substitution `_record_retrieval` makes for the weather tools, and for the same reason: one of
    # the two is the name the person used.
    return observation.model_copy(update={"location": location})


def _record(
    state: GraphState,
    payload: dict[str, Any],
    observation: SatelliteObservation,
    *,
    step: PlanStep,
    location: Location,
) -> GraphState:
    """Record the retrieval, its attribution and the observation itself."""
    attribution = attribution_from(payload).model_copy(update={"location": location})
    retrieval = Retrieval(
        capability=Capability.SATELLITE,
        location=location,
        period=None,
        data_class=attribution.data_class,
        unit_system=state.unit_system,
        provider=attribution.provider,
        retrieved_at=attribution.retrieved_at,
        payload=payload,
        attribution=attribution,
        question_part=step.question_part,
    )
    return state.with_retrieval(retrieval).with_satellite(observation)
