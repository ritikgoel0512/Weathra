"""Task 1.7 — design.md decision 1's import rule, enforced.

The rule:

    domain ← providers/geocoding/analytics ← weather/rag/memory ← mcp ← agents ← api

with ``auth/`` sitting beside ``memory/`` and depended on only by ``api/`` and ``memory/`` — and by
``evaluation/``, which sits above ``api/`` and drives it as an outside caller (see
``AUTH_CONSUMERS``).
Never the reverse. Two consequences are load-bearing:

* No module below ``agents/`` imports ``agents`` or any LLM client. That is what keeps the
  deterministic spine — providers, analytics, weather, MCP, RAG, memory — working with no inference
  credential configured, and what makes ``specs/deterministic-analytics``' purity requirement
  structural rather than aspirational.
* No module in ``agents/nodes/`` imports a provider client directly. Nodes reach weather data
  through the MCP tool boundary, which is what ``specs/agent-orchestration`` requires.

The checker walks the real source tree with the ``ast`` module, so it sees an import whether or not
anything executes it. ``test_checker_catches_a_deliberate_violation`` proves the checker fails when
a violating import is introduced, rather than asking a reader to trust that it would.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple

import pytest

PACKAGE = "weathra"

# Layer index per top-level subpackage. A module may import its own layer and any lower one.
LAYERS: dict[str, int] = {
    "config": 0,
    "domain": 0,
    "db": 1,
    "providers": 2,
    "geocoding": 2,
    "analytics": 2,
    "weather": 3,
    "rag": 3,
    "memory": 3,
    "auth": 3,
    # The catalog, policy and plan stores. Above `db` because they are repositories over it, and
    # below `agents` because the resolver that consumes them sits between the graph and the client
    # (design.md decision 22) — a node reaching for a store directly would be exactly the model
    # selection that layer exists to keep out of the graph.
    "entitlements": 3,
    # Usage events, cost estimation and aggregation. Above `db` because it writes rows, and below
    # `agents` because the instrumented client is a wrapper the agent layer installs — telemetry
    # records what a run did and never participates in it.
    "telemetry": 3,
    "mcp": 4,
    "agents": 5,
    "api": 6,
    "evaluation": 7,
}

# Subpackages permitted to import `auth/` at all, regardless of layer.
#
# ``evaluation/`` is on this list and the reason is worth stating, because "the harness needed it"
# would be the wrong one. The rule exists to keep the *request path* to a single identity path:
# a provider or an analytics module that reached for a principal would be a second authorization
# path (design.md decision 4). ``evaluation/`` is not on the request path — it sits above ``api/``
# and drives the app from outside, as a caller. It needs ``auth/`` for exactly the thing a caller
# needs: to obtain a token and to authenticate. Excluding it would mean either a duplicate token
# implementation or a suite that could not authenticate, and both are worse than the rule's letter.
AUTH_CONSUMERS = frozenset({"auth", "api", "memory", "evaluation"})

# `agents/nodes/` reaches weather data through the MCP tool boundary, never a provider client, and
# it reaches a model through whatever client the graph hands it — never through the policy layer.
#
# `entitlements` is on this list for a reason worth stating. A node that could import it could ask
# for a different call role's client, or resolve a second time mid-run, or consult the catalog
# directly — and "no node selects a model" (`specs/model-policy`) would become a convention rather
# than a fact. The graph resolves both roles and passes each node the client it gets.
#
# `telemetry` is there for the mirror-image reason. Recording is a decorator over the client
# (design.md decision 24), so a node that emitted its own usage event would be a second, parallel
# record of the same call — which is exactly what task 29.9 forbids.
NODES_FORBIDDEN = frozenset({"providers", "geocoding", "entitlements", "telemetry"})

# Task 5.8: no module *above* the provider layer names a concrete provider client. `providers/`
# and `geocoding/` are the provider layer — they sit at the same level and share both the vendor's
# constants and the transport policy, which is why the Open-Meteo geocoder may import the
# Open-Meteo provider. `providers/http.py` is deliberately not on this list: it is the shared
# client factory and failure translation, not a client for any particular upstream.
CONCRETE_PROVIDER_MODULES = frozenset({"weathra.providers.open_meteo"})
PROVIDER_LAYER = frozenset({"providers", "geocoding"})


class Violation(NamedTuple):
    """A single offending import. Rendered into the assertion message."""

    module: str
    imported: str
    line: int
    reason: str

    def __str__(self) -> str:
        return f"{self.module}:{self.line} imports {self.imported} — {self.reason}"


def _module_name(path: Path, package_root: Path) -> str:
    relative = path.relative_to(package_root).with_suffix("")
    parts = [PACKAGE, *relative.parts]
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _imports(path: Path, module: str) -> Iterator[tuple[str, int]]:
    """Every `weathra.*` target this module imports, resolved through relative imports."""
    tree = ast.parse(path.read_text(), filename=str(path))
    package = module if path.name == "__init__.py" else module.rsplit(".", 1)[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] == PACKAGE:
                    yield alias.name, node.lineno
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")
                trimmed = base[: len(base) - node.level + 1]
                target = ".".join([*trimmed, node.module] if node.module else trimmed)
            else:
                target = node.module or ""
            if target.split(".")[0] == PACKAGE:
                # `from weathra.domain import errors` names weathra.domain.errors too, but the
                # subpackage is what the layer rule cares about.
                yield target, node.lineno


def _subpackage(dotted: str) -> str:
    parts = dotted.split(".")
    return parts[1] if len(parts) > 1 else ""


def _layer(dotted: str) -> int | None:
    return LAYERS.get(_subpackage(dotted))


def violations(package_root: Path) -> list[Violation]:
    """Every import in the tree that breaks decision 1's rule."""
    found: list[Violation] = []
    for path in sorted(package_root.rglob("*.py")):
        module = _module_name(path, package_root)
        origin = _subpackage(module)
        origin_layer = _layer(module)
        for imported, line in _imports(path, module):
            target = _subpackage(imported)
            if not target or target == origin:
                continue

            target_layer = _layer(imported)

            # domain imports nothing internal.
            if origin == "domain":
                found.append(Violation(module, imported, line, "domain/ imports nothing internal"))
                continue

            # Nothing below agents/ imports agents or an LLM client.
            if target == "agents" and (origin_layer is None or origin_layer < LAYERS["agents"]):
                found.append(
                    Violation(
                        module,
                        imported,
                        line,
                        "nothing below agents/ may import agents or an LLM client",
                    )
                )
                continue

            # agents/nodes/ reaches providers only through the MCP tool boundary.
            if module.startswith(f"{PACKAGE}.agents.nodes") and target in NODES_FORBIDDEN:
                found.append(
                    Violation(
                        module,
                        imported,
                        line,
                        "agents/nodes/ must reach weather data through the MCP boundary",
                    )
                )
                continue

            # Only api/ and memory/ import auth/.
            if target == "auth" and origin not in AUTH_CONSUMERS:
                found.append(
                    Violation(module, imported, line, "only api/ and memory/ may import auth/")
                )
                continue

            # Only the provider layer names a concrete provider client.
            if imported in CONCRETE_PROVIDER_MODULES and origin not in PROVIDER_LAYER:
                found.append(
                    Violation(
                        module,
                        imported,
                        line,
                        "a concrete provider client is reachable only through providers/",
                    )
                )
                continue

            # The layering itself.
            if (
                origin_layer is not None
                and target_layer is not None
                and target_layer > origin_layer
            ):
                found.append(
                    Violation(
                        module,
                        imported,
                        line,
                        f"{origin}/ (layer {origin_layer}) may not import "
                        f"{target}/ (layer {target_layer})",
                    )
                )
    return found


def test_every_subpackage_has_a_declared_layer(package_root: Path) -> None:
    """A new subpackage must be placed in the layering deliberately, not slip past the checker."""
    subpackages = {path.parent.name for path in package_root.glob("*/__init__.py")}
    assert subpackages <= set(LAYERS), f"unplaced subpackages: {sorted(subpackages - set(LAYERS))}"


def test_import_rule_holds(package_root: Path) -> None:
    found = violations(package_root)
    assert not found, "architecture boundary violations:\n" + "\n".join(str(v) for v in found)


def _write_module(root: Path, dotted: str, body: str) -> None:
    path = root.joinpath(*dotted.split(".")[1:]).with_suffix(".py")
    path.parent.mkdir(parents=True, exist_ok=True)
    for parent in [path.parent, *path.parent.parents]:
        if parent == root.parent:
            break
        (parent / "__init__.py").touch()
    path.write_text(body)


@pytest.mark.parametrize(
    ("module", "body", "expected"),
    [
        pytest.param(
            "weathra.analytics.descriptive",
            "from weathra.agents.llm.openrouter import OpenRouterClient\n",
            "nothing below agents/",
            id="analytics-imports-an-llm-client",
        ),
        pytest.param(
            "weathra.providers.open_meteo",
            "import weathra.agents.graph\n",
            "nothing below agents/",
            id="provider-imports-the-graph",
        ),
        pytest.param(
            "weathra.agents.nodes.forecast",
            "from weathra.providers.open_meteo import OpenMeteoProvider\n",
            "MCP boundary",
            id="node-imports-a-provider-client",
        ),
        pytest.param(
            "weathra.weather.forecast_service",
            "from weathra.auth.deps import require_principal\n",
            "only api/ and memory/",
            id="weather-imports-auth",
        ),
        pytest.param(
            "weathra.mcp.server",
            "from weathra.auth.tokens import validate\n",
            "only api/ and memory/",
            id="mcp-imports-auth",
        ),
        pytest.param(
            "weathra.domain.weather",
            "from weathra.providers.base import WeatherProvider\n",
            "domain/ imports nothing internal",
            id="domain-imports-providers",
        ),
        pytest.param(
            "weathra.providers.cache",
            "from weathra.weather.forecast_service import analyse\n",
            "may not import",
            id="provider-imports-a-service",
        ),
        pytest.param(
            "weathra.mcp.tools.forecast",
            "from weathra.api.deps import get_settings\n",
            "may not import",
            id="mcp-imports-the-api",
        ),
        pytest.param(
            "weathra.weather.history_service",
            "from weathra.providers.open_meteo import OpenMeteoProvider\n",
            "reachable only through providers/",
            id="service-imports-a-concrete-provider",
        ),
        pytest.param(
            "weathra.mcp.tools.current",
            "from weathra.providers.open_meteo import OpenMeteoProvider\n",
            "reachable only through providers/",
            id="mcp-imports-a-concrete-provider",
        ),
    ],
)
def test_checker_catches_a_deliberate_violation(
    tmp_path: Path, module: str, body: str, expected: str
) -> None:
    """The rule is only worth having if the checker actually fails on a violation."""
    root = tmp_path / PACKAGE
    root.mkdir()
    (root / "__init__.py").touch()
    _write_module(root, module, body)

    found = violations(root)
    assert found, f"the checker missed {module} importing:\n{body}"
    assert any(expected in v.reason for v in found), [v.reason for v in found]


def test_the_provider_layer_may_share_its_vendor_constants(tmp_path: Path) -> None:
    """`geocoding/` sits beside `providers/`, so the Open-Meteo geocoder may reuse its URLs."""
    root = tmp_path / PACKAGE
    root.mkdir()
    (root / "__init__.py").touch()
    _write_module(
        root,
        "weathra.geocoding.open_meteo",
        "from weathra.providers.open_meteo import FORECAST_URL\n"
        "from weathra.providers.http import request_json\n",
    )
    assert violations(root) == []


def test_checker_accepts_a_legal_import(tmp_path: Path) -> None:
    root = tmp_path / PACKAGE
    root.mkdir()
    (root / "__init__.py").touch()
    _write_module(root, "weathra.weather.forecast_service", "from weathra.domain import weather\n")
    _write_module(root, "weathra.memory.threads", "from weathra.auth.deps import Principal\n")
    _write_module(root, "weathra.agents.nodes.forecast", "from weathra.mcp.client import call\n")
    assert violations(root) == []


def test_checker_resolves_relative_imports(tmp_path: Path) -> None:
    root = tmp_path / PACKAGE
    root.mkdir()
    (root / "__init__.py").touch()
    _write_module(root, "weathra.analytics.trend", "from ..agents.llm import base\n")
    found = violations(root)
    assert found and "nothing below agents/" in found[0].reason
