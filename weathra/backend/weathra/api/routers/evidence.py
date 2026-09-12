"""Retrieving a stored evidence record, and the caller's own threads. Protected.

**The evidence endpoint is what makes a figure checkable after the fact.** An answer ships with its
evidence inline, but a person who wants to check something an hour later needs to be able to fetch
it — and ``specs/agent-orchestration`` requires the record to be sufficient for that without
re-running the question.

**An unknown identifier and someone else's identifier get the same response.** Byte for byte: the
same status, the same code, the same message. Anything else turns the endpoint into an oracle for
which identifiers exist, and a record id in a URL is exactly the sort of thing that ends up in a
shared link.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Path, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from weathra.api.dependencies import Configuration, CurrentSession, Memory
from weathra.api.middleware import annotate
from weathra.auth.deps import RequiredPrincipal
from weathra.db.models import AgentRun
from weathra.domain.errors import EvidenceNotFound
from weathra.memory.retention import delete_thread
from weathra.memory.threads import ThreadRecord, ThreadStore

__all__ = ["router"]

logger = logging.getLogger("weathra.api.evidence")

router = APIRouter(tags=["evidence"])

# One message for both cases, so an unknown id and a foreign id are indistinguishable.
NOT_FOUND_MESSAGE = "No evidence record with that identifier."


class EvidenceResponse(BaseModel):
    """One stored run: the question, the answer, and everything behind it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    request_id: str
    thread_id: str | None = None
    question: str
    answer_prose: str | None = None
    envelope: dict[str, Any] = Field(description="The response as it was returned.")
    evidence: dict[str, Any] = Field(
        description="The full audit trail: agents, tool calls and results, analytics, citations."
    )
    llm_provider: str | None = None
    llm_model: str | None = None
    weather_provider: str | None = None
    duration_ms: float
    partial: bool
    created_at: datetime


class ThreadSummary(BaseModel):
    """One of your conversation threads, as a sidebar lists it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    title: str | None = None
    created_at: datetime
    last_activity_at: datetime
    expires_at: datetime = Field(
        description="When bounded retention will remove it, unless it is used again."
    )
    locations: tuple[str, ...] = Field(
        default=(), description="The places this conversation has established."
    )


class ThreadsResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    threads: tuple[ThreadSummary, ...]


def _summary(record: ThreadRecord) -> ThreadSummary:
    return ThreadSummary(
        id=record.id,
        title=record.title,
        created_at=record.created_at,
        last_activity_at=record.last_activity_at,
        expires_at=record.expires_at,
        locations=tuple(location.qualified_name for location in record.entities.locations),
    )


class EvidenceSummary(BaseModel):
    """One stored run, as a list row: enough to recognise it and open it, and nothing more."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    created_at: datetime
    question: str
    answer_preview: str | None = Field(
        default=None, description="The opening of the answer, for recognising a run in a list."
    )
    duration_ms: float
    partial: bool
    weather_provider: str | None = None
    llm_model: str | None = None
    steps: int = Field(ge=0, description="How many agents the run recorded.")
    locations: tuple[str, ...] = Field(
        default=(),
        description="The places the run resolved, by display name. Never coordinates.",
    )


class EvidenceListResponse(BaseModel):
    """The caller's own recent runs, newest first."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    records: tuple[EvidenceSummary, ...]
    returned: int = Field(ge=0)
    limit: int = Field(ge=1)


# How many rows one page of the list returns unless asked otherwise. A person opening the evidence
# log wants their recent work, not their archive; the record endpoint is how an older one is opened.
DEFAULT_EVIDENCE_LIMIT = 20
MAXIMUM_EVIDENCE_LIMIT = 100


def _summarize(row: AgentRun) -> EvidenceSummary:
    """A list row built from the stored record, reading nothing the record does not hold.

    The location names come from the envelope's own resolution — the display names the run itself
    resolved — so a list entry names places the way every other Weathra screen does. A coordinate
    pair is internal metadata and is never the label a person reads.
    """
    resolved = row.envelope.get("resolved") if isinstance(row.envelope, dict) else None
    places: list[str] = []
    if isinstance(resolved, dict):
        for entry in resolved.get("locations") or ():
            if isinstance(entry, dict):
                name = entry.get("display_name")
                if isinstance(name, str) and name and name not in places:
                    places.append(name)

    agents = row.evidence.get("agents") if isinstance(row.evidence, dict) else None
    steps = len(agents) if isinstance(agents, list) else 0

    preview = (row.answer_prose or "").strip()
    if len(preview) > 160:
        preview = preview[:157].rstrip() + "…"

    return EvidenceSummary(
        id=row.id,
        created_at=row.created_at,
        question=row.question,
        answer_preview=preview or None,
        duration_ms=row.duration_ms,
        partial=row.partial,
        weather_provider=row.weather_provider,
        llm_model=row.llm_model,
        steps=steps,
        locations=tuple(places),
    )


@router.get("/evidence", response_model=EvidenceListResponse, summary="Your evidence records")
async def evidence_records(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    limit: Annotated[
        int,
        Query(
            ge=1,
            le=MAXIMUM_EVIDENCE_LIMIT,
            description="How many of the most recent records to return.",
        ),
    ] = DEFAULT_EVIDENCE_LIMIT,
) -> EvidenceListResponse:
    """*Your* stored runs, newest first.

    **Why this exists.** Evidence was reachable only by identifier, so the navigation entry led to
    a page that could describe the evidence log without ever showing one — a person with a dozen
    stored runs saw the same empty workspace as a person with none. Answering "which runs do I
    have" is not inventing a listing; refusing to answer it was what forced the screen to.

    The ownership predicate is explicit and Row Level Security sits behind it, the same pair the
    record endpoint uses. A caller sees their own rows or no rows; there is no third answer, and
    nothing here reveals that anybody else's exist.
    """
    annotate(request, acting_user_id=principal.user_id)

    rows = (
        (
            await session.execute(
                select(AgentRun)
                .where(AgentRun.user_id == principal.user_id)
                .order_by(AgentRun.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    records = tuple(_summarize(row) for row in rows)
    return EvidenceListResponse(records=records, returned=len(records), limit=limit)


@router.get(
    "/evidence/{evidence_id}", response_model=EvidenceResponse, summary="One evidence record"
)
async def evidence(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    evidence_id: Annotated[str, Path(description="The record's identifier.")],
) -> EvidenceResponse:
    """One of *your* stored evidence records.

    The query carries the ownership predicate explicitly, and Row Level Security is the second gate
    behind it. Either would be enough on its own; both is the point (design.md decision 5).
    """
    annotate(request, acting_user_id=principal.user_id)

    row = (
        await session.execute(
            select(AgentRun).where(
                AgentRun.id == evidence_id, AgentRun.user_id == principal.user_id
            )
        )
    ).scalar_one_or_none()

    if row is None:
        # Identical whether the record is absent or someone else's. The details deliberately carry
        # only the id the caller already knows.
        raise EvidenceNotFound(NOT_FOUND_MESSAGE, details={"id": evidence_id})

    return EvidenceResponse(
        id=row.id,
        request_id=row.request_id,
        thread_id=row.thread_id,
        question=row.question,
        answer_prose=row.answer_prose,
        envelope=row.envelope,
        evidence=row.evidence,
        llm_provider=row.llm_provider,
        llm_model=row.llm_model,
        weather_provider=row.weather_provider,
        duration_ms=row.duration_ms,
        partial=row.partial,
        created_at=row.created_at,
    )


@router.get("/threads", response_model=ThreadsResponse, summary="Your conversation threads")
async def threads(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
) -> ThreadsResponse:
    """Your threads, most recently active first."""
    annotate(request, acting_user_id=principal.user_id)
    found = await ThreadStore(session, principal, settings).list()
    return ThreadsResponse(count=len(found), threads=tuple(_summary(record) for record in found))


@router.get("/threads/{thread_id}", response_model=ThreadSummary, summary="One of your threads")
async def thread(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    thread_id: Annotated[str, Path(description="The thread's identifier.")],
) -> ThreadSummary:
    """One of your threads. A thread you do not own is refused as not found."""
    annotate(request, acting_user_id=principal.user_id)
    return _summary(await ThreadStore(session, principal, settings).open(thread_id))


@router.delete(
    "/threads/{thread_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete one of your threads",
)
async def remove_thread(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    memory: Memory,
    thread_id: Annotated[str, Path(description="The thread's identifier.")],
) -> None:
    """Delete a conversation and its memory.

    Both halves: the ``threads`` row that is the ownership gate, and the checkpoints, which live in
    tables with no foreign key to it and which no cascade would reach.
    """
    annotate(request, acting_user_id=principal.user_id)
    await delete_thread(session, principal, settings, thread_id, checkpointer=memory)
