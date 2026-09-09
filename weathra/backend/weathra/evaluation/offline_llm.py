"""Offline mode's language model: a faithful stand-in, not a script that says nothing.

An earlier version of this handed the synthesis node a fixed sentence with no figures in it, on the
theory that a script supplying numbers would mean the run measured the script. That reasoning was
half right and the result was useless: numerical calculation accuracy asks whether the *asserted
figure* equals the deterministic reference, and an answer asserting no figure fails that by
construction. The metric read 0% for a pipeline that was computing correctly.

So this client does what a well-behaved model does, and nothing more: it reads the findings out of
the prompt it was given and states them. It invents nothing, computes nothing, and rounds nothing.
That is the distinction that matters — the numbers come from the findings *code produced and handed
over*, so numerical accuracy measures the pipeline (did the analytics compute the right value, and
did the envelope carry it) rather than measuring a hard-coded string.

**What offline mode therefore does and does not measure.** It measures execution: tool selection
against the plan, the arithmetic, grounding, attribution, retrieval, memory resolution, and the
API. It does *not* measure whether a real model would have routed correctly or worded an answer
well, because the plan is derived from the case's own expectations. Live mode measures those, and
tool-selection accuracy is the metric that shows the difference.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

from weathra.agents.llm.base import Completion, Message, Role, TokenUsage, validate_against

__all__ = ["OfflineLLMClient"]

logger = logging.getLogger("weathra.evaluation.offline_llm")

OFFLINE_PROVIDER_ID = "offline"
OFFLINE_MODEL_ID = "weathra-offline-faithful-1"


class OfflineLLMClient:
    """Returns the run's derived plan, and prose stating the findings it was handed.

    Satisfies ``LLMClient`` structurally, like the fake and the gateway client do.
    """

    def __init__(
        self,
        *,
        plans: Sequence[dict[str, Any]],
        provider_id: str = OFFLINE_PROVIDER_ID,
        model_id: str = OFFLINE_MODEL_ID,
    ) -> None:
        """The identity is a parameter so a comparison can tell its candidates apart.

        It defaults to the offline constants, so every existing caller behaves exactly as before.
        A model comparison running offline needs each candidate's result attributed to *that*
        candidate — otherwise three candidates produce three identical records naming the offline
        client, and the comparison compares nothing. What varies offline is only the recorded
        identity, which is honest: an offline run measures the deterministic path, and the run
        record says it ran offline.
        """
        if not plans:  # pragma: no cover - the harness always derives at least one
            raise ValueError("An offline client needs at least one derived plan.")
        self.provider_id = provider_id
        self.model_id = model_id
        self._plans = list(plans)
        self.json_calls = 0
        self.prose_calls = 0

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        """The plan derived from *this turn's* question, validated like any other.

        Turns are consumed in order, and the last plan repeats if a run somehow asks again — a
        multi-turn case is several full runs, and each one routes for the question it was given.
        """
        index = min(self.json_calls, len(self._plans) - 1)
        self.json_calls += 1
        return validate_against(self._plans[index], schema)

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        """Prose stating every finding the prompt supplied, and no figure it did not."""
        self.prose_calls += 1
        findings = _findings_in(messages)
        passages = _passages_in(messages)
        notes = _notes_in(messages)

        sentences: list[str] = []

        for finding in findings:
            sentences.append(_state(finding))

        if passages:
            documents = ", ".join(dict.fromkeys(passage["document_id"] for passage in passages))
            sentences.append(
                f"This draws on Weathra's knowledge base: {documents}. "
                + " ".join(passage["text"] for passage in passages[:2])
            )

        sentences.extend(notes)

        if not sentences:
            sentences.append(
                "Weathra retrieved nothing for this question, so there is nothing to report."
            )

        return Completion(
            text=" ".join(sentences),
            provider_id=self.provider_id,
            model_id=self.model_id,
            usage=TokenUsage(),
            finish_reason="stop",
        )


def _state(finding: dict[str, Any]) -> str:
    """One finding as a sentence, naming its place, with its value exactly as supplied.

    The place is named because the synthesis prompt instructs it — "name the place and the time
    period the results cover" — and a stand-in that ignored an instruction a real model follows
    would make the evaluation measure the stand-in. The findings block supplies it, so naming it
    invents nothing.

    ``.10g`` rather than a rounding: a figure handed over as 11.857142857 is stated as
    11.857142857, because rounding here would be the model introducing a number — the very thing
    the prompt forbids and the grounding audit reports.
    """
    label = finding.get("label", "value")
    place = finding.get("location")
    where = f" in {place}" if place else ""

    if finding.get("available") is False:
        return f"{label}{where}: not available ({finding.get('why_unavailable', 'not reported')})."

    value = finding.get("value")
    if isinstance(value, str):
        return f"{label}{where}: {value}."
    if value is None:
        return f"{label}{where}: not available."

    unit = finding.get("unit")
    stated = f"{label}{where} is {value:.10g}{f' {unit}' if unit else ''}"
    method = finding.get("method")
    points = finding.get("points_used")
    if method and points:
        return f"{stated} ({method}, {points} points)."
    return f"{stated}."


def _tool_message(messages: Sequence[Message], name: str) -> str | None:
    for message in messages:
        if message.role is Role.TOOL and message.name == name:
            return message.content
    return None


def _findings_in(messages: Sequence[Message]) -> list[dict[str, Any]]:
    """The findings block the synthesis prompt supplied, parsed."""
    content = _tool_message(messages, "weather_results")
    if not content:
        return []
    try:
        parsed = json.loads(content)
    except ValueError:  # pragma: no cover - the prompt builds this itself
        logger.warning("the findings block was not valid JSON")
        return []
    return [entry for entry in parsed if isinstance(entry, dict)]


def _passages_in(messages: Sequence[Message]) -> list[dict[str, Any]]:
    content = _tool_message(messages, "knowledge_passages")
    if not content:
        return []
    try:
        parsed = json.loads(content)
    except ValueError:  # pragma: no cover
        return []
    return [entry for entry in parsed if isinstance(entry, dict)]


def _notes_in(messages: Sequence[Message]) -> list[str]:
    """The failures and unanswered parts the prompt named, restated as the prompt asks.

    Restated rather than dropped: ``specs/agent-orchestration`` requires an unanswerable part to be
    named in the answer, and a model that quietly omitted it would fail that requirement — so the
    stand-in does what a compliant model would.
    """
    notes: list[str] = []
    for message in messages:
        if message.role is not Role.USER:
            continue
        if (
            "must be reported as such" in message.content
            or "named as unanswered" in message.content
        ):
            notes.extend(
                line.lstrip("- ").strip()
                for line in message.content.splitlines()
                if line.strip().startswith("-")
            )
    return notes
