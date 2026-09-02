"""The RAG capability node: explain a concept from the knowledge base, or say it is not covered.

**It calls no weather tool.** A conceptual question — "what does dew point mean?" — needs no
forecast and no archive, and retrieving one would produce numbers nobody asked about that the
synthesis node would then feel obliged to explain. So this node's only dependency is the retrieval
function; it is handed no MCP client at all, which is how "calls no weather tool" is a property of
the wiring rather than a rule.

**An empty retrieval is an answer.** ``rag/retrieve.py`` drops anything below the relevance
threshold, so a question about tax law gets nothing back rather than the closest weather passage.
This node records that as a citation-free step with the "not covered" note, and the synthesis node
says so. A confident explanation drawn from a passage that is not about the concept is precisely
what the threshold exists to prevent.

**Chunks are data.** Every retrieved passage travels as content and is labelled as a citation. An
instruction embedded in a document — Weathra's corpus is authored, but the rule is structural —
changes nothing about routing, tools, or grounding, because nothing here reads a chunk as anything
but text to cite (``specs/agent-orchestration``, ``specs/safety-grounding``).

**Retrieval needs no inference credential.** Embedding is local and search is a database query, so
this node runs when the agent surface as a whole cannot. What it cannot do without a model is write
the *explanation* — and the citations are still returned.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from weathra.agents.nodes.support import record_step
from weathra.agents.plan import PlanStep
from weathra.agents.state import GraphState
from weathra.domain.errors import MemoryUnavailable, VectorIndexMismatch
from weathra.domain.evidence import AgentName, StepStatus
from weathra.rag.retrieve import RetrievalResult

__all__ = ["KnowledgeRetriever", "run_knowledge"]

logger = logging.getLogger("weathra.agents.nodes.knowledge")

KnowledgeRetriever = Callable[[str], Awaitable[RetrievalResult]]
"""A bound retrieval: the session, embedder, and settings are closed over by the caller.

A callable rather than the session and embedder themselves, because this node has no business
holding a database session — it needs "given a query, give me passages", and nothing more.
"""


async def run_knowledge(
    state: GraphState, step: PlanStep, *, retrieve: KnowledgeRetriever
) -> GraphState:
    """Retrieve the passages that explain the step's concept, and record what was cited."""
    started = datetime.now(UTC)
    query = (step.concept or state.question).strip()

    if not query:
        return record_step(
            state,
            agent=AgentName.RAG,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="No concept was named, so there was nothing to look up.",
        )

    try:
        result = await retrieve(query)
    except VectorIndexMismatch as exc:
        # A mismatched index produces numbers that look like similarities and are not. Refusing is
        # the only honest option, and re-indexing is an operator's job.
        logger.warning("knowledge retrieval refused: %s", exc.code)
        return record_step(
            state.with_failure(
                "Weathra's knowledge index needs rebuilding, so the concept could not be looked up."
            ),
            agent=AgentName.RAG,
            started_at=started,
            status=StepStatus.FAILED,
            reason=f"The knowledge index is not usable: {exc}",
        )
    except MemoryUnavailable as exc:
        return record_step(
            state.with_failure("Weathra's knowledge base could not be reached."),
            agent=AgentName.RAG,
            started_at=started,
            status=StepStatus.FAILED,
            reason=f"The knowledge store was unreachable: {exc}",
        )

    if not result.found_any:
        # Recorded as a *success* with no citations: the retrieval ran and the honest answer is
        # that the corpus does not cover this. A failure status would suggest something broke.
        logger.info("no knowledge covered %r", query)
        return record_step(
            state.with_failure(result.note or "Weathra's knowledge base does not cover this."),
            agent=AgentName.RAG,
            started_at=started,
            status=StepStatus.SUCCEEDED,
            reason=(
                f"Nothing in Weathra's knowledge base met the relevance threshold of "
                f"{result.threshold:.2f} for this concept, so nothing was cited."
            ),
        )

    working = state.with_citations(result.citations())
    logger.info("cited %d knowledge documents", len(result.document_ids))

    return record_step(
        working,
        agent=AgentName.RAG,
        started_at=started,
        status=StepStatus.SUCCEEDED,
        reason=(
            f"{step.reason} Cited: {', '.join(result.document_ids)}."
            if step.reason
            else f"Cited: {', '.join(result.document_ids)}."
        ),
    )
