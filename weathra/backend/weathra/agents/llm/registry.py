"""Lazy client construction: the guard that keeps every other capability credential-free.

``specs/agent-orchestration`` requires that with no inference credential configured the agent
surface reports itself unavailable, naming the missing configuration, while forecast, historical,
analytics, comparison, locations, preferences and saved locations stay *fully* functional. That is
a statement about when a client is built, not about how an endpoint handles an error.

**So construction is lazy, and only the agent routes trigger it.** ``LLMProvider.get()`` builds on
first use and caches; nothing else in the process calls it. A client built eagerly in the lifespan
would make ``AgentNotConfigured`` a startup failure, and the whole service would refuse to serve a
public forecast because the optional half of it was unconfigured.

**Why a registry at all, for one provider.** Because ``LLM_PROVIDER`` is configuration and the
specs require substituting an implementation to change no behaviour elsewhere. A name-to-factory
map makes that substitution a settings change and an entry, and makes an unknown name an error
that lists what is available rather than a ``KeyError``.

The fake is *not* registered. It is a test double, and a deployment that could reach it by setting
``LLM_PROVIDER=fake`` could answer a person's weather question from a script.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.llm.base import LLMClient
from weathra.agents.llm.openrouter import OPENROUTER_PROVIDER_ID, OpenRouterClient
from weathra.agents.models import ModelBroker
from weathra.config import Settings
from weathra.domain.errors import AGENT_UNAVAILABLE_MESSAGE, AgentNotConfigured, ProviderNotFound
from weathra.domain.identity import Principal
from weathra.entitlements.resolver import PolicyResolver
from weathra.entitlements.snapshot import SnapshotCache

__all__ = ["LLMProvider", "available_providers", "build_client"]

logger = logging.getLogger("weathra.agents.llm.registry")

Factory = Callable[[httpx.AsyncClient, Settings], LLMClient]

_REGISTRY: dict[str, Factory] = {
    OPENROUTER_PROVIDER_ID: lambda client, settings: OpenRouterClient(
        client=client, settings=settings
    ),
}


def available_providers() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY))


def build_client(client: httpx.AsyncClient, settings: Settings) -> LLMClient:
    """The configured client, or a clear error about what is missing or misnamed.

    Raises ``AgentNotConfigured`` for a missing credential and ``ProviderNotFound`` for a provider
    name that is not registered. Two different errors because they are two different mistakes: one
    is an unset secret, the other a typo in a name this function can list.
    """
    factory = _REGISTRY.get(settings.llm_provider)
    if factory is None:
        raise ProviderNotFound(
            f"{settings.llm_provider!r} is not a registered inference provider. "
            f"Available: {', '.join(available_providers())}.",
            details={"requested": settings.llm_provider, "available": available_providers()},
        )
    if not settings.inference_configured:
        raise AgentNotConfigured(
            # The same words a runtime rejection produces, for the same reason: this message
            # reaches a weather screen. What an operator needs is in `details` and in the log.
            AGENT_UNAVAILABLE_MESSAGE,
            details={"missing": "inference_credential", "provider": settings.llm_provider},
        )
    return factory(client, settings)


class LLMProvider:
    """Holds the process's inference client, and builds it no sooner than it is needed.

    Owned by the application lifespan and handed to the agent routes. The routes are the only
    callers of ``get``, which is what makes "no credential, no problem" true for every other
    endpoint rather than merely intended.
    """

    __slots__ = ("_client", "_http", "_resolver", "_settings", "_snapshots")

    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self._http = http
        self._settings = settings
        self._client: LLMClient | None = None
        # One snapshot per process (design.md decision 23), and one resolver over it. Built here
        # rather than per request because the TTL is only worth anything if the snapshot outlives
        # the request that refreshed it.
        self._snapshots = SnapshotCache(settings)
        self._resolver = PolicyResolver(settings, self._snapshots)

    @property
    def configured(self) -> bool:
        """Whether a credential is present — the readiness answer, with no credential in it.

        ``specs/agent-orchestration``: the system reports whether an inference provider is
        configured *without disclosing the credential*. A boolean and a provider name is the whole
        of what a caller is owed.
        """
        return self._settings.inference_configured

    @property
    def provider_id(self) -> str:
        return self._settings.llm_provider

    @property
    def model_id(self) -> str:
        return self._settings.llm_model

    @property
    def built(self) -> bool:
        """Whether anything has actually needed inference in this process."""
        return self._client is not None

    def get(self) -> LLMClient:
        """The client, constructed on first use.

        Raises ``AgentNotConfigured`` when no credential resolves — at the moment of the agent
        request, which is where the caller can be told what is missing and every other route can
        go on working.
        """
        if self._client is None:
            self._client = build_client(self._http, self._settings)
            logger.info(
                "inference client constructed: provider=%s model=%s",
                self._client.provider_id,
                self._client.model_id,
            )
        return self._client

    def broker(
        self,
        *,
        session: AsyncSession,
        principal: Principal | None = None,
        override: str | None = None,
    ) -> ModelBroker:
        """The model policy layer, bound to one request.

        This is how a request-serving process obtains its clients: the route builds a broker and
        the graph asks it per call role. The credential guard still comes first — ``get()`` is what
        turns "no key configured" into an ``AgentNotConfigured`` the caller can be told about,
        before any resolution work happens.

        The session is the request's own restricted one, so reading ``user_plans`` to derive the
        plan runs under Row Level Security like everything else. Nothing here reaches for the
        privileged connection, and the group 26 scan proves it.
        """
        return ModelBroker(
            resolver=self._resolver,
            session=session,
            settings=self._settings,
            http=self._http,
            principal=principal,
            override=override,
            # An explicitly installed client wins over building one. `override()` is how the
            # offline evaluation harness and the test suite supply a scripted transport, and a
            # broker that ignored it would quietly reach the real gateway from a test.
            installed=self._client,
        )

    @property
    def snapshots(self) -> SnapshotCache:
        """The process's entitlement snapshot, for the readiness probe and administration."""
        return self._snapshots

    def override(self, client: LLMClient) -> None:
        """Install a specific client. For tests and offline evaluation, which use the fake."""
        self._client = client
