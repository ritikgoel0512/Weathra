"""The smallest LangGraph graph that can prove a checkpointer works.

At module level on purpose. LangGraph resolves a state schema's annotations with
``get_type_hints``, which sees module globals and not a function's locals — so a ``TypedDict``
declared inside a test raises ``NameError: name 'Annotated' is not defined`` under
``from __future__ import annotations``. Shared here rather than duplicated in the checkpointer and
retention suites, both of which need graph state that actually accumulates.
"""

from __future__ import annotations

import operator
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph


class Conversation(TypedDict):
    """An accumulating list of turns: enough to tell resumed state from a fresh run."""

    turns: Annotated[list[str], operator.add]


def _record(state: Conversation) -> Conversation:
    return {"turns": [f"answered {state['turns'][-1]}"]}


def one_turn_graph() -> StateGraph:
    graph = StateGraph(Conversation)
    graph.add_node("record", _record)
    graph.add_edge(START, "record")
    graph.add_edge("record", END)
    return graph
