"""The What Changed? route delegates; it does not compute.

``tests/integration/test_changes.py`` proves the behaviour — the endpoint calls
``compare_with_previous`` and returns its result unchanged. This proves the *structure*, offline and
without a database: there is no arithmetic in the route module at all, so a delta cannot be being
computed there whatever a future edit does to the handler's shape.

Worth having as its own test rather than trusting the behavioural one, because the failure this
guards against is a slow one: somebody adds "just a small adjustment" to a value on the way out, and
the endpoint quietly becomes a second implementation of a rule ``specs/forecast-analysis`` states
once. The AST check fails on the first arithmetic operator.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROUTE = Path("weathra/api/routers/changes.py")

# Every operator that could combine two figures into a third.
ARITHMETIC = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)


@pytest.fixture(scope="module")
def module(package_root: Path) -> ast.Module:
    return ast.parse((package_root.parent / ROUTE).read_text())


def test_the_route_imports_the_domain_comparison_capability(module: ast.Module) -> None:
    imported = {
        (node.module, alias.name)
        for node in ast.walk(module)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert ("weathra.weather.snapshots", "compare_with_previous") in imported
    assert ("weathra.weather.snapshots", "WhatChanged") in imported


def test_the_route_calls_the_comparison_capability(module: ast.Module) -> None:
    called = {
        node.func.id
        for node in ast.walk(module)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "compare_with_previous" in called


def test_the_route_performs_no_arithmetic_of_its_own(module: ast.Module) -> None:
    """No number in the response can have been produced here."""
    offending = [
        ast.unparse(node)
        for node in ast.walk(module)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ARITHMETIC)
    ]
    assert offending == [], f"the route computes: {offending}"

    unary = [
        ast.unparse(node)
        for node in ast.walk(module)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub)
    ]
    assert unary == [], f"the route negates a value: {unary}"


def test_the_route_builds_no_comparison_result_of_its_own(module: ast.Module) -> None:
    """``WhatChanged`` and ``DayChange`` are constructed by the domain, never by the handler."""
    constructed = {
        node.func.id
        for node in ast.walk(module)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "WhatChanged" not in constructed, "the route must return the domain's own result"
    assert "DayChange" not in constructed


def test_the_route_asks_no_language_model_and_reaches_no_provider_directly(
    module: ast.Module,
) -> None:
    """The comparison is arithmetic over stored figures. Nothing here may infer or fetch it."""
    source = ast.unparse(module)
    for forbidden in ("llm", "Inference", "openrouter", "httpx", "open_meteo"):
        assert forbidden not in source, f"the route reaches for {forbidden}"
