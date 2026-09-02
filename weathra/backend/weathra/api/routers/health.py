"""Health and readiness. Public, because a load balancer cannot present a token.

**Two endpoints, two questions.** ``/health`` answers "is this process alive" and depends on
nothing — a health check that queries the database reports the database's health, and a rolling
deploy then kills instances that are fine. ``/ready`` answers "what is configured and reachable",
and its whole value is in being specific.

**The distinction that makes readiness useful.** Each dependency reports *configured* and
*reachable* separately, because they are different problems with different fixes: an unset variable
is a deployment mistake, and an unreachable service is an outage. Reporting one boolean would send
an operator looking in the wrong place half the time.

**Unconfigured inference is healthy.** ``specs/agent-orchestration`` requires every non-agent
capability to work without an inference credential, so a deployment with none is *ready* — the
report says the agent surface is unavailable and names the missing variable, and readiness stays
true. Reporting not-ready would take a working weather service out of rotation over an optional
feature.

**No credential material, ever.** Not the key, not a prefix of it, not its length. A readiness
endpoint is unauthenticated by necessity, so "is it configured" is the most it may say — which is
also all an operator needs, since a wrong key shows up as ``reachable: false`` instead.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra import __version__
from weathra.agents.llm.registry import LLMProvider
from weathra.api.dependencies import Configuration, CurrentSession, Inference, Memory
from weathra.config import Settings
from weathra.memory.checkpointer import Checkpointer
from weathra.rag.store import index_identity

__all__ = ["router"]

logger = logging.getLogger("weathra.api.health")

router = APIRouter(tags=["health"])


class DependencyStatus(BaseModel):
    """One dependency: what it is, whether it is configured, and whether it answered."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    configured: bool = Field(description="Whether the deployment supplies what it needs.")
    reachable: bool | None = Field(
        default=None,
        description=(
            "Whether it answered just now. Null when not checked — either because it is not "
            "configured, or because checking it would cost more than the report is worth."
        ),
    )
    detail: str | None = Field(
        default=None, description="What an operator needs to act. Never a credential."
    )
    required: bool = Field(
        default=True,
        description="False for a dependency whose absence leaves the service usable.",
    )


class HealthResponse(BaseModel):
    """Liveness. Deliberately depends on nothing."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    status: str = "ok"
    version: str
    environment: str
    checked_at: datetime


class ReadinessResponse(BaseModel):
    """What is configured, what is reachable, and whether the service can serve."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    ready: bool = Field(
        description=(
            "True when every *required* dependency is reachable. An unconfigured inference "
            "provider does not make the service unready: every other capability still works."
        )
    )
    version: str
    environment: str
    checked_at: datetime
    dependencies: tuple[DependencyStatus, ...]
    note: str | None = None

    @property
    def unready(self) -> tuple[str, ...]:
        return tuple(
            dependency.name
            for dependency in self.dependencies
            if dependency.required and dependency.reachable is False
        )


@router.get("/health", response_model=HealthResponse, summary="Liveness")
async def health(settings: Configuration) -> HealthResponse:
    """Whether this process is running. Checks nothing else, on purpose.

    A health check that queried the database would report the *database's* health, and a rolling
    deploy would then kill instances that were perfectly able to serve cached weather.
    """
    return HealthResponse(
        version=__version__,
        environment=settings.environment,
        checked_at=datetime.now(UTC),
    )


@router.get("/ready", response_model=ReadinessResponse, summary="Readiness")
async def ready(
    request: Request,
    settings: Configuration,
    session: CurrentSession,
    inference: Inference,
    memory: Memory,
) -> ReadinessResponse:
    """What is configured, what answered, and whether Weathra can serve.

    Each check is cheap and bounded. The database check is a ``SELECT 1``; the vector-store check
    reads the stored index's identity, which is one row; the MCP check reads the catalog the client
    discovered at startup rather than making a call. A readiness endpoint that took a second to
    answer would be scraped every ten seconds and cost more than it reports.
    """
    checks = [
        _weather_provider(settings),
        await _database(session),
        await _vector_store(session, settings),
        _mcp_server(request),
        _authentication(settings),
        _inference(inference),
        _conversation_memory(memory, settings),
    ]

    unready = [check.name for check in checks if check.required and check.reachable is False]
    optional_gaps = [check.name for check in checks if not check.required and not check.configured]

    return ReadinessResponse(
        ready=not unready,
        version=__version__,
        environment=settings.environment,
        checked_at=datetime.now(UTC),
        dependencies=tuple(checks),
        note=(
            f"Not ready: {', '.join(unready)} did not answer."
            if unready
            else (
                f"Ready. {', '.join(optional_gaps)} is not configured; every other capability "
                "works without it."
                if optional_gaps
                else None
            )
        ),
    )


# =========================================================================== the checks


def _weather_provider(settings: Settings) -> DependencyStatus:
    """Configured, but not called.

    Deliberately not reached: a readiness probe that fetched a forecast would hit the provider's
    rate limit on a schedule, and the endpoints that need it report their own failures precisely.
    """
    return DependencyStatus(
        name="weather_provider",
        configured=bool(settings.default_weather_provider),
        reachable=None,
        detail=(
            f"{settings.default_weather_provider}. Not called by this probe: a scheduled "
            "readiness fetch would consume the provider's rate limit."
        ),
    )


async def _database(session: AsyncSession) -> DependencyStatus:
    try:
        answered = await session.scalar(text("SELECT 1"))
    except Exception as failure:  # a probe reports; it does not fail the request
        logger.warning("readiness: the database did not answer (%s)", type(failure).__name__)
        return DependencyStatus(
            name="database",
            configured=True,
            reachable=False,
            detail="The database did not answer. Check DATABASE_URL and the instance's status.",
        )
    return DependencyStatus(name="database", configured=True, reachable=answered == 1)


async def _vector_store(session: AsyncSession, settings: Settings) -> DependencyStatus:
    """Reachable, and whether the stored index matches the configured embedding model.

    A mismatch is reported here rather than discovered by a person asking a question: comparing
    vectors across embedding spaces produces a number that looks like a similarity and is not one,
    so retrieval refuses, and an operator should hear about it from the probe first.
    """
    try:
        identity = await index_identity(session)
    except Exception as failure:
        logger.warning("readiness: the vector store did not answer (%s)", type(failure).__name__)
        return DependencyStatus(
            name="vector_store",
            configured=True,
            reachable=False,
            detail=f"{settings.vector_store} did not answer.",
        )

    if identity.is_empty:
        return DependencyStatus(
            name="vector_store",
            configured=True,
            reachable=True,
            required=False,
            detail=(
                f"{settings.vector_store} is reachable but the knowledge index is empty. Run "
                "weathra-ingest-corpus. Every capability except concept explanation works."
            ),
        )

    matched = identity.model == settings.embedding_model_id
    return DependencyStatus(
        name="vector_store",
        configured=True,
        reachable=True,
        required=False,
        detail=(
            f"{settings.vector_store}, indexed by {identity.model} "
            f"({identity.dimension} dimensions)."
            if matched
            else (
                f"The stored index was built by {identity.model} but EMBEDDING_MODEL_ID is "
                f"{settings.embedding_model_id}. Re-index before knowledge retrieval will work."
            )
        ),
    )


def _mcp_server(request: Request) -> DependencyStatus:
    """Whether the tool client connected at startup, from the catalog it discovered.

    Read from the client rather than by calling a tool: the connection is long-lived, and its
    catalog was validated against the configured tool list when it was established.
    """
    client = getattr(request.app.state, "tools", None)
    if client is None:
        return DependencyStatus(
            name="mcp_server",
            configured=True,
            reachable=False,
            detail="The MCP weather server is not connected, so the agent surface cannot run.",
        )
    names = client.tool_names()
    return DependencyStatus(
        name="mcp_server",
        configured=True,
        reachable=bool(names),
        detail=f"{len(names)} tools: {', '.join(names)}.",
    )


def _authentication(settings: Settings) -> DependencyStatus:
    """The project URL and the derived key-set endpoint. Never a key.

    Not fetched here: the key set is cached with its own TTL and refetched on an unknown key id,
    so a probe fetch would either hit the cache (proving nothing) or evict it (costing latency on
    the next real request).
    """
    return DependencyStatus(
        name="authentication_provider",
        configured=bool(settings.supabase_url),
        reachable=None,
        detail=f"Supabase Auth at {settings.jwks_url}. Signing keys are cached and refetched.",
    )


def _inference(inference: LLMProvider) -> DependencyStatus:
    """Whether a credential is configured. Never whether it is *this* credential.

    Unconfigured is not an outage: ``specs/agent-orchestration`` requires every non-agent
    capability to keep working, so this dependency is not required for readiness.
    """
    return DependencyStatus(
        name="inference_provider",
        configured=inference.configured,
        reachable=None,
        required=False,
        detail=(
            f"{inference.provider_id}, model {inference.model_id}."
            if inference.configured
            else (
                "No inference credential is configured, so the agent endpoints are unavailable. "
                "Set OPENROUTER_API_KEY to enable them. Forecast, history, analysis, comparison, "
                "locations, preferences, and saved locations all work without it."
            )
        ),
    )


def _conversation_memory(memory: Checkpointer | None, settings: Settings) -> DependencyStatus:
    """Whether the checkpointer opened. Not required: a memory outage degrades honestly."""
    open_now = memory is not None and memory.is_open
    return DependencyStatus(
        name="conversation_memory",
        configured=settings.database_url is not None,
        reachable=open_now,
        required=False,
        detail=(
            "The conversation checkpointer is open."
            if open_now
            else (
                "The conversation checkpointer is not open. Stateless capabilities are "
                "unaffected; follow-ups will report that context is unavailable."
            )
        ),
    )
