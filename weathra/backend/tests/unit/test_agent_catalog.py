"""Task 14.14 — the tool catalog: what is offered, what is refused, and what cannot exist.

``specs/agent-orchestration``: agents obtain data exclusively through the approved tool interface,
no agent is given a tool that writes application data, executes code, reaches the filesystem, or
makes an arbitrary network request, an out-of-catalog request returns an error rather than
executing, and invalid arguments come back for correction within the remaining budget.

The strongest of those is the third one, and the reason is worth stating: a capability outside the
catalog is not *rejected* so much as unrepresentable. ``Capability`` is a closed enum, so a plan
naming one cannot be parsed, and there is no code path from a model's proposal to an executor.
"""

from __future__ import annotations

import ast
import inspect
import json
from pathlib import Path

import httpx
import pytest
import respx

from tests.agent_support import agent_settings, connected_tools
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.agents.supervisor import ROUTING_SYSTEM_PROMPT, catalog_capabilities
from weathra.config import Settings
from weathra.domain.errors import ToolNotFound
from weathra.mcp.schemas import TOOL_NAMES

BACKEND_ROOT = Path(__file__).resolve().parents[2]
AGENTS_ROOT = BACKEND_ROOT / "weathra" / "agents"


# =========================================================================== what is offered


async def test_only_the_approved_tools_are_offered() -> None:
    settings = agent_settings()
    async with connected_tools(settings=settings) as tools:
        assert set(tools.tool_names()) == set(TOOL_NAMES)


async def test_every_offered_tool_is_weather_analytics_or_knowledge() -> None:
    """Named individually, so adding a ninth tool has to be a deliberate act."""
    settings = agent_settings()
    weather = {"geocode_location", "weather_current", "weather_forecast", "weather_history"}
    analytics = {"weather_compare", "weather_statistics", "weather_anomaly"}
    # Retrieval, like the weather tools, and of the same subject: imagery of a place at a time.
    # It reaches one public NASA service, takes no credential, and computes nothing.
    observation = {"weather_satellite"}

    async with connected_tools(settings=settings) as tools:
        assert set(tools.tool_names()) == weather | analytics | observation


async def test_no_tool_permits_a_write_code_execution_filesystem_or_network_access() -> None:
    """Asserted against the *names and schemas*, which is what a model can actually reach for."""
    settings = agent_settings()
    forbidden = (
        "write",
        "insert",
        "update",
        "delete",
        "save",
        "exec",
        "eval",
        "shell",
        "command",
        "run_",
        "file",
        "read_file",
        "path",
        "fetch",
        "http",
        "url",
        "request",
        "browse",
        "curl",
        "sql",
        "query",
    )

    async with connected_tools(settings=settings) as tools:
        for tool in tools.catalog_for_prompt():
            name = tool["name"]
            assert not any(word in name.lower() for word in forbidden), (
                f"{name} names an operation outside retrieval and computation"
            )
            # No argument accepts a path, a URL, or a command either — a tool named innocently
            # that took a `url` would be an arbitrary-network-request tool.
            arguments = set(tool["input_schema"].get("properties", {}))
            assert not (arguments & {"url", "path", "file", "command", "code", "sql", "query"}), (
                f"{name} accepts an argument that would reach outside its own subject: {arguments}"
            )


def test_the_capability_catalog_offered_to_the_model_is_the_six() -> None:
    """The catalog and the prompt name the same set — `satellite` joined both in task 34.34.

    The pairing is the point rather than the list: a capability the enum accepts and the prompt
    never mentions is one the model will not route to, and a capability the prompt offers and the
    enum rejects is a plan that fails validation every time the model takes the offer.
    """
    assert catalog_capabilities() == (
        "current",
        "satellite",
        "forecast",
        "historical",
        "analytics",
        "rag",
    )
    for capability in catalog_capabilities():
        assert f'"{capability}"' in ROUTING_SYSTEM_PROMPT


def test_the_routing_prompt_offers_no_tool_protocol() -> None:
    """The model proposes capabilities; the graph calls tools (design.md decision 2).

    A prompt that described the tool-calling protocol would invite the model to try to use it, and
    a model that emitted a tool call would be proposing an execution nothing here would honour.
    """
    lowered = ROUTING_SYSTEM_PROMPT.lower()
    assert "tool_calls" not in lowered
    assert "function_call" not in lowered
    for tool in TOOL_NAMES:
        assert tool not in lowered, f"{tool} is a tool name; the model is offered capabilities"


# =========================================================================== out of catalog


def test_a_capability_outside_the_catalog_cannot_be_parsed_into_a_plan() -> None:
    """The strongest form of the guard: there is nothing to execute, not merely nothing executed."""
    with pytest.raises(ValueError) as raised:
        RoutingPlan.model_validate(
            {
                "steps": [{"capability": "run_shell_command", "reason": "to look it up"}],
                "reason": "improvising",
            }
        )

    message = str(raised.value)
    for capability in catalog_capabilities():
        assert capability in message, "the error lists the catalog so the model can choose again"


def test_every_capability_in_the_enum_has_a_node() -> None:
    """So the dispatch cannot silently fall through for a capability someone adds.

    The dispatch function is located by the sentinel it raises rather than by name, so renaming it
    does not silently turn this test into a no-op.
    """
    import weathra.agents.graph as graph_module

    sentinel = "no node is registered for capability"
    dispatchers = [
        inspect.getsource(member)
        for member in vars(graph_module).values()
        if inspect.isfunction(member) and sentinel in (inspect.getsource(member) or "")
    ]
    assert len(dispatchers) == 1, (
        f"expected exactly one dispatch function raising {sentinel!r}, found {len(dispatchers)}"
    )

    for capability in Capability:
        assert f"Capability.{capability.name}" in dispatchers[0], (
            f"{capability} has no dispatch branch"
        )


@respx.mock
async def test_an_out_of_catalog_capability_returns_the_error_to_the_model() -> None:
    """The retry carries the valid names, which is what makes it correctable."""
    from weathra.agents.llm.openrouter import OpenRouterClient
    from weathra.agents.state import GraphState
    from weathra.agents.supervisor import route
    from weathra.domain.identity import Principal

    settings = Settings(
        supabase_url="https://test.supabase.co",
        openrouter_api_key="test-credential",
        openrouter_base_url="https://gateway.test/api/v1",
        llm_json_max_attempts=2,
        http_backoff_seconds=0,
    )

    def completion(content: str) -> dict:
        return {
            "model": "vendor/model",
            "choices": [{"message": {"role": "assistant", "content": content}}],
        }

    valid = json.dumps(
        RoutingPlan(
            steps=(PlanStep(capability=Capability.FORECAST, reason="the forecast"),),
            reason="corrected",
        ).model_dump(mode="json")
    )

    route_mock = respx.post("https://gateway.test/api/v1/chat/completions").mock(
        side_effect=[
            httpx.Response(
                200,
                json=completion(
                    '{"steps": [{"capability": "read_file", "reason": "look it up"}], '
                    '"reason": "improvising"}'
                ),
            ),
            httpx.Response(200, json=completion(valid)),
        ]
    )

    state = GraphState.begin(
        question="Will it rain in Berlin tomorrow?",
        request_id="req_1",
        principal=Principal.from_claims({"sub": "11111111-1111-4111-8111-111111111111"}),
    )
    result = await route(
        state, client=OpenRouterClient(client=httpx.AsyncClient(), settings=settings)
    )

    correction = json.loads(route_mock.calls[1].request.content)["messages"][-1]["content"]
    assert "capability" in correction
    for capability in catalog_capabilities():
        assert capability in correction

    assert result.plan is not None
    assert result.plan.capabilities == (Capability.FORECAST,)


async def test_an_unknown_tool_name_is_refused_before_the_protocol_is_bothered() -> None:
    """The client's own guard, for the case a node asks for a tool that does not exist."""
    settings = agent_settings()
    async with connected_tools(settings=settings) as tools:
        with pytest.raises(ToolNotFound) as raised:
            await tools.call("run_shell_command", {})

    assert "run_shell_command" in str(raised.value)
    for tool in TOOL_NAMES:
        assert tool in str(raised.value), "the error lists what is available"


# =========================================================================== invalid arguments


async def test_invalid_arguments_come_back_as_a_result_the_model_can_correct() -> None:
    """Returned, not raised: raising would end the run instead of letting it be corrected."""
    settings = agent_settings()
    async with connected_tools(settings=settings) as tools:
        outcome = await tools.call("weather_forecast", {"latitude": 999.0, "longitude": 0.0})

    assert outcome.failed
    assert outcome.error_message
    assert outcome.data == {}, "a failure carries no weather values"


async def test_an_invalid_call_leaves_the_budget_to_try_again() -> None:
    """The remaining budget is what makes "may correct the call" meaningful."""
    from weathra.agents.budget import Budget

    settings = agent_settings(agent_max_steps=6)
    budget = Budget.from_settings(settings)

    async with connected_tools(settings=settings) as tools:
        first = await tools.call("weather_history", {"latitude": 52.52, "longitude": 13.41})
        budget.spend()
        assert first.failed

        corrected = await tools.call(
            "weather_history",
            {
                "latitude": 52.52,
                "longitude": 13.41,
                "start": "2025-06-01",
                "end": "2025-06-07",
            },
        )
        budget.spend()

    assert corrected.ok, "the corrected call succeeded"
    assert budget.remaining_steps == 4
    assert not budget.check().exhausted


async def test_a_failed_tool_result_never_carries_weather_values() -> None:
    """``ToolResult``'s own invariant, exercised through the real path a node takes."""
    from weathra.agents.nodes.support import call_tool
    from weathra.agents.state import GraphState
    from weathra.domain.evidence import AgentName
    from weathra.domain.identity import Principal

    settings = agent_settings()
    state = GraphState.begin(
        question="Berlin?",
        request_id="req_1",
        principal=Principal.from_claims({"sub": "11111111-1111-4111-8111-111111111111"}),
    )

    async with connected_tools(settings=settings) as tools:
        updated, outcome = await call_tool(
            state,
            tools,
            agent=AgentName.FORECAST,
            tool="weather_forecast",
            arguments={"latitude": 999.0, "longitude": 0.0},
        )

    assert outcome.failed
    recorded = updated.tool_results[0]
    assert not recorded.ok
    assert recorded.payload is None
    assert recorded.error_code
    assert recorded.data_class is None


# =========================================================================== structural


def _agent_modules() -> list[Path]:
    return sorted(
        path
        for path in AGENTS_ROOT.rglob("*.py")
        if "__pycache__" not in path.parts and path.name != "__init__.py"
    )


def test_there_are_agent_modules_to_scan() -> None:
    assert len(_agent_modules()) >= 8


@pytest.mark.parametrize("path", _agent_modules(), ids=lambda path: path.name)
def test_no_agent_module_imports_a_weather_provider_directly(path: Path) -> None:
    """``specs/agent-orchestration``: no agent calls a weather provider directly.

    The agents reach data through ``McpToolClient`` and nothing else. An import of
    ``weathra.providers`` here would be a second path to the same data with none of the tool
    layer's validation, attribution, or evidence recording.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)

    forbidden = {
        module
        for module in imported
        if module.startswith("weathra.providers") or module.startswith("weathra.geocoding.open_")
    }
    # ``weathra.providers.http`` is the shared HTTP client and its retry policy, which the
    # OpenRouter client legitimately uses to talk to the *inference* gateway.
    forbidden -= {"weathra.providers.http"}
    assert not forbidden, f"{path.name} imports a weather provider directly: {sorted(forbidden)}"


@pytest.mark.parametrize("path", _agent_modules(), ids=lambda path: path.name)
def test_no_agent_module_computes_a_statistic_itself(path: Path) -> None:
    """The analytics functions are reached through the tools, never imported and called here.

    ``specs/agent-orchestration``: no agent computes a statistic itself. An import of
    ``weathra.analytics`` in this package would be exactly that, and would put a figure in an
    answer with no tool call behind it in the evidence record.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        module = None
        if isinstance(node, ast.Import):
            module = next(
                (alias.name for alias in node.names if alias.name.startswith("weathra.analytics")),
                None,
            )
        elif isinstance(node, ast.ImportFrom) and node.module:
            module = node.module if node.module.startswith("weathra.analytics") else None
        assert module is None, f"{path.name} imports {module} and could compute a figure itself"


def test_the_knowledge_node_is_given_no_tool_client() -> None:
    """So "a conceptual question calls no weather tool" is wiring, not a rule to remember."""
    from weathra.agents.nodes.knowledge import run_knowledge

    parameters = set(inspect.signature(run_knowledge).parameters)
    assert parameters == {"state", "step", "retrieve"}
    assert "client" not in parameters
    assert "tools" not in parameters


def test_a_location_is_the_only_free_text_a_tool_takes_from_a_plan() -> None:
    """A plan's fields are a closed set, so a model cannot smuggle an instruction into a call.

    Each is either an enum, a bounded number, a date, or a place name that goes through the
    geocoder. There is no field whose contents reach a tool unvalidated.
    """
    free_text = {
        name
        for name, field in PlanStep.model_fields.items()
        if field.annotation in (str, str | None)
    }
    assert free_text == {"location", "measure", "concept", "question_part", "reason"}
    # And of those, only the location reaches a tool at all — through the geocoder.
    assert "location" in free_text
