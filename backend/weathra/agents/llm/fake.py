"""A scripted client that satisfies the contract, and is what the test suite actually runs on.

Design.md decision 3: ``FakeLLMClient`` implements the Protocol from a scripted sequence, and it is
what the entire test suite and offline evaluation mode use. That is not a convenience — it is what
makes ``specs/agent-orchestration``'s "the suite runs with no inference credential and no network
access" achievable, and it is why ``anthropic`` and every other vendor SDK is absent from the
runtime dependencies.

**A real implementation, not a mock.** It returns ``Completion`` objects, reports a provider and a
model id, counts its calls, and raises the same errors on the same conditions. A test that passes
against this and fails against OpenRouter has found a difference in the *gateway*, not in the
scaffolding — which is the only kind of difference worth a live test.

**Scripts, not stubs.** Responses come from an ordered sequence, so a test can drive a whole
multi-step routing decision through one client and assert on the order the graph asked in. Running
off the end of the script raises rather than repeating the last answer: a graph that made one more
call than the test expected is a finding, not something to paper over.

**JSON is scripted as objects, not as text.** ``FakeLLMClient`` can be handed either. Objects are
for the ordinary case where the test cares about the routing decision; raw strings are for the
tests that exist *because* a model emitted something malformed, which is how the retry behaviour in
``base.extract_json_object`` gets exercised against realistic mess.
"""

from __future__ import annotations

import json
import logging
from collections import deque
from collections.abc import Iterable, Mapping, Sequence

from pydantic import BaseModel

from weathra.agents.llm.base import (
    Completion,
    Message,
    TokenUsage,
    extract_json_object,
    validate_against,
)
from weathra.domain.errors import ValidationFailed

__all__ = ["FakeLLMClient", "ScriptExhausted"]

logger = logging.getLogger("weathra.agents.llm.fake")

FAKE_PROVIDER_ID = "fake"
FAKE_MODEL_ID = "weathra-fake-1"


class ScriptExhausted(AssertionError):
    """The graph asked for more completions than the test scripted.

    An ``AssertionError`` rather than a Weathra error: this is never a runtime condition, only a
    test that under-specified what it expected. Repeating the last scripted answer instead would
    let an extra model call pass unnoticed, which for a step-budgeted graph is exactly the bug
    worth catching.
    """


class FakeLLMClient:
    """A client that answers from a script. Satisfies ``LLMClient`` structurally."""

    def __init__(
        self,
        *,
        completions: Iterable[str | Completion] = (),
        json_responses: Iterable[Mapping[str, object] | BaseModel | str] = (),
        failure: Exception | None = None,
        provider_id: str = FAKE_PROVIDER_ID,
        model_id: str = FAKE_MODEL_ID,
    ) -> None:
        self.provider_id = provider_id
        self.model_id = model_id
        self._completions: deque[str | Completion] = deque(completions)
        self._json: deque[Mapping[str, object] | BaseModel | str] = deque(json_responses)
        self._failure = failure

        # What the client was asked, in order, so a test can assert on the conversation the graph
        # built rather than only on what came back.
        self.prompts: list[tuple[str, tuple[Message, ...]]] = []
        self.json_prompts: list[tuple[str, tuple[Message, ...], type[BaseModel]]] = []

    # ---------------------------------------------------------------- the contract

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        self.prompts.append((system, tuple(messages)))
        if self._failure is not None:
            raise self._failure
        if not self._completions:
            raise ScriptExhausted(
                f"{len(self.prompts)} prose completions were requested but the script held "
                f"{len(self.prompts) - 1}. Add the completion the graph expects, or find out why "
                "it made an extra call."
            )

        scripted = self._completions.popleft()
        if isinstance(scripted, Completion):
            return scripted
        return Completion(
            text=scripted,
            provider_id=self.provider_id,
            model_id=self.model_id,
            usage=TokenUsage(),
            finish_reason="stop",
        )

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        """Return the next scripted JSON response, validated against ``schema``.

        Validated, not trusted. A test that scripts an object the schema rejects should see the
        same ``ValidationFailed`` a real model's bad output would produce — otherwise the fake is
        more permissive than the thing it stands in for, and a node's error handling never runs.
        """
        self.json_prompts.append((system, tuple(messages), schema))
        if self._failure is not None:
            raise self._failure
        if not self._json:
            raise ScriptExhausted(
                f"{len(self.json_prompts)} JSON completions were requested but the script held "
                f"{len(self.json_prompts) - 1}. Add the response the graph expects, or find out "
                "why it made an extra call."
            )

        scripted = self._json.popleft()

        if isinstance(scripted, BaseModel):
            # Serialized and re-validated on purpose: a test scripting a *different* model class
            # that happens to have compatible fields should still be checked against the schema
            # the caller asked for.
            return validate_against(json.loads(scripted.model_dump_json()), schema)
        if isinstance(scripted, str):
            return validate_against(extract_json_object(scripted), schema)
        return validate_against(scripted, schema)

    # ---------------------------------------------------------------- test conveniences

    @property
    def call_count(self) -> int:
        return len(self.prompts) + len(self.json_prompts)

    @property
    def exhausted(self) -> bool:
        return not self._completions and not self._json

    def last_system_prompt(self) -> str:
        """The system prompt of the most recent call, whichever method it went through."""
        if not self.prompts and not self.json_prompts:
            raise AssertionError("the client has not been called")
        if self.json_prompts and (not self.prompts or len(self.json_prompts) >= len(self.prompts)):
            return self.json_prompts[-1][0]
        return self.prompts[-1][0]

    def all_content(self) -> list[str]:
        """Every message body the client was ever handed.

        For the prompt-injection tests: the assertion is that a hostile string arrived as content
        and changed nothing, and that needs the content it actually saw.
        """
        seen: list[str] = []
        for _, messages in self.prompts:
            seen.extend(message.content for message in messages)
        for _, messages, _ in self.json_prompts:
            seen.extend(message.content for message in messages)
        return seen


def scripted_failure(message: str = "the gateway is unavailable") -> FakeLLMClient:
    """A client that fails every call, for the degradation paths."""
    return FakeLLMClient(failure=ValidationFailed(message))
