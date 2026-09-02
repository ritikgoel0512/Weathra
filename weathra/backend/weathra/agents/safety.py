"""Positioning and severe-weather safety: what Weathra is, and what it must never claim to be.

Three requirements from ``specs/safety-grounding``, and they are not politeness — they are the
difference between a useful tool and a dangerous one.

**Weathra is not a forecaster.** It retrieves a provider's model output, analyses it
deterministically, and explains it. It runs no numerical weather prediction, and its language model
runs none either. So every forecast figure is attributed to the upstream provider, and a caller who
asks what Weathra does gets that answer rather than an implication that it predicts weather itself.

**Weathra is not an emergency warning service.** When a question is about severe weather, danger to
life or property, or an emergency decision, the answer directs the caller to their official local
meteorological authority *alongside* whatever it can honestly report. Not instead of the data — a
referral with no information is unhelpful — and not framed as a warning of its own, because a
person reading something that looks like an official alert may act on it in place of one.

**Weathra does not characterize severity it cannot see.** A provider that reports temperature,
precipitation, and wind does not report "a dangerous storm". Asserting severity from those numbers
would be the language model doing meteorology, which is precisely the thing decision 2 exists to
prevent. So a severity claim is permitted only where the retrieved data carries a field describing
it, and where it does not, the answer says what the measures show and that it cannot characterize
severity.

**As things stand, that guard fires on every answer, and that is correct rather than a gap.**
Weathra's normalized model carries the twelve instantaneous measures ``specs/weather-providers``
names and their daily aggregates — every one of them a *measurement*. None is an alert, a warning,
a weather code, or a severity rating, so no currently-supported provider supplies a field that
could support a severity claim. The check is written against field *names* rather than removed,
because ``specs/safety-grounding`` has a scenario for the supported case ("the answer may report it
with the provider attributed and the fields named") and a provider that supplied an alerts block
should light this up without anyone having to remember to re-add the guard.

**Why detection is keyword-based, and why that is acceptable here.** A severe-weather referral is
*additive*: it adds a sentence pointing at an authority. A false positive costs a person one
sentence of advice they did not need. A false negative costs nothing that the answer's own honest
data does not already cost — the answer still reports only what it retrieved. So a generous keyword
list is the right instrument, and the asymmetry runs the safe way. This would be the wrong
instrument for a *suppression* rule, which is why the severity guard is structural instead: it asks
what fields the data actually has.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass

__all__ = [
    "FORECASTER_POSITIONING",
    "OFFICIAL_AUTHORITY_REFERRAL",
    "SEVERITY_FIELD_NAMES",
    "SafetyAssessment",
    "asks_what_weathra_is",
    "assess",
    "describes_severity",
    "mentions_severe_weather",
]

logger = logging.getLogger("weathra.agents.safety")

# What Weathra is, in the words an answer should use. Stated once so every path says the same thing.
FORECASTER_POSITIONING = (
    "Weathra does not produce its own forecasts. It retrieves forecasts from a named weather "
    "provider, analyses them with deterministic code, and explains the results. Every figure it "
    "reports comes from that provider's model output or from Weathra's own arithmetic over it."
)

OFFICIAL_AUTHORITY_REFERRAL = (
    "For decisions about safety in severe weather, check your official local meteorological "
    "authority — they issue the warnings, and Weathra does not. Weathra is not a warning service "
    "and this is not an alert. What it can tell you is what the provider's data shows, below."
)

# Field names that would actually describe a severe condition. Checked against the *names* a tool
# result carries rather than against the ``Measure`` enum, because a severity field is not a
# measurement and would not be one: a provider supplying warnings would supply an "alerts" block,
# not another number. No provider Weathra supports today carries any of these — see the module
# docstring on why that makes the guard correct rather than idle.
SEVERITY_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "alerts",
        "advisories",
        "warnings",
        "weather_code",
        "weather_codes",
        "severity",
        "severity_index",
        "hazards",
        "watches",
    }
)

# Vocabulary that puts a question in the severe-weather, safety, or emergency space. Generous on
# purpose: see the module docstring on why the asymmetry runs this way.
_SEVERE_WORDS = frozenset(
    {
        "storm",
        "storms",
        "stormy",
        "hurricane",
        "typhoon",
        "cyclone",
        "tornado",
        "blizzard",
        "hail",
        "flood",
        "flooding",
        "floods",
        "gale",
        "gales",
        "squall",
        "thunderstorm",
        "thunderstorms",
        "lightning",
        "thunder",
        "severe",
        "extreme",
        "dangerous",
        "danger",
        "hazard",
        "hazardous",
        "warning",
        "warnings",
        "alert",
        "alerts",
        "emergency",
        "evacuate",
        "evacuation",
        "safe",
        "safety",
        "unsafe",
        "risky",
        "survive",
        "shelter",
        "heatwave",
        "wildfire",
        "whiteout",
        "ice",
        "icy",
        "freeze",
        "frostbite",
        "hypothermia",
    }
)

# Questions about whether it is safe to do something, which are safety questions even without a
# severe-weather noun in them.
_SAFETY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:is|will) it (?:be )?safe\b", re.IGNORECASE),
    re.compile(r"\bshould (?:i|we) (?:travel|drive|fly|go|evacuate|leave|stay)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:safe|dangerous) to (?:travel|drive|fly|go|walk|sail|hike|climb)\b", re.IGNORECASE
    ),
    re.compile(r"\bwill (?:i|we|anyone) be (?:ok|okay|alright|safe)\b", re.IGNORECASE),
)

# Questions about what Weathra itself is or does.
_SELF_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\bdo(?:es)? (?:you|weathra) (?:make|produce|generate|create|run)\b", re.IGNORECASE
    ),
    re.compile(
        r"\b(?:are|is) (?:you|weathra) (?:a )?(?:forecaster|meteorologist)\b", re.IGNORECASE
    ),
    re.compile(r"\byour own forecast", re.IGNORECASE),
    re.compile(
        r"\bwhere do(?:es)? (?:your|weathra'?s?) (?:forecasts?|data) come from\b", re.IGNORECASE
    ),
    re.compile(r"\bhow do(?:es)? (?:you|weathra) (?:forecast|predict|work)\b", re.IGNORECASE),
)

_WORD = re.compile(r"[a-z']+")


def mentions_severe_weather(question: str) -> bool:
    """Whether a question is about severe weather, safety, or an emergency decision."""
    words = frozenset(_WORD.findall(question.lower()))
    return bool(words & _SEVERE_WORDS) or any(
        pattern.search(question) for pattern in _SAFETY_PATTERNS
    )


def asks_what_weathra_is(question: str) -> bool:
    """Whether a question is about Weathra's own role rather than about the weather."""
    return any(pattern.search(question) for pattern in _SELF_PATTERNS)


def describes_severity(field_names: Iterable[str]) -> bool:
    """Whether the retrieved data carries a field that actually describes a severe condition.

    Structural rather than heuristic, and that is the point: a severity *claim* is suppressed
    unless the data supports it, and a suppression rule built on question keywords would be wrong
    in the dangerous direction.
    """
    return bool({name.lower() for name in field_names} & SEVERITY_FIELD_NAMES)


@dataclass(frozen=True, slots=True)
class SafetyAssessment:
    """What a question and its retrieved data together require the answer to say."""

    refer_to_authority: bool
    describe_weathras_role: bool
    severity_supported: bool
    notes: tuple[str, ...] = ()

    @property
    def required_statements(self) -> tuple[str, ...]:
        """The sentences the answer must carry, in the order they should appear."""
        statements: list[str] = []
        if self.refer_to_authority:
            statements.append(OFFICIAL_AUTHORITY_REFERRAL)
        if self.describe_weathras_role:
            statements.append(FORECASTER_POSITIONING)
        statements.extend(self.notes)
        return tuple(statements)

    @property
    def prompt_constraints(self) -> tuple[str, ...]:
        """Instructions to add to the synthesis prompt for this particular answer."""
        constraints: list[str] = []
        if self.refer_to_authority:
            constraints.append(
                "This question concerns severe weather or safety. Direct the reader to their "
                "official local meteorological authority for warnings, state plainly that Weathra "
                "is not a warning service and that this is not an alert, and then report only the "
                "retrieved data with its provider named."
            )
        if not self.severity_supported:
            constraints.append(
                "The retrieved data contains no severity, alert, or warning field. Do NOT assert "
                "that a severe event will or will not occur, and do not characterize severity. "
                "Say what the retrieved measures show, and say that the data does not support a "
                "judgement about severity."
            )
        if self.describe_weathras_role:
            constraints.append(
                "The reader is asking what Weathra is. Weathra retrieves forecasts from a named "
                "provider, analyses them with deterministic code, and explains them. It runs no "
                "weather model of its own and neither does the language model writing this."
            )
        return tuple(constraints)


def assess(question: str, *, retrieved_fields: Iterable[str] = ()) -> SafetyAssessment:
    """What this question, over this data, requires the answer to say.

    Both halves matter and they are independent: a severe-weather question gets a referral whatever
    the data shows, and a severity *claim* is permitted only where the data carries a field for it.
    """
    severe = mentions_severe_weather(question)
    supported = describes_severity(retrieved_fields)

    notes: list[str] = []
    if severe and not supported:
        notes.append(
            "The provider's data for this window carries measurements — temperature, "
            "precipitation, wind — but no severity, alert, or warning field, so Weathra cannot "
            "characterize how severe conditions will be. What it can report is below."
        )

    if severe:
        logger.info("safety referral added: the question concerns severe weather or safety")

    return SafetyAssessment(
        refer_to_authority=severe,
        describe_weathras_role=asks_what_weathra_is(question),
        severity_supported=supported,
        notes=tuple(notes),
    )
