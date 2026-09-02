"""The client the backend reaches its own tools through.

The graph does not call ``providers`` or ``analytics`` directly — it calls tools, over the MCP
protocol, through this client. That indirection is the point: it is what makes
``specs/agent-orchestration``'s "agents obtain data exclusively through the approved tool
interface" a structural fact rather than a convention, and it is what lets the tool boundary be
promoted to its own service without touching a node.

**Fail fast at startup.** ``specs/mcp-weather-server`` requires the backend to report a clear
failure naming the server and its configured address when the tool server is unreachable. A
mis-wired MCP address that only surfaces on the first question is a much worse outcome than a
startup that refuses.

Transport is configuration. ``in-process`` runs the server in this process over an in-memory
stream — one deployable, no network hop, protocol boundary intact. ``http`` is the same client
against a co-deployed or separate server.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any, Self

from mcp import types
from mcp.client.session import ClientSession
from mcp.server.mcpserver import MCPServer

from weathra.config import Settings
from weathra.domain.errors import McpUnavailable, ToolNotFound

__all__ = ["McpToolClient", "ToolCallOutcome"]

logger = logging.getLogger("weathra.mcp.client")

SERVER_NAME = "weathra-weather"


def _root_cause(failure: BaseException) -> str:
    """The most useful name in a failure, unwrapping the task groups both transports use.

    An anyio task group reports a connection refusal as an ``ExceptionGroup``, and "ExceptionGroup"
    in a startup error tells an operator nothing at all.
    """
    if isinstance(failure, BaseExceptionGroup) and failure.exceptions:
        return _root_cause(failure.exceptions[0])
    return type(failure).__name__


@dataclass(slots=True)
class ToolCallOutcome:
    """What a tool call produced, as the graph needs to record it.

    A failure is a first-class outcome rather than an exception: ``specs/agent-orchestration``
    requires an invalid call's error to be *returned to the model as the tool result* so it can
    correct itself within the remaining budget. Raising would end the run instead.
    """

    tool: str
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error_class: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    text: str = ""

    @property
    def failed(self) -> bool:
        return not self.ok


class McpToolClient:
    """A connected MCP session, with the tool catalog it discovered at startup."""

    def __init__(self, *, settings: Settings, server: MCPServer | None = None) -> None:
        self._settings = settings
        self._server = server
        self._session: ClientSession | None = None
        self._stack: AsyncExitStack | None = None
        self._tools: tuple[types.Tool, ...] = ()

    # ---------------------------------------------------------------- lifecycle

    async def __aenter__(self) -> Self:
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()

    async def connect(self) -> None:
        """Connect and list the catalog, or fail with the server and address named."""
        transport = self._settings.mcp_transport
        address = "in-process" if transport == "in-process" else self._settings.mcp_server_address

        if transport == "in-process" and self._server is None:
            raise McpUnavailable(
                "The MCP weather server is configured for the in-process transport but no server "
                "instance was supplied to the client. This is a wiring error in the application "
                "lifespan.",
                details={"server": SERVER_NAME, "transport": transport},
            )

        try:
            # The exit stack is entered and, on success, detached with `pop_all` so the session
            # outlives this method. On failure it unwinds *here*, inside the same task that
            # entered it — which matters: both transports run their own anyio task group, and
            # closing one from a different task raises "cancel scope in a different task" and
            # buries the real connection error under it.
            async with AsyncExitStack() as stack:
                read, write = await self._open(stack, transport)
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                catalog = await session.list_tools()
                self._stack = stack.pop_all()
        except McpUnavailable:
            raise
        except BaseException as failure:
            # Named server, named address, named reason — the three things an operator needs.
            raise McpUnavailable(
                f"The MCP weather server ({SERVER_NAME}) at {address} could not be reached, so "
                "the agent surface cannot start. Check MCP_TRANSPORT and MCP_SERVER_ADDRESS.",
                details={
                    "server": SERVER_NAME,
                    "address": address,
                    "transport": transport,
                    "reason": _root_cause(failure),
                },
            ) from failure

        self._session = session
        self._tools = tuple(catalog.tools)

        expected = set(self._settings.mcp_enabled_tools)
        missing = expected - {tool.name for tool in self._tools}
        if missing:
            await self.close()
            raise McpUnavailable(
                f"The MCP weather server at {address} does not expose the configured tools: "
                f"{', '.join(sorted(missing))}.",
                details={
                    "server": SERVER_NAME,
                    "address": address,
                    "missing": sorted(missing),
                },
            )

        logger.info(
            "connected to the MCP weather server at %s with %d tools", address, len(self._tools)
        )

    async def _open(self, stack: AsyncExitStack, transport: str) -> tuple[Any, Any]:
        """The read and write streams for the configured transport."""
        if transport == "in-process":
            from mcp.client._memory import InMemoryTransport

            if self._server is None:  # pragma: no cover - `connect` refuses this first
                raise McpUnavailable(
                    "No in-process MCP server was supplied.",
                    details={"server": SERVER_NAME, "transport": transport},
                )
            read, write = await stack.enter_async_context(InMemoryTransport(self._server))
            return read, write

        from mcp.client.streamable_http import streamable_http_client

        streams = await stack.enter_async_context(
            streamable_http_client(self._settings.mcp_server_address)
        )
        return streams[0], streams[1]

    async def close(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._stack = None
        self._session = None

    # ---------------------------------------------------------------- catalog

    @property
    def tools(self) -> tuple[types.Tool, ...]:
        return self._tools

    def tool_names(self) -> tuple[str, ...]:
        return tuple(tool.name for tool in self._tools)

    def catalog_for_prompt(self) -> tuple[dict[str, Any], ...]:
        """The catalog as the supervisor offers it to the model.

        Only what a model needs to choose and call correctly: the name, the description, and the
        argument schema. Nothing here permits a write, code execution, filesystem access, or an
        arbitrary network request, because no such tool exists to offer.
        """
        return tuple(
            {
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.input_schema,
            }
            for tool in self._tools
        )

    # ---------------------------------------------------------------- calling

    async def call(self, name: str, arguments: dict[str, Any]) -> ToolCallOutcome:
        """Call a tool, returning its outcome — including a failure — rather than raising.

        An unknown name is refused *here*, before the protocol is bothered, with the available
        names listed. That is the error the model gets back so it can pick a real tool instead.
        """
        if self._session is None:
            raise McpUnavailable(
                "The MCP tool client is not connected.",
                details={"server": "weathra-weather"},
            )

        if name not in self.tool_names():
            raise ToolNotFound(
                f"No tool named {name!r} is available. Available tools: "
                f"{', '.join(self.tool_names())}.",
                details={"requested": name, "available": list(self.tool_names())},
            )

        result = await self._session.call_tool(
            name, arguments, read_timeout_seconds=self._settings.mcp_timeout_seconds
        )

        text = " ".join(
            block.text for block in getattr(result, "content", []) if hasattr(block, "text")
        )
        structured = getattr(result, "structured_content", None) or {}

        if getattr(result, "is_error", False):
            return ToolCallOutcome(
                tool=name,
                ok=False,
                error_class=structured.get("error_class", "internal"),
                error_code=structured.get("code", "internal_error"),
                error_message=structured.get("message") or text,
                text=text,
            )

        return ToolCallOutcome(tool=name, ok=True, data=structured, text=text)
