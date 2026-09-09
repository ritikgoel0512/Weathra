"""The seam between the graph and the model policy layer.

The graph asks for a *call role* and gets a client. That sentence is the whole design: nothing above
this module names a model, and nothing below it knows what a supervisor is.

**Why this sits in `agents/` and not in `entitlements/`.** It builds clients, and client
construction is the agent layer's business — `entitlements/` decides, `agents/llm/` connects. It
also means `entitlements/` stays free of `httpx`, which is what lets the resolver be unit-tested
over fixture data with no transport at all.

**Why `agents/nodes/` may not import it.** A node that could reach a broker could ask for a
different role's client, or resolve twice, or resolve at all — and "no node selects a model" would
become a convention. The graph resolves both roles and hands each node the client it gets; a test
fails if `agents/nodes/` imports `entitlements/`, and this module is deliberately not re-exported
from anywhere a node already imports.

**One resolution per role per run.** A run's routing decision and its synthesis are separate calls
that may resolve separate policies, but *within* a run each role resolves once and the client is
reused. Re-resolving per call would let a catalog refresh land mid-run and produce a half-old
decision — the graph would route with one model's plan and synthesise under a different policy's,
and the evidence record would have to describe two resolutions for what a reader sees as one run.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.llm.attempts import GatewayAttemptLog
from weathra.agents.llm.base import LLMClient
from weathra.agents.llm.factory import build_for_resolution
from weathra.agents.llm.failover import FailoverClient
from weathra.agents.llm.instrumented import InstrumentedLLMClient, UsageRecorder
from weathra.config import Settings
from weathra.domain.entitlements import CallRole, Resolution
from weathra.domain.identity import Principal
from weathra.entitlements.resolver import ModelPolicyResolver, ResolvedCall
from weathra.telemetry.context import CallContext

__all__ = ["ModelBroker", "ModelSource", "RoleBinding"]

logger = logging.getLogger("weathra.agents.models")


class ModelSource(Protocol):
    """Whatever a run gets its clients from.

    Two implementations, and the difference between them is not a difference in *policy*: the
    broker below resolves one per role, and the offline evaluator and the tests hand over a client
    somebody already bound. Neither lets a node choose a model, which is the property that matters
    — a pre-bound client has already been decided, and the broker decides by walking the policy.
    """

    async def client_for(self, role: CallRole) -> LLMClient | None:
        """The client for one call role, or ``None`` where inference is unavailable."""
        ...


class RoleBinding:
    """One call role's resolved client, and the resolution that produced it."""

    __slots__ = ("client", "resolved")

    def __init__(self, client: LLMClient, resolved: ResolvedCall) -> None:
        self.client = client
        self.resolved = resolved

    @property
    def resolution(self) -> Resolution:
        """What actually served, which is not always what was first selected.

        A `FailoverClient` rewrites its resolution as it walks, so reading through it here is what
        makes the evidence record name the candidate that answered rather than the one the walk
        began with.
        """
        if isinstance(self.client, FailoverClient):
            return self.client.resolution
        return self.resolved.resolution

    @property
    def attempts(self) -> tuple[object, ...]:
        """Every model attempted for this role, in order. Empty for a non-failover client."""
        if isinstance(self.client, FailoverClient):
            return self.client.attempts
        return ()


class ModelBroker:
    """Resolves a model per call role for one run, and builds the client for it.

    Constructed per request, because it holds that request's principal and session. The resolver
    and the settings behind it are process-wide; what is per-run is the binding.
    """

    __slots__ = (
        "_administrative",
        "_bindings",
        "_http",
        "_installed",
        "_override",
        "_principal",
        "_recorder",
        "_request_id",
        "_resolver",
        "_run_id",
        "_session",
        "_settings",
    )

    def __init__(
        self,
        *,
        resolver: ModelPolicyResolver,
        session: AsyncSession,
        settings: Settings,
        http: httpx.AsyncClient,
        principal: Principal | None = None,
        override: str | None = None,
        installed: LLMClient | None = None,
        recorder: UsageRecorder | None = None,
        agent_run_id: str | None = None,
        request_id: str | None = None,
        administrative: bool = False,
    ) -> None:
        self._administrative = administrative
        self._recorder = recorder
        self._run_id = agent_run_id
        self._request_id = request_id
        self._installed = installed
        self._resolver = resolver
        self._session = session
        self._settings = settings
        self._http = http
        self._principal = principal
        self._override = override
        self._bindings: dict[CallRole, RoleBinding] = {}

    async def client_for(self, role: CallRole) -> LLMClient:
        """The client this run uses for *role*, resolving once and reusing thereafter."""
        return (await self.binding_for(role)).client

    async def binding_for(self, role: CallRole) -> RoleBinding:
        """The full binding, for a caller that needs the resolution as well as the client."""
        existing = self._bindings.get(role)
        if existing is not None:
            return existing

        resolved = await self._resolver.resolve(
            principal=self._principal,
            role=role,
            session=self._session,
            override=self._override,
            administrative=self._administrative,
        )
        binding = RoleBinding(self._wrap(resolved), resolved)
        self._bindings[role] = binding
        logger.debug(
            "resolved %s: policy=%s catalog_key=%s",
            role.value,
            resolved.resolution.policy_id,
            resolved.resolution.catalog_key,
        )
        return binding

    def resolved_roles(self) -> dict[CallRole, RoleBinding]:
        """Every role this run actually resolved. Only what was needed, never speculative."""
        return dict(self._bindings)

    def _wrap(self, resolved: ResolvedCall) -> LLMClient:
        """The client, wrapped for failover where the policy permits it.

        A pinned policy, a configured fallback and an administrative override all arrive with
        `failover_enabled` false and are handed back unwrapped — there is nothing to walk, and
        wrapping them would suggest otherwise to a reader of the evidence record.
        """
        if self._installed is not None:
            # A client somebody put in deliberately: the offline evaluation harness, or a test.
            # Resolution still happens and is still recorded — the plan, the policy and the reason
            # are real — and only the transport is the installed one. Skipping the resolution
            # instead would mean the offline suite exercised a different code path from the one it
            # is meant to be checking.
            return self._instrumented(self._installed, resolved, attempts=None)

        # One log per client, drained by the instrumented wrapper after each outer call, so a
        # schema retry inside `complete_json` becomes its own usage event rather than vanishing.
        attempts = GatewayAttemptLog()
        primary = build_for_resolution(
            resolved.resolution, http=self._http, settings=self._settings, attempts=attempts
        )
        if not resolved.may_fail_over:
            return self._instrumented(primary, resolved, attempts=attempts)

        failover = FailoverClient(
            primary,
            resolution=resolved.resolution,
            remaining=resolved.remaining,
            build=lambda updated: build_for_resolution(
                updated, http=self._http, settings=self._settings, attempts=attempts
            ),
            max_models=self._settings.llm_failover_max_models,
        )
        # Instrumentation on the *outside* of failover, deliberately: each candidate the walk
        # attempts is a separate inner call, so each becomes its own usage event. Inside, the
        # wrapper would only ever see whichever candidate happened to answer.
        return self._instrumented(failover, resolved, attempts=attempts)

    def _instrumented(
        self, client: LLMClient, resolved: ResolvedCall, *, attempts: GatewayAttemptLog | None
    ) -> LLMClient:
        """Wrap for telemetry, where a recorder was supplied.

        No recorder means no instrumentation and no overhead — the evaluation harness and the unit
        tests run that way. The request path always supplies one.
        """
        if self._recorder is None:
            return client
        return InstrumentedLLMClient(
            client,
            context=CallContext.for_run(
                role=resolved.resolution.call_role,
                resolution=resolved.resolution,
                principal=self._principal,
                plan=resolved.plan,
                agent_run_id=self._run_id,
                request_id=self._request_id,
            ),
            recorder=self._recorder,
            attempts=attempts,
        )


class BoundModelSource:
    """A `ModelSource` over one already-bound client, used for every role.

    The offline evaluation harness and the fake-LLM tests reach the graph through this. It selects
    nothing — the client it hands back was chosen before it existed — so it is a way of *supplying*
    a model rather than a second way of choosing one.
    """

    __slots__ = ("_client",)

    def __init__(self, client: LLMClient | None) -> None:
        self._client = client

    async def client_for(self, role: CallRole) -> LLMClient | None:
        return self._client
