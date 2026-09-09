"""The agent surface: ask a question, or stream the run as it happens. Protected.

**Protected because it uses and writes the caller's own data.** A run reads the thread's context
and the caller's preferences, and stores an evidence record the caller owns. There is no anonymous
mode: an unauthenticated run would have no thread to resolve a follow-up against and nowhere to put
the record.

**A thread id is accepted only from a caller who owns it.** Checked before the graph is invoked —
``ThreadStore.open`` — and refused as not-found, identical to a thread that never existed, because
"exists but is not yours" is itself a disclosure (design.md decision 11).

**No credential, no agent — and everything else keeps working.** With no inference credential the
route returns 503 naming the missing variable, and the public weather endpoints are unaffected.
That is ``specs/agent-orchestration``'s requirement, and the reason the inference client is
constructed lazily *here* rather than at startup.

**The stream is the same run, reported as it goes.** Not a second implementation: the graph is one
function, and streaming is a matter of emitting typed events around it. Design.md decision 17's
event vocabulary — ``routing``, ``agent_start``, ``agent_end``, ``tool_start``, ``tool_end``,
``answer_delta``, ``final``, ``error`` — is what a client renders progress from, and every event
carries the request id and a monotonic sequence number so a client can order and correlate them.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime

from fastapi import APIRouter, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.context import ContextSources
from weathra.agents.evidence import persist_run
from weathra.agents.graph import AgentRunResult, RunDependencies, run_agent
from weathra.agents.nodes.knowledge import KnowledgeRetriever
from weathra.agents.state import GraphState
from weathra.api.dependencies import (
    Configuration,
    CurrentSession,
    Embedder,
    Inference,
    Places,
    Quota,
    Tools,
)
from weathra.api.middleware import annotate, current_request_id
from weathra.api.streaming import StreamEmitter, sse_headers
from weathra.auth.deps import RequiredPrincipal
from weathra.auth.profiles import ensure_profile
from weathra.config import Settings
from weathra.db.session import request_session
from weathra.domain.errors import AGENT_UNAVAILABLE_MESSAGE, AgentNotConfigured, WeathraError
from weathra.domain.evidence import AnswerEnvelope
from weathra.domain.identity import Principal
from weathra.domain.usage import UsageEvent
from weathra.domain.weather import UnitSystem
from weathra.entitlements.quotas import Admission, QuotaGate, QuotaSubject
from weathra.memory.preferences import PreferenceStore
from weathra.memory.threads import ThreadRecord, ThreadStore, TurnRecord
from weathra.rag.embed import EmbeddingProvider
from weathra.rag.retrieve import RetrievalResult, retrieve
from weathra.telemetry.usage import BackgroundUsageRecorder, record_events

__all__ = ["router"]

logger = logging.getLogger("weathra.api.agent")

router = APIRouter(prefix="/agent", tags=["agent"])


class AskRequest(BaseModel):
    """A question, and optionally the conversation it belongs to."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=2_000)
    thread_id: str | None = Field(
        default=None,
        description=(
            "One of *your* threads, to resolve a follow-up against. A thread you do not own is "
            "refused as not found."
        ),
    )
    units: UnitSystem | None = Field(
        default=None, description="Overrides your saved preference for this question only."
    )
    create_thread: bool = Field(
        default=False,
        description="Start a new thread for this question and return its id in the response.",
    )


class AskResponse(BaseModel):
    """The answer envelope, plus where the evidence was stored."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    answer: AnswerEnvelope
    evidence_id: str | None = Field(
        default=None,
        description=(
            "The stored record's identifier, for /evidence/{id}. Null when the record could not "
            "be stored — the answer is still complete and its evidence travels inside it."
        ),
    )
    thread_id: str | None = None
    memory_available: bool = Field(
        description="False when conversation memory was unreachable for this run."
    )
    memory_note: str | None = None


def _knowledge_retriever(
    session: AsyncSession, embedder: EmbeddingProvider, settings: Settings
) -> KnowledgeRetriever:
    """Bind retrieval to this request's session, so the RAG node needs no database of its own."""

    async def bound(query: str) -> RetrievalResult:
        return await retrieve(session, embedder=embedder, settings=settings, query=query)

    return bound


async def _thread_for(
    session: AsyncSession,
    principal: Principal,
    settings: Settings,
    *,
    thread_id: str | None,
    create: bool,
    question: str,
) -> ThreadRecord | None:
    """The thread this run belongs to, having checked that the caller owns it.

    **This is the authorization gate.** It runs before the graph, so a foreign thread id never
    reaches the checkpointer, and it raises ``ThreadNotFound`` — which the error mapping turns into
    a 404 identical to the one an unknown id produces.

    The profile is ensured first, because a person's very first interaction with Weathra may well
    be asking a question rather than opening a settings screen — and both the thread row and the
    evidence record hang off it by foreign key.
    """
    await ensure_profile(session, principal)
    store = ThreadStore(session, principal, settings)

    if thread_id is not None:
        return await store.open(thread_id)
    if create:
        # The title is the question, trimmed. A model-written title would be a second inference
        # call for something a person reads once in a sidebar.
        return await store.create(title=question[:200])
    return None


class _RunTally:
    """What the gateway actually did during one run, collected as the events go past.

    Two facts the quota layer needs and cannot get anywhere honest: whether a model was called at
    all — which decides whether a failed run gives its request reservation back — and how many
    tokens it used, which is the monthly dimension's settlement. Both are read off the usage events
    of `specs/llm-telemetry` rather than counted a second time here, so the counters and the event
    record cannot disagree about what happened.

    A retry is several events and one request: the tally sums their tokens and never touches the
    request count, which is reserved once before the run and never incremented from here.
    """

    __slots__ = ("reached_gateway", "tokens")

    def __init__(self) -> None:
        self.tokens = 0
        self.reached_gateway = False

    def observe(self, events: Sequence[UsageEvent]) -> None:
        for event in events:
            self.reached_gateway = True
            if event.total_tokens:
                self.tokens += event.total_tokens


async def _run(
    request: Request,
    body: AskRequest,
    *,
    principal: Principal,
    session: AsyncSession,
    settings: Settings,
    tools: Tools,
    geocoder: Places,
    inference: Inference,
    embedder: EmbeddingProvider,
    thread: ThreadRecord | None,
    tally: _RunTally,
    emitter: StreamEmitter | None = None,
) -> AgentRunResult:
    """One agent run, wired to this caller's memory and this request's session."""
    # The credential guard first, so "no key configured" is still a 503 naming what is missing
    # rather than a resolution that succeeds and then cannot build a client.
    inference.get()

    request_id = current_request_id()
    recorder: BackgroundUsageRecorder = request.app.state.usage_recorder
    engines = request.app.state.engines

    def record(events: Sequence[UsageEvent]) -> None:
        """Hand events to the background writer.

        A separate session, opened when the task runs: this request's transaction has committed by
        then, and reusing it would either write into a closed transaction or hold the request's
        connection open past its response. The session is still the *restricted* one, so the owner
        policy on `llm_usage_events` applies to the write exactly as it does to a read.
        """

        # Read on the way past, before the write is even scheduled: the quota layer's two facts
        # come from the events themselves, and a background write that failed must not also lose
        # the accounting.
        tally.observe(events)

        async def write(batch: Sequence[UsageEvent]) -> int:
            async with request_session(
                engines.request_sessionmaker,
                claims=principal.claims,
                restricted_role=settings.database_restricted_role,
            ) as own:
                # The event's owner is a foreign key to `profiles`, and on a caller's *first ever*
                # question the row this request creates is still uncommitted while this task runs
                # — so the insert failed the constraint and the event was dropped with a warning.
                # Every account's first question recorded nothing, and only its first, which is
                # why it survived group 29's suite. Idempotent, and the same insert the route
                # itself makes.
                await ensure_profile(own, principal)
                return await record_events(own, batch)

        recorder.schedule(events, write)

    broker = inference.broker(
        session=session,
        principal=principal,
        recorder=record,
        request_id=request_id,
    )

    state = GraphState.begin(
        question=body.question,
        request_id=request_id,
        principal=principal,
        thread_id=thread.id if thread else None,
        requested_unit_system=body.units,
        started_at=datetime.now(UTC),
    )

    dependencies = RunDependencies(
        settings=settings,
        tools=tools,
        geocoder=geocoder,
        # The model policy layer, never a client this route picked: the resolver decides per call
        # role from the caller's own plan (design.md decision 22).
        models=broker,
        knowledge=_knowledge_retriever(session, embedder, settings),
        context=ContextSources(
            threads=ThreadStore(session, principal, settings),
            preferences=PreferenceStore(session, principal, settings),
            thread_id=thread.id if thread else None,
        ),
    )

    result = await run_agent(state, dependencies, observer=emitter)

    # Annotated *after* the run, from what actually served it. Reading a configured client before
    # the run would name a model whether or not it answered, which is the thing the evidence
    # record's inference attempts exist to stop.
    served = result.envelope.evidence
    annotate(
        request,
        acting_user_id=principal.user_id,
        agent_ran=True,
        llm_provider=served.llm_provider,
        llm_model=served.llm_model,
    )

    annotate(
        request,
        weather_provider=(
            result.envelope.attribution[0].provider if result.envelope.attribution else None
        ),
        partial=result.envelope.evidence.partial,
    )
    return result


async def _record_turn(
    session: AsyncSession,
    principal: Principal,
    settings: Settings,
    thread: ThreadRecord | None,
    result: AgentRunResult,
) -> None:
    """Record what this turn resolved, so the next question can be a follow-up.

    Only what a follow-up needs: the locations, the units, the last data class, and the two turns'
    text with the evidence reference. ``specs/memory`` limits the stored representation to exactly
    that, and ``ResolvedEntities`` refuses anything else.
    """
    if thread is None:
        return

    store = ThreadStore(session, principal, settings)
    now = datetime.now(UTC)
    await store.record(
        thread.id,
        locations=list(result.state.locations),
        unit_system=result.state.unit_system,
        data_class=(
            result.envelope.evidence.data_classes[-1]
            if result.envelope.evidence.data_classes
            else None
        ),
        turn=TurnRecord(role="user", text=result.state.question, at=now),
    )
    if result.envelope.answer_prose:
        await store.record(
            thread.id,
            turn=TurnRecord(
                role="assistant",
                text=result.envelope.answer_prose,
                at=now,
                evidence_id=result.envelope.request_id,
            ),
        )


async def _admit(
    quota: QuotaGate,
    inference: Inference,
    principal: Principal,
    session: AsyncSession,
) -> Admission:
    """Reserve this caller's allowance, before anything is asked of a gateway.

    `specs/usage-limits` requires the check to happen in the backend *before* the call, so this
    runs ahead of the graph on both paths — and on the streaming one, ahead of the response, so an
    exhausted caller is refused rather than handed a 200 whose first event is the refusal.

    The plan comes from the resolver, which is the same source the model policy layer will read a
    moment later. An administrative principal is accounted internally by construction: the subject
    is derived from the validated token, and no argument here can opt a request out of its plan.
    """
    plan = await inference.effective_plan(principal, session)
    return await quota.admit(QuotaSubject.for_principal(principal, plan))


@router.post("/ask", response_model=AskResponse, summary="Ask a weather question")
async def ask(
    request: Request,
    body: AskRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    tools: Tools,
    geocoder: Places,
    inference: Inference,
    embedder: Embedder,
    quota: Quota,
) -> AskResponse:
    """Answer one question, with the evidence for every figure in it.

    Returns 503 naming the missing configuration when no inference credential is set, and 429 with
    the bound dimension when the caller's plan allowance is spent. Every public weather endpoint
    keeps working in both cases, which is why the client is constructed here rather than at
    startup and why the quota gate covers this route rather than the application.
    """
    thread = await _thread_for(
        session,
        principal,
        settings,
        thread_id=body.thread_id,
        create=body.create_thread,
        question=body.question,
    )

    admission = await _admit(quota, inference, principal, session)
    tally = _RunTally()
    try:
        result = await _run(
            request,
            body,
            principal=principal,
            session=session,
            settings=settings,
            tools=tools,
            geocoder=geocoder,
            inference=inference,
            embedder=embedder,
            thread=thread,
            tally=tally,
        )
    except BaseException:
        # A run that never reached a gateway cost nothing, so its request reservation goes back.
        # One that failed after a model answered is a request that happened, and stays counted.
        await quota.finish(admission, reached_gateway=tally.reached_gateway)
        raise
    await quota.finish(admission, tokens=tally.tokens)

    evidence_id = await persist_run(session, principal, result.envelope)
    await _record_turn(session, principal, settings, thread, result)

    return AskResponse(
        answer=result.envelope,
        evidence_id=evidence_id,
        thread_id=thread.id if thread else None,
        memory_available=result.memory.available,
        memory_note=result.memory.note,
    )


@router.post("/stream", summary="Ask a weather question, streamed")
async def stream(
    request: Request,
    body: AskRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    tools: Tools,
    geocoder: Places,
    inference: Inference,
    embedder: Embedder,
    quota: Quota,
) -> StreamingResponse:
    """The same run, reported as it happens.

    **Authentication happens before anything starts.** ``RequiredPrincipal`` resolves as a
    dependency, so an unauthenticated request gets a 401 with the normal error envelope and no run
    is begun — rather than a 200 whose first event is an error, which is what happens if a stream
    authenticates inside its own generator.

    Ownership is checked before the stream opens too, for the same reason: a 404 is a better answer
    to a foreign thread id than a stream whose only event says so.
    """
    thread = await _thread_for(
        session,
        principal,
        settings,
        thread_id=body.thread_id,
        create=body.create_thread,
        question=body.question,
    )

    # Constructed here, before the response starts: an unconfigured agent surface must be a 503
    # with a message, not a stream that opens and immediately reports one.
    if not inference.configured:
        raise AgentNotConfigured(
            # Reaches a person on the Analyst screen, so it says what is unavailable and what
            # still works, and names nothing about how the service is configured. The operator's
            # half is in `details` and in the log.
            AGENT_UNAVAILABLE_MESSAGE,
            details={"missing": "inference_credential", "provider": inference.provider_id},
        )

    # Before the response, for the same reason as the guard above: `specs/usage-limits` requires an
    # exhausted caller's stream to be *refused* rather than opened and terminated mid-answer. A 429
    # here is a 429; inside the generator it would be a 200 whose first event apologises.
    admission = await _admit(quota, inference, principal, session)

    emitter = StreamEmitter(request_id=current_request_id())
    tally = _RunTally()

    async def events() -> AsyncIterator[str]:
        """Run the graph, emitting each stage, and always end with a terminal event."""
        served = False
        try:
            try:
                async for event in emitter.drain_while(
                    _run(
                        request,
                        body,
                        principal=principal,
                        session=session,
                        settings=settings,
                        tools=tools,
                        geocoder=geocoder,
                        inference=inference,
                        embedder=embedder,
                        thread=thread,
                        tally=tally,
                        emitter=emitter,
                    )
                ):
                    yield event
            except WeathraError as failure:
                # A terminal error event rather than a truncated stream: the response is
                # already 200, so a client that saw the connection close would have to guess
                # whether the answer was complete (``specs/http-api``).
                logger.info("stream failed: %s", failure.code)
                yield emitter.error_event(code=failure.code, message=failure.message)
                return
            except (
                Exception
            ) as failure:  # pragma: no cover - the handler above covers named failures
                logger.exception("stream failed unexpectedly", exc_info=failure)
                yield emitter.error_event(
                    code="internal_error",
                    message="The run failed unexpectedly. The failure is logged with this "
                    "request id.",
                )
                return

            result = emitter.result
            if result is None:  # pragma: no cover - drain_while always sets one on success
                yield emitter.error_event(
                    code="internal_error", message="The run produced no answer."
                )
                return

            evidence_id = await persist_run(session, principal, result.envelope)
            await _record_turn(session, principal, settings, thread, result)
            yield emitter.final_event(result.envelope, evidence_id=evidence_id)
            served = True
        finally:
            # Always, including a client that disconnected mid-answer: the concurrency slot is
            # given back here or not at all, and a stream abandoned halfway is not a slot still in
            # flight. `served` covers the one case the tally cannot see — a run that answered
            # without recording an event, which must still count as a request that happened.
            await quota.finish(
                admission,
                tokens=tally.tokens,
                reached_gateway=tally.reached_gateway or served,
            )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers=sse_headers(),
        status_code=status.HTTP_200_OK,
    )
