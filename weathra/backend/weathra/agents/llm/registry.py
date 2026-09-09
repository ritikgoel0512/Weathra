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

from weathra.agents.llm.attempts import GatewayAttemptLog
from weathra.agents.llm.base import LLMClient
from weathra.agents.llm.factory import build_for_resolution
from weathra.agents.llm.instrumented import InstrumentedLLMClient, UsageRecorder
from weathra.agents.llm.openrouter import OPENROUTER_PROVIDER_ID, OpenRouterClient
from weathra.agents.models import ModelBroker
from weathra.config import Settings
from weathra.domain.entitlements import PlanCode, Resolution
from weathra.domain.errors import AGENT_UNAVAILABLE_MESSAGE, AgentNotConfigured, ProviderNotFound
from weathra.domain.identity import Principal
from weathra.entitlements.resolver import PolicyResolver
from weathra.entitlements.snapshot import SnapshotCache
from weathra.telemetry.context import CallContext

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

    __slots__ = (
        "_client",
        "_http",
        "_installed",
        "_pinned_catalog_key",
        "_pinned_evaluation",
        "_resolver",
        "_settings",
        "_snapshots",
    )

    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self._http = http
        self._settings = settings
        self._client: LLMClient | None = None
        self._installed: LLMClient | None = None
        self._pinned_evaluation = False
        self._pinned_catalog_key: str | None = None
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
        return self._client is not None or self._installed is not None

    def get(self) -> LLMClient:
        """The configured client, constructed on first use — or an installed one, if there is one.

        Raises ``AgentNotConfigured`` when no credential resolves — at the moment of the agent
        request, which is where the caller can be told what is missing and every other route can
        go on working.

        **What this returns is not what a resolved call is served by.** This is the credential
        guard and the pre-policy path; the model a request actually reaches comes from `broker()`.
        The two used to share one slot, and the consequence was that the agent route's guard call
        cached the ``LLM_MODEL`` client where the broker looked for a *deliberately installed*
        one — so every resolution in the process was recorded and none was honoured. They are two
        slots now, and `_installed` is written by `override` alone.
        """
        if self._installed is not None:
            return self._installed
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
        recorder: UsageRecorder | None = None,
        agent_run_id: str | None = None,
        request_id: str | None = None,
        administrative: bool = False,
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
            # broker that ignored it would quietly reach the real gateway from a test. Only
            # `override` writes this — never `get`, whose lazily-built client is the configured
            # fallback and not somebody's decision.
            installed=self._installed,
            # Telemetry is a decorator the broker installs, so the route supplies where events go
            # and never emits one itself.
            recorder=recorder,
            agent_run_id=agent_run_id,
            request_id=request_id,
            # Resolved once per request from `admin_roles` at the identity boundary, never read
            # again here: the quota gate and the resolver must agree about who is an administrator,
            # and two lookups eventually would not.
            administrative=administrative,
            # Set only by `pin_evaluation_policy`, which only the evaluation harness calls. False
            # in every deployed process, because nothing there can set it.
            pinned_evaluation=self._pinned_evaluation,
            pinned_catalog_key=self._pinned_catalog_key,
        )

    async def effective_plan(self, principal: Principal | None, session: AsyncSession) -> PlanCode:
        """Which plan the quota gate should account this caller against.

        Delegated to the resolver rather than answered here, because the resolver already owns the
        question and the gate must get the same answer the model policy layer will get a moment
        later. A caller admitted against Pro's allowance and then served Free's policy would be two
        entitlement systems wearing one name.
        """
        return await self._resolver.effective_plan(principal, session)

    @property
    def settings(self) -> Settings:
        """The process's settings, for a caller that needs a bound this provider already holds."""
        return self._settings

    def lab_client(
        self,
        resolution: Resolution,
        *,
        principal: Principal,
        run_id: str | None = None,
        recorder: UsageRecorder | None = None,
    ) -> LLMClient:
        """A client bound to one named model, instrumented as internal usage.

        The model lab's seam. It is *not* a resolution: the administrator named the model, so
        nothing here walks a policy, and the resolution passed in records that fact
        (`LAB_COMPARISON_POLICY`). What it shares with the request path is everything else — the
        same factory, the same gateway client, and the same telemetry decorator — so a lab call is
        recorded exactly as a product call is, and is classified internal because the caller who
        made it holds the administrative role.

        An installed client wins, as everywhere else, so the offline harness and the test suite
        compare scripted transports rather than reaching a real gateway from a test.
        """
        attempts = GatewayAttemptLog()
        inner = self._installed or build_for_resolution(
            resolution, http=self._http, settings=self._settings, attempts=attempts
        )
        if recorder is None:
            return inner
        return InstrumentedLLMClient(
            inner,
            context=CallContext.for_run(
                role=resolution.call_role,
                resolution=resolution,
                principal=principal,
                plan=None,
                agent_run_id=None,
                request_id=run_id,
                # By construction, not by a flag somebody sets: only an administrative principal
                # reaches the lab at all, and `specs/usage-limits` accounts their traffic against
                # the internal allowance.
                internal=True,
            ),
            recorder=recorder,
            # The log belongs to the client that was actually built; an installed one keeps
            # its own record and never writes into this.
            attempts=attempts if self._installed is None else None,
        )

    @property
    def snapshots(self) -> SnapshotCache:
        """The process's entitlement snapshot, for the readiness probe and administration."""
        return self._snapshots

    def override(self, client: LLMClient) -> None:
        """Install a specific client. For tests and offline evaluation, which use the fake.

        Its own slot, separate from the lazily-built configured client: this one means *somebody
        chose this*, which is why the broker honours it over a resolution, and the configured
        client means nothing more than "a credential exists".
        """
        self._installed = client

    # ---------------------------------------------------------------- the pinned evaluation run

    def pin_evaluation_policy(self, *, catalog_key: str | None = None) -> None:
        """Make every broker this process builds resolve the fixed-model evaluation policy.

        `specs/evaluation` requires a live run to resolve its pinned model "through a fixed-model
        evaluation policy rather than through the evaluation test user's subscription plan", and
        this is how that reaches the request path: the evaluation harness builds the *real*
        application and flips this before any case runs, so the run's own `/agent/ask` calls
        resolve the pinned policy instead of walking a plan.

        **Process state, and deliberately not a setting.** There is no environment variable for
        this and no request field: a deployed backend has no way to be put in this mode, and the
        only caller is a harness that already owns the process it is configuring. A flag in the
        environment would have been one operator mistake away from serving product traffic from an
        internal policy.

        *catalog_key* pins a named candidate instead — the model-comparison case, where the run is
        pinned to the candidate under test rather than to the policy's own single candidate. Still
        no plan, still no failover; see `PolicyResolver.resolve_fixed_evaluation`.
        """
        self._pinned_evaluation = True
        self._pinned_catalog_key = catalog_key
        logger.info(
            "inference pinned to the evaluation policy%s",
            f" candidate {catalog_key}" if catalog_key else "",
        )

    @property
    def evaluation_pinned(self) -> bool:
        """Whether this process resolves the fixed-model evaluation policy.

        Read back rather than assumed: the run record states the pin, and a run that claims a
        pinned model should be checkable against whether the process was actually pinned.
        """
        return self._pinned_evaluation
