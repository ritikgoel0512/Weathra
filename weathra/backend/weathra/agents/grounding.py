"""Grounding enforcement: three layers, honestly bounded (design.md decision 15).

The system prompt in ``nodes/synthesize.py`` is layer one. It is necessary and not sufficient — a
prompt is a request. The two layers here are what hold when the request is ignored, and they are
deliberately different in kind:

**Layer two: the hard guard.** If the prose contains a numeric weather figure while the run
retrieved and computed *nothing*, the prose is discarded and the response says it could not answer
from retrieved data. Deterministic, unconditional, and the one place grounding suppresses an
answer. A model inventing a temperature for a run that fetched no weather is not a rounding
disagreement; it is fabrication, and there is no false positive to protect.

**Layer three: the numeric audit.** Figures in the prose are extracted and matched against the
findings and the evidence within a tolerance. Unmatched figures are *reported* in
``ungrounded_figures`` with ``verified: false`` — not suppressed. This is the deliberate asymmetry:
a legitimately rounded or converted value ("about 12 °C" for 11.8) would otherwise destroy a
correct answer, and destroying correct answers to catch a reporting-grade problem is the wrong
trade. The report ships with the response and the full evidence record ships with it, which is what
actually makes a figure checkable.

**What the audit deliberately does not do is accept unit conversions.** An earlier version treated
every recorded value's Celsius-to-Fahrenheit and millimetre-to-inch equivalents as support, on the
theory that a converted figure is not an invented one. That made the audit useless: with twenty
recorded values and seven conversions each, a 0.5 tolerance matched almost any number a model could
write — 8.5 °C converts to 47.3 °F, so "Berlin will reach 47.3 °C" verified clean. The findings are
already in the unit system the request asked for and the synthesis prompt forbids converting, so a
converted figure in the prose is something a reader should check. Layer three only *reports*, so
the cost of flagging it is a line in the response rather than a lost answer — and the cost of
missing an invented figure is the whole point of the audit.

**It is a heuristic and is described as one.** It matches within a rounding tolerance and ignores
figures that are plainly not measurements. It will occasionally flag a legitimately rounded value
and occasionally miss an invented one. ``GroundingReport.method`` says so in the response, and
``docs/privacy-ethics.md`` and the evaluation methodology say so at length. Reporting a heuristic
as a proof would be its own kind of ungrounded claim.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from weathra.agents.state import GraphState
from weathra.domain.evidence import GroundingReport

__all__ = [
    "AUDIT_METHOD",
    "NO_RETRIEVAL_MESSAGE",
    "audit_prose",
    "check_grounding",
    "figures_in",
]

logger = logging.getLogger("weathra.agents.grounding")

# Absolute tolerance for matching a figure to a recorded value. 0.5 covers the two things a model
# legitimately does to a number it was given — rounding to a whole degree, and rounding to one
# decimal — without being so wide that a different day's reading would match by accident.
ROUNDING_TOLERANCE = 0.5

# Relative tolerance, for the large values where an absolute one is meaningless: 1200 mm reported
# as "about 1,200 mm" should match, and 0.5 mm of slack would not help.
RELATIVE_TOLERANCE = 0.02

AUDIT_METHOD = (
    "Numeric figures were extracted from the prose and matched against the run's findings, "
    "analytics results, and retrieved series within an absolute tolerance of "
    f"{ROUNDING_TOLERANCE:g} or a relative tolerance of {RELATIVE_TOLERANCE:.0%}. Four-digit "
    "years are excluded as not being measurements. Unit-converted equivalents are deliberately "
    "*not* accepted: the figures supplied to the writer are already in the requested unit system, "
    "so a converted value is one to check. This is a reporting heuristic, not a proof: it can "
    "flag a legitimately rounded value and can miss an invented one, which is why an unmatched "
    "figure is reported rather than suppressed."
)

NO_RETRIEVAL_MESSAGE = (
    "Weathra could not answer this from retrieved data. Nothing was retrieved or computed for this "
    "question, so there are no figures to report and nothing has been written in their place."
)

# A number in prose, with optional thousands separators and sign: "11.8", "-3", "1,200".
_NUMBER = re.compile(r"(?<![\w.])(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(?![\w])")

# Figures that are not measurements. A four-digit year and a small day count are the two that come
# up constantly and would otherwise dominate the ungrounded list.
_YEAR = re.compile(r"^(19|20)\d{2}$")


def figures_in(prose: str) -> tuple[float, ...]:
    """Every number in the prose that could be a weather figure, in order.

    Excludes years, because "since 1991" is not a claim about a temperature, and the audit's job is
    to check figures a reader would take as measurements.
    """
    found: list[float] = []
    for match in _NUMBER.finditer(prose):
        whole = match.group(1).replace(",", "")
        fraction = match.group(2)
        text = f"{whole}.{fraction}" if fraction else whole
        if fraction is None and _YEAR.match(whole):
            continue
        try:
            found.append(float(text))
        except ValueError:  # pragma: no cover - the pattern guarantees a parseable number
            continue
    return tuple(found)


def _grounded_values(state: GraphState) -> tuple[float, ...]:
    """Every number the run actually recorded, from every place one could legitimately come from.

    Generous on purpose. The audit's failure mode that matters is a false positive — flagging a
    figure the run does have — so anything the run genuinely recorded counts as support: the
    findings, the analytics payloads, and the retrieved series themselves.
    """
    values: list[float] = []

    for finding in state.findings:
        if finding.value is not None:
            values.append(finding.value)
        if finding.points_used is not None:
            values.append(float(finding.points_used))

    for payload in state.analytics_payloads:
        values.extend(_numbers_within(payload))

    for retrieval in state.retrievals:
        for series in (retrieval.daily, retrieval.hourly):
            if series is None:
                continue
            for entry in series.entries:
                values.extend(value for value in entry.values.values() if value is not None)

    return tuple(values)


def _numbers_within(payload: Any, depth: int = 0) -> list[float]:
    """Every number nested anywhere inside a tool payload."""
    if depth > 6:  # pragma: no cover - tool payloads are shallow
        return []
    if isinstance(payload, bool):
        return []
    if isinstance(payload, int | float):
        return [float(payload)]
    if isinstance(payload, dict):
        return [value for item in payload.values() for value in _numbers_within(item, depth + 1)]
    if isinstance(payload, list | tuple):
        return [value for item in payload for value in _numbers_within(item, depth + 1)]
    return []


def _matches(figure: float, candidate: float) -> bool:
    """Whether a figure in the prose is the same number as one the run recorded."""
    if abs(figure - candidate) <= ROUNDING_TOLERANCE:
        return True
    scale = max(abs(figure), abs(candidate))
    return scale > 0 and abs(figure - candidate) / scale <= RELATIVE_TOLERANCE


def audit_prose(state: GraphState) -> tuple[bool, tuple[str, ...], int]:
    """Match every figure in the prose against the run's recorded values.

    Returns whether everything matched, the unmatched figures as they were written, and how many
    were checked.
    """
    figures = figures_in(state.answer_prose)
    if not figures:
        return True, (), 0

    supported = _grounded_values(state)

    unmatched: list[str] = []
    for figure in figures:
        if not any(_matches(figure, candidate) for candidate in supported):
            unmatched.append(f"{figure:g}")

    return not unmatched, tuple(unmatched), len(figures)


def check_grounding(state: GraphState) -> tuple[GraphState, GroundingReport]:
    """Apply layers two and three, and produce the report the envelope carries.

    Returns the state — with the prose replaced when the hard guard fires — and the report.
    """
    figures = figures_in(state.answer_prose)

    # ---------------------------------------------------------------- layer two: the hard guard
    if figures and not state.retrieval_happened:
        logger.warning(
            "discarding synthesized prose: %d figures with no retrieval in the run", len(figures)
        )
        return (
            state.with_updates(answer_prose=NO_RETRIEVAL_MESSAGE),
            GroundingReport(
                verified=False,
                method=AUDIT_METHOD,
                figures_checked=len(figures),
                ungrounded_figures=tuple(f"{figure:g}" for figure in figures),
                prose_discarded=True,
                note=(
                    "The written answer contained weather figures while nothing had been "
                    "retrieved or computed, so it was discarded rather than shown."
                ),
            ),
        )

    # ---------------------------------------------------------------- layer three: the audit
    verified, ungrounded, checked = audit_prose(state)

    if verified:
        return state, GroundingReport(
            verified=True,
            method=AUDIT_METHOD,
            figures_checked=checked,
            note=(
                "Every figure in the answer matched a value in the evidence record."
                if checked
                else "The answer contains no numeric figures to check."
            ),
        )

    logger.info("grounding audit reported %d unmatched figure(s)", len(ungrounded))
    return state, GroundingReport(
        verified=False,
        method=AUDIT_METHOD,
        figures_checked=checked,
        ungrounded_figures=ungrounded,
        prose_discarded=False,
        note=(
            "These figures in the written answer could not be matched to a value in the evidence "
            "record. The answer is shown as written, because a legitimately rounded or converted "
            "value would otherwise be suppressed as an error — check them against the evidence."
        ),
    )
