"""The OpenRouter client: one POST, over the shared HTTP client, with no vendor SDK.

Design.md decision 3. The surface needed is a single chat-completions POST, so a vendor SDK would
be a dependency, a release cadence, and a coupling ``specs/agent-orchestration`` forbids — in
exchange for a function that fits on a screen.

**Everything about it is configuration.** The model id, the base URL, the timeout, the retry count
and the credential all come from ``Settings``. There is no model name in this file, which is what
task 13.6's test asserts against the whole backend: changing ``LLM_MODEL`` to another gateway model
answers with it and needs no code change.

**Failure translation, and the one case that is not an outage.**

| gateway                    | Weathra                                  |
|----------------------------|------------------------------------------|
| timeout                    | ``ProviderTimeout``                      |
| connection refused, DNS    | ``ProviderUnavailable``                  |
| 429                        | ``ProviderRateLimited``                  |
| 5xx after the retries      | ``ProviderUnavailable``                  |
| **401 / 403**              | **``AgentNotConfigured``**               |
| 4xx otherwise              | ``ProviderUnavailable``                  |

The 401 is the interesting row. A rejected credential is not an upstream failure and must not be
retried or reported as one: retrying sends the same bad key again, and "the provider is
unavailable" sends an operator to a status page when the answer is on their own settings screen. So
it is translated to the same error a *missing* credential produces, because from the caller's side
those are one condition — the agent surface is not configured — while every other capability keeps
working.

**Identity comes off the response where the gateway reports it.** OpenRouter echoes the model it
actually served, which can differ from the one requested when a route falls back. Recording what
answered rather than what was asked for is what makes the evidence record's provider-and-model line
worth reading.

**JSON mode is prompt-and-validate, bounded.** OpenRouter's ``response_format`` support varies by
underlying model, so relying on it would make ``complete_json`` work for some configured models and
not others. Instead the schema goes in the prompt and the reply is validated here, with the
validation error appended and one more attempt spent — up to ``LLM_JSON_MAX_ATTEMPTS``. A model
that cannot produce a valid routing decision in three tries is not going to on the fourth, and the
budget belongs to the person waiting.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

import httpx
from pydantic import BaseModel

from weathra.agents.llm.base import (
    JSON_INSTRUCTION,
    Completion,
    Message,
    Role,
    TokenUsage,
    extract_json_object,
    validate_against,
)
from weathra.config import Settings
from weathra.domain.errors import (
    AGENT_UNAVAILABLE_MESSAGE,
    AgentNotConfigured,
    ProviderUnavailable,
    ValidationFailed,
    WeathraError,
)
from weathra.providers.http import RetryPolicy, post_json

__all__ = ["OPENROUTER_PROVIDER_ID", "OpenRouterClient"]

logger = logging.getLogger("weathra.agents.llm.openrouter")

OPENROUTER_PROVIDER_ID = "openrouter"

# Statuses that mean the credential, not the gateway. Retrying either is pointless.
_CREDENTIAL_STATUSES = frozenset({401, 403})


class OpenRouterClient:
    """A chat-completions client. Satisfies ``LLMClient`` structurally."""

    provider_id = OPENROUTER_PROVIDER_ID

    def __init__(self, *, client: httpx.AsyncClient, settings: Settings) -> None:
        credential = settings.openrouter_api_key
        if credential is None:
            # Constructed only where inference is genuinely required, and this is the guard that
            # makes that true rather than conventional (``specs/agent-orchestration``).
            raise AgentNotConfigured(
                AGENT_UNAVAILABLE_MESSAGE,
                # `missing` is the operator's half: it reaches the log and the evidence record,
                # never the screen.
                details={"missing": "inference_credential", "provider": OPENROUTER_PROVIDER_ID},
            )

        self.model_id = settings.llm_model
        self._credential = credential
        self._client = client
        self._settings = settings
        self._policy = RetryPolicy.for_inference(settings)
        self._url = f"{settings.openrouter_base_url.rstrip('/')}/chat/completions"

    # ---------------------------------------------------------------- the contract

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        payload = await self._post(self._body(system, messages))
        return self._completion(payload)

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        """Prompt for JSON, validate, and retry a bounded number of times with the error.

        The retry carries the model's own reply *and* the validation error, in that order, because
        a model correcting its output needs to see what it said as well as what was wrong with it.
        """
        attempts = self._settings.llm_json_max_attempts
        conversation = list(messages)
        instruction = f"{system}\n\n{JSON_INSTRUCTION}\n{json.dumps(schema.model_json_schema())}"
        last_error: ValidationFailed | None = None

        for attempt in range(1, attempts + 1):
            payload = await self._post(self._body(instruction, conversation))
            completion = self._completion(payload)

            try:
                return validate_against(extract_json_object(completion.text), schema)
            except ValidationFailed as exc:
                last_error = exc
                if attempt == attempts:
                    break
                logger.info(
                    "JSON attempt %s of %s failed schema %s; retrying with the error",
                    attempt,
                    attempts,
                    schema.__name__,
                )
                conversation = [
                    *conversation,
                    Message.assistant(completion.text),
                    Message.user(
                        f"That was not accepted: {exc}. Reply again with only a JSON object "
                        f"matching the schema."
                    ),
                ]

        raise ValidationFailed(
            f"The model did not produce a valid {schema.__name__} in {attempts} attempts. "
            f"Last error: {last_error}",
            details={
                "schema": schema.__name__,
                "attempts": attempts,
                "provider": self.provider_id,
                "model": self.model_id,
            },
        )

    # ---------------------------------------------------------------- transport

    def _headers(self) -> dict[str, str]:
        """The request headers. The credential goes here and nowhere else — never a query
        parameter, which would land in an access log."""
        return {
            "Authorization": f"Bearer {self._credential.get_secret_value()}",
            "Content-Type": "application/json",
            # OpenRouter asks callers to identify themselves; both are public identifiers.
            "HTTP-Referer": "https://github.com/weathra",
            "X-Title": "Weathra",
        }

    def _body(self, system: str, messages: Sequence[Message]) -> dict[str, Any]:
        """Weathra's messages in the gateway's shape. The one place the two vocabularies meet."""
        wire: list[dict[str, str]] = [{"role": "system", "content": system}]
        for message in messages:
            if message.role is Role.TOOL:
                # No tool-call protocol here: the graph executes tools itself and hands results
                # back as content (design.md decision 2). Labelling whose result it is keeps the
                # model from having to guess, and keeps the content unambiguously data.
                label = message.name or "unknown"
                wire.append(
                    {"role": "user", "content": f"Result of tool {label}:\n{message.content}"}
                )
            else:
                wire.append({"role": message.role.value, "content": message.content})

        return {"model": self.model_id, "messages": wire}

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        return await post_json(
            self._client,
            self._url,
            payload=body,
            headers=self._headers(),
            provider=self.provider_id,
            policy=self._policy,
            status_error=self._status_error,
        )

    def _status_error(self, status: int) -> WeathraError | None:
        """Classify the two statuses a retry loop must not treat as transient.

        **401 and 403 are different problems and must not be reported alike.** A 401 is the
        credential: absent, or genuinely not valid. A 403 is the gateway refusing a request whose
        credential it accepted — the account's data policy for a `:free` model, a model this key
        may not route to, or a moderation refusal. Collapsing them cost this project a wrong first
        guess: production reported "the credential was rejected" and the only remedy anyone could
        see was to replace a key that may never have been wrong.

        So they raise different errors, which matters beyond the log. `AgentNotConfigured` records
        `not_configured` in the evidence; a 403 records `provider_error` through
        `ProviderUnavailable`, because "nobody configured this" is a false statement about a
        deployment whose key the gateway just accepted. What a *person* is shown is the same
        sentence either way — they can act on neither, and both mean the same thing to them.

        **What a person is told, and why it is not what the log says.** The message reaches a
        weather screen, so it says what is unavailable and what still works. It names no
        environment variable, no credential and no provider setting: an operator's checklist read
        out to a visitor is useless to them and a small disclosure of how the service is wired.
        """
        if status not in _CREDENTIAL_STATUSES:
            return None

        if status == 401:
            logger.warning(
                "the inference gateway rejected the credential (401): it is absent or not valid. "
                "Surrounding whitespace and a copied `Bearer ` prefix are normalised before use, "
                "so packaging is not the cause"
            )
            return AgentNotConfigured(
                AGENT_UNAVAILABLE_MESSAGE,
                # The status, not the body: a gateway's rejection message is not ours to forward,
                # and the credential itself must never appear in an error a caller can see.
                details={"provider": self.provider_id, "status": status},
            )

        logger.warning(
            "the inference gateway refused the request (403): the credential was accepted but the "
            "account or the model declined it — check the account's data policy for the configured "
            "model and its routing permissions. This is not a credential to replace"
        )
        return ProviderUnavailable(
            AGENT_UNAVAILABLE_MESSAGE,
            details={"provider": self.provider_id, "status": status},
        )

    # ---------------------------------------------------------------- response reading

    def _completion(self, payload: dict[str, Any]) -> Completion:
        """The gateway's response as a ``Completion``, or a clear failure.

        A reply with no choices is a gateway that answered without answering. It is reported as
        unavailability rather than returned as an empty completion, because an empty string
        travelling into an answer would be presented to a person as Weathra having nothing to say.
        """
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderUnavailable(
                "The inference provider returned no completion.",
                details={"provider": self.provider_id, "model": self.model_id},
            )

        first: dict[str, Any] = choices[0] if isinstance(choices[0], dict) else {}
        raw_message = first.get("message")
        message: dict[str, Any] = raw_message if isinstance(raw_message, dict) else {}
        content = message.get("content")
        if not isinstance(content, str):
            raise ProviderUnavailable(
                "The inference provider's completion carried no text.",
                details={"provider": self.provider_id, "model": self.model_id},
            )

        return Completion(
            text=content,
            provider_id=self.provider_id,
            # What answered, which is not always what was asked for.
            model_id=str(payload.get("model") or self.model_id),
            usage=_usage(payload.get("usage")),
            finish_reason=(
                str(first["finish_reason"]) if isinstance(first.get("finish_reason"), str) else None
            ),
        )


def _usage(reported: object) -> TokenUsage:
    """Token counts when the gateway reports them, and no invented zeros when it does not."""
    if not isinstance(reported, dict):
        return TokenUsage()

    def count(key: str) -> int | None:
        value = reported.get(key)
        return int(value) if isinstance(value, int | float) and value >= 0 else None

    return TokenUsage(
        prompt_tokens=count("prompt_tokens"),
        completion_tokens=count("completion_tokens"),
        total_tokens=count("total_tokens"),
    )
