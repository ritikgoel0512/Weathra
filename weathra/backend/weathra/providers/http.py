"""The shared HTTP client and its failure translation (design.md decision 8).

One ``httpx.AsyncClient`` per process, owned by the application lifespan, so connections are pooled
rather than a new TLS handshake per upstream call.

Everything else here is about turning transport reality into the five conditions
``specs/weather-providers`` requires to be distinguishable:

| upstream                          | Weathra                |
|-----------------------------------|------------------------|
| timeout                           | ``ProviderTimeout``    |
| connection refused, DNS failure   | ``ProviderUnavailable``|
| 429                               | ``ProviderRateLimited``|
| 5xx, after the permitted retries  | ``ProviderUnavailable``|
| 4xx other than 429                | ``ProviderUnavailable``|

Retries are bounded and only for the failures that are plausibly transient — a timeout, a
connection error, a 5xx, a 429. A 400 is *not* retried: the request is wrong and repeating it
wastes the caller's latency budget to reach the same answer.

No error carries a response body. Upstream bodies are not ours to forward, may be large, and might
contain a credential we accidentally sent — so a failure names the provider and the status and
stops there.

**Two callers, one loop.** The weather providers GET, and the inference gateway POSTs; both need
exactly this retry and translation. The timing policy differs — an inference call has a minute's
budget where a forecast has ten seconds — so it is a ``RetryPolicy`` argument rather than a read
of ``settings.http_*`` inside the loop. A caller that needs one status handled differently (the
gateway's 401, which is a missing credential and not an outage) passes ``status_error`` rather than
reimplementing the whole thing to change one branch.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from weathra.config import Settings
from weathra.domain.errors import (
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    WeathraError,
)

__all__ = ["RetryPolicy", "build_http_client", "post_json", "request_json"]

logger = logging.getLogger("weathra.providers.http")

# Statuses worth trying again. A 429 is included because upstream rate limits are usually short.
RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504, 522, 524})


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """How patient one kind of upstream call is allowed to be.

    An argument rather than a settings read, because the two upstreams have genuinely different
    budgets: a forecast is on a person's critical path, an inference call is the thing they are
    waiting for.
    """

    timeout_seconds: float
    max_retries: int
    backoff_seconds: float

    @classmethod
    def for_providers(cls, settings: Settings) -> RetryPolicy:
        return cls(
            timeout_seconds=settings.http_timeout_seconds,
            max_retries=settings.http_max_retries,
            backoff_seconds=settings.http_backoff_seconds,
        )

    @classmethod
    def for_inference(cls, settings: Settings) -> RetryPolicy:
        return cls(
            timeout_seconds=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
            backoff_seconds=settings.http_backoff_seconds,
        )

    @property
    def attempts(self) -> int:
        return self.max_retries + 1


def build_http_client(settings: Settings) -> httpx.AsyncClient:
    """The process-wide client. Built once by the lifespan, closed on shutdown."""
    return httpx.AsyncClient(
        timeout=httpx.Timeout(
            settings.http_timeout_seconds,
            connect=settings.http_connect_timeout_seconds,
        ),
        follow_redirects=True,
        headers={"User-Agent": "Weathra/0.1 (+https://github.com/weathra)"},
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )


async def request_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, Any],
    provider: str,
    settings: Settings,
) -> dict[str, Any]:
    """GET a JSON document, retrying bounded and translating every failure.

    Returns the decoded payload. Raises exactly one of the provider error classes — never a bare
    ``httpx`` exception, because nothing above this layer should know what HTTP library is in use.
    """
    policy = RetryPolicy.for_providers(settings)
    return await _send_json(
        lambda: client.get(url, params=params), provider=provider, policy=policy
    )


async def post_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    payload: dict[str, Any],
    headers: dict[str, str],
    provider: str,
    policy: RetryPolicy,
    status_error: Callable[[int], WeathraError | None] | None = None,
) -> dict[str, Any]:
    """POST a JSON document under the same retry and translation rules.

    ``status_error`` gets first refusal on a non-success status. The inference gateway uses it to
    turn a 401 into a configuration error: a rejected credential is not an upstream outage, and
    reporting it as one would send an operator looking at the wrong thing.
    """
    return await _send_json(
        lambda: client.post(url, json=payload, headers=headers, timeout=policy.timeout_seconds),
        provider=provider,
        policy=policy,
        status_error=status_error,
    )


async def _send_json(
    send: Callable[[], Awaitable[httpx.Response]],
    *,
    provider: str,
    policy: RetryPolicy,
    status_error: Callable[[int], WeathraError | None] | None = None,
) -> dict[str, Any]:
    """The retry loop and the failure translation, shared by both verbs."""
    last_error: Exception | None = None

    for attempt in range(1, policy.attempts + 1):
        try:
            response = await send()
        except httpx.TimeoutException as exc:
            last_error = exc
            if attempt < policy.attempts:
                await _backoff(policy, attempt)
                continue
            raise ProviderTimeout(
                f"{provider} did not respond within {policy.timeout_seconds:g}s.",
                details={"provider": provider, "attempts": attempt},
            ) from exc
        except httpx.HTTPError as exc:
            # Connection refused, DNS failure, a broken stream: reachability, not a bad request.
            last_error = exc
            if attempt < policy.attempts:
                await _backoff(policy, attempt)
                continue
            raise ProviderUnavailable(
                f"{provider} could not be reached.",
                details={"provider": provider, "attempts": attempt, "reason": type(exc).__name__},
            ) from exc

        if status_error is not None and response.status_code >= 400:
            # Consulted before the retry decision: a rejected credential will be rejected again,
            # so retrying it only delays the error an operator needs to see.
            specific = status_error(response.status_code)
            if specific is not None:
                raise specific

        if response.status_code in RETRYABLE_STATUSES and attempt < policy.attempts:
            logger.info(
                "retrying %s after status %s (attempt %s of %s)",
                provider,
                response.status_code,
                attempt,
                policy.attempts,
            )
            await _backoff(policy, attempt)
            continue

        if response.status_code == 429:
            raise ProviderRateLimited(
                f"{provider} rate-limited the request.",
                details={"provider": provider, "status": 429, "attempts": attempt},
            )

        if response.status_code >= 400:
            # Deliberately no body. A 4xx here means Weathra built a bad request, which is a bug
            # to fix from the logs rather than something to forward to a caller.
            logger.warning(
                "%s returned status %s for %s", provider, response.status_code, response.url.path
            )
            raise ProviderUnavailable(
                f"{provider} rejected the request with status {response.status_code}.",
                details={
                    "provider": provider,
                    "status": response.status_code,
                    "attempts": attempt,
                },
            )

        try:
            decoded = response.json()
        except ValueError as exc:
            raise ProviderUnavailable(
                f"{provider} returned a response that was not valid JSON.",
                details={"provider": provider, "status": response.status_code},
            ) from exc

        if not isinstance(decoded, dict):
            raise ProviderUnavailable(
                f"{provider} returned a response in an unexpected shape.",
                details={"provider": provider, "status": response.status_code},
            )
        return decoded

    # Only reachable if every attempt was a retryable status.
    raise ProviderUnavailable(
        f"{provider} was still failing after {policy.attempts} attempts.",
        details={
            "provider": provider,
            "attempts": policy.attempts,
            "reason": type(last_error).__name__ if last_error else "retryable_status",
        },
    )


async def _backoff(policy: RetryPolicy, attempt: int) -> None:
    """Linear backoff. Deliberately not exponential: the ceiling is two or three attempts inside a
    ten-second budget, so a doubling delay would spend the budget waiting rather than trying."""
    delay = policy.backoff_seconds * attempt
    if delay > 0:
        await asyncio.sleep(delay)
