"""Building a client for a resolution, and the only place a gateway client is constructed.

`specs/model-policy` forbids any supervisor, node or route from constructing a client bound to a
model it chose. That is enforced three ways, and this module is the first: every gateway client in
the process comes from here, so "who decided this model" has exactly one answer.

**One client per resolved model per call role.** A run performs a structured routing decision and
then a prose synthesis, and a plan may map those two roles to different policies — so one run can
legitimately hold two clients, same gateway, different `model_id`. That is why the model is a
constructor argument rather than a process-wide setting: a single shared client could not represent
it, and the graph would have to re-resolve or pick one.

**The fake is not reachable from here.** `registry.py` explains why at length and the reason is
unchanged: a deployment that could reach a scripted client by configuration could answer a person's
weather question from a script. Tests install a fake through the broker's override, which is a test
seam rather than a configuration one.
"""

from __future__ import annotations

import logging

import httpx

from weathra.agents.llm.base import LLMClient
from weathra.agents.llm.openrouter import OPENROUTER_PROVIDER_ID, OpenRouterClient
from weathra.config import Settings
from weathra.domain.entitlements import Resolution
from weathra.domain.errors import ProviderNotFound

__all__ = ["build_for_resolution"]

logger = logging.getLogger("weathra.agents.llm.factory")


def build_for_resolution(
    resolution: Resolution, *, http: httpx.AsyncClient, settings: Settings
) -> LLMClient:
    """A client bound to exactly the model the resolver chose.

    The gateway comes from the resolution rather than from configuration, because the catalog row
    is what says which gateway serves an entry — configuration says which gateway is *default*, and
    those stop being the same thing the moment a second one is added. An unknown gateway is a
    `ProviderNotFound` listing what is registered, not a `KeyError`.
    """
    if resolution.gateway_provider != OPENROUTER_PROVIDER_ID:
        raise ProviderNotFound(
            f"{resolution.gateway_provider!r} is not a registered inference gateway. "
            f"Available: {OPENROUTER_PROVIDER_ID}.",
            details={
                "requested": resolution.gateway_provider,
                "available": (OPENROUTER_PROVIDER_ID,),
                "catalog_key": resolution.catalog_key,
            },
        )

    client = OpenRouterClient(client=http, settings=settings, model_id=resolution.gateway_model)
    logger.debug(
        "client built for %s: policy=%s catalog_key=%s",
        resolution.call_role.value,
        resolution.policy_id,
        resolution.catalog_key,
    )
    return client
