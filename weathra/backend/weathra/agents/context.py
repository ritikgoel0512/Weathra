"""Resolving what the question is *about*: which place, which window, which units, and from where.

This runs before any capability node, and it is the only place that answers "where did this
location come from". ``specs/agent-orchestration`` requires an answer to state the location and
window it resolved to, and to distinguish a saved default from a guess — so the source is tracked
alongside the value, not inferred afterwards.

**The precedence, and why.**

1. **What the question named.** An explicit place always wins. Someone who asks about Lisbon while
   their default is Berlin means Lisbon.
2. **The conversation's focus.** The place the caller pointed this conversation at — the Analyst's
   FOCUS control, sent already resolved on every question of that conversation. It beats the thread
   and the saved default because it is the most recent thing the person *chose*, and it loses to a
   place they just named, which is a choice more recent still.
3. **The thread's context.** A follow-up resolves against the conversation: "which one is warmer?"
   after "compare Berlin and Munich" means those two. Only ever the acting user's own thread. This
   sits above the saved default deliberately: a conversation that has established Berlin is a
   stronger statement about *this* question than a preference set once, months ago.
4. **The saved default location.** Used *and disclosed*: the answer says it applied the saved
   default, so a person can tell that from Weathra having guessed.
5. **Nothing.** Which produces a clarifying question, not a guess. This is the load-bearing case:
   a run that quietly picked a plausible city would give a confident answer to a question that was
   never asked.

**A saved place is not a default.** Nothing in this module reads the caller's saved locations. A
person who saved Berlin, London and New York has expressed no preference between them, and picking
the first would be the guess step 5 exists to refuse. The Analyst offers them as *choices* when it
has to ask — which is a question, not an inference.

Units follow the same shape with the same disclosure, and one extra rule: an explicit request beats
a stored preference, because a preference is a default rather than an override.

**The window comes from the location, not from here.** ``weather/windows.py`` resolves every
window against the place's own calendar, so this module reads no clock at all: at 23:30 UTC it is
already tomorrow in Berlin, and a server-side "today" would answer the wrong day.

**Ambiguity is surfaced, never resolved by picking.** "Springfield" comes back from the geocoder as
several candidates; that becomes a clarifying question listing them, because choosing for the
person is choosing wrong most of the time.

**Memory being down does not stop a question that named its own place.** Thread context and
preferences are read through ``with_memory``, so an outage means the defaults apply and the answer
says so — while a self-contained question is unaffected (``specs/memory``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from weathra.agents.plan import RoutingPlan
from weathra.agents.state import GraphState
from weathra.domain.errors import LocationNotFound
from weathra.domain.location import Ambiguous, Location, Resolved
from weathra.domain.weather import UnitSystem
from weathra.geocoding.base import Geocoder
from weathra.memory.degradation import MemoryStatus, with_memory
from weathra.memory.preferences import PreferenceStore, PreferenceView
from weathra.memory.threads import ResolvedEntities, ThreadStore

__all__ = ["ContextSources", "ResolutionOutcome", "resolve_context"]

logger = logging.getLogger("weathra.agents.context")


@dataclass(frozen=True, slots=True)
class ContextSources:
    """The stores a run reads its context from. Any of them may be absent.

    ``None`` for either store is a supported, meaningful state: an unauthenticated public run has
    no thread and no preferences, and a memory outage has neither either. A question that names its
    own place is answered identically in all three cases.
    """

    threads: ThreadStore | None = None
    preferences: PreferenceStore | None = None
    thread_id: str | None = None


@dataclass(frozen=True, slots=True)
class ResolutionOutcome:
    """What resolution produced: an updated state, and whether it needs to ask something."""

    state: GraphState
    memory: MemoryStatus

    @property
    def needs_clarification(self) -> bool:
        return bool(self.state.clarification_question)


async def resolve_context(
    state: GraphState,
    plan: RoutingPlan,
    *,
    geocoder: Geocoder,
    sources: ContextSources | None = None,
) -> ResolutionOutcome:
    """Resolve the locations, units, and window this run is about.

    Returns the state with the resolved context and its provenance recorded, or with a clarifying
    question set — in which case no capability node should run.

    No clock is read here, deliberately. A window is resolved from the *location's* own calendar by
    the tools that retrieve it (``weather/windows.py``), so resolving one here from a server clock
    would be a second, wrong answer to the same question.
    """
    origins = sources or ContextSources()
    memory = MemoryStatus()

    entities, memory = await _thread_entities(origins, memory)
    preferences, memory = await _preferences(origins, memory)

    units, units_source = _resolve_units(state, entities, preferences)
    working = state.with_updates(unit_system=units, units_source=units_source)

    named = _named_places(plan)

    if named:
        resolved, ambiguous, unknown = await _geocode(named, geocoder)
        if ambiguous is not None:
            return ResolutionOutcome(
                state=working.with_updates(
                    clarification_question=_ambiguity_question(ambiguous),
                    location_source="request",
                ),
                memory=memory,
            )
        if unknown:
            # Not-found is a refusal with the name in it, never a nearest match
            # (``specs/location-resolution``). It is a failure the answer reports, not a
            # clarification, because there is nothing for the person to choose between.
            working = working.with_failure(
                f"No location matched {_readable(unknown)}, so nothing was retrieved for it. "
                "Weathra does not substitute a nearby or similarly spelled place."
            )
        if resolved:
            return ResolutionOutcome(
                state=working.with_updates(
                    locations=resolved,
                    location_source="request",
                    context_statement=_statement(resolved, units, "the question"),
                ),
                memory=memory,
            )
        if unknown:
            return ResolutionOutcome(
                state=working.with_updates(
                    location_source="none",
                    clarification_question=(
                        f"Weathra could not find {_readable(unknown)}. Which place did you mean? "
                        "A country or region with the name helps — 'Springfield, Illinois'."
                    ),
                ),
                memory=memory,
            )

    if state.focus is not None:
        # Already resolved, and resolved the same way a saved default was: the route pinned the
        # caller's choice against the geocoder's own candidates before the graph started, so there
        # is nothing left here to look up and nothing a caller could have asserted. See
        # `AskRequest.location` and `resolve_for_saving`.
        logger.info("resolved the location from the conversation's focus")
        return ResolutionOutcome(
            state=working.with_updates(
                locations=(state.focus,),
                location_source="focus",
                context_statement=_statement(
                    (state.focus,), units, "the focus you set for this conversation"
                ),
            ),
            memory=memory,
        )

    if entities is not None and entities.locations:
        logger.info("resolved %d location(s) from thread context", len(entities.locations))
        return ResolutionOutcome(
            state=working.with_updates(
                locations=entities.locations,
                location_source="thread",
                context_statement=_statement(
                    entities.locations, units, "your previous question in this conversation"
                ),
            ),
            memory=memory,
        )

    if preferences is not None and preferences.default_location is not None:
        default = preferences.default_location
        logger.info("resolved the location from the saved default")
        return ResolutionOutcome(
            state=working.with_updates(
                locations=(default,),
                location_source="preferences",
                context_statement=_statement((default,), units, "your saved default location"),
            ),
            memory=memory,
        )

    if not plan.touches_weather_data:
        # A purely conceptual question needs no place at all, and asking for one would be
        # obstructive: "what does dew point mean?" is answerable anywhere.
        return ResolutionOutcome(state=working.with_updates(location_source="none"), memory=memory)

    return ResolutionOutcome(
        state=working.with_updates(
            location_source="none",
            clarification_question=(
                "Which place should Weathra look at? The question does not name one, there is no "
                "location established in this conversation, and no default location is saved."
                if origins.preferences is not None
                else "Which place should Weathra look at? The question does not name one."
            ),
        ),
        memory=memory,
    )


# =========================================================================== reading the stores


async def _thread_entities(
    sources: ContextSources, memory: MemoryStatus
) -> tuple[ResolvedEntities | None, MemoryStatus]:
    """The thread's projection, or ``None`` when there is no thread or memory is down."""
    if sources.threads is None or sources.thread_id is None:
        return None, memory

    store = sources.threads
    thread_id = sources.thread_id

    async def read() -> ResolvedEntities | None:
        return await store.entities(thread_id)

    entities, status = await with_memory(read, fallback=None, what="conversation memory")
    return entities, memory if status.available else status


async def _preferences(
    sources: ContextSources, memory: MemoryStatus
) -> tuple[PreferenceView | None, MemoryStatus]:
    """The acting user's preferences, or the documented defaults if the store is unreachable."""
    if sources.preferences is None:
        return None, memory

    store = sources.preferences
    view, status = await with_memory(
        store.read, fallback=store.defaults, what="the preference store"
    )
    return view, memory if status.available else status


# =========================================================================== resolution


def _resolve_units(
    state: GraphState, entities: ResolvedEntities | None, preferences: PreferenceView | None
) -> tuple[UnitSystem, str]:
    """Units, and where they came from. Request, then thread, then preference, then default."""
    if state.requested_unit_system is not None:
        return state.requested_unit_system, "request"
    if entities is not None and entities.unit_system is not None:
        return entities.unit_system, "thread"
    if preferences is not None and not preferences.is_default("unit_system"):
        return preferences.unit_system, "preferences"
    if preferences is not None:
        return preferences.unit_system, "default"
    return UnitSystem.METRIC, "default"


def _named_places(plan: RoutingPlan) -> tuple[str, ...]:
    """Every distinct place the plan names, in the order it named them."""
    seen: list[str] = []
    for step in plan.steps:
        for name in step.named_locations:
            cleaned = name.strip()
            if cleaned and cleaned.casefold() not in {existing.casefold() for existing in seen}:
                seen.append(cleaned)
    return tuple(seen)


async def _geocode(
    names: tuple[str, ...], geocoder: Geocoder
) -> tuple[tuple[Location, ...], Ambiguous | None, tuple[str, ...]]:
    """Resolve each named place. The first ambiguity stops resolution and is asked about.

    Stopping on the first ambiguity rather than collecting them all keeps the clarifying question
    answerable: "did you mean Springfield, Illinois or Springfield, Missouri?" is a question a
    person can answer, and two of them at once is a form.
    """
    resolved: list[Location] = []
    unknown: list[str] = []

    for name in names:
        try:
            outcome = await geocoder.resolve(name)
        except LocationNotFound:
            unknown.append(name)
            continue

        if isinstance(outcome, Ambiguous):
            return tuple(resolved), outcome, tuple(unknown)
        if isinstance(outcome, Resolved):
            resolved.append(outcome.location)

    return tuple(resolved), None, tuple(unknown)


# =========================================================================== what to say


def _ambiguity_question(ambiguous: Ambiguous) -> str:
    """A clarifying question listing the candidates, with what distinguishes them."""
    options = " or ".join(candidate.qualified_name for candidate in ambiguous.candidates)
    return (
        f"{ambiguous.query!r} matches more than one place: {options}. Which did you mean? Weathra "
        "does not pick one for you."
    )


def _statement(locations: tuple[Location, ...], units: UnitSystem, source: str) -> str:
    """The plain sentence the answer shows, naming what was resolved and from where."""
    places = " and ".join(location.qualified_name for location in locations)
    return f"Using {places} (from {source}), in {units.value} units."


def _readable(names: tuple[str, ...]) -> str:
    quoted = [f"{name!r}" for name in names]
    if len(quoted) == 1:
        return quoted[0]
    return f"{', '.join(quoted[:-1])} or {quoted[-1]}"
