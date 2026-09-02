"""Task 1.1 — the monorepo skeleton and the documentation deliverables exist and import cleanly."""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

import pytest

import weathra

# design.md decision 1's backend package layout.
EXPECTED_PACKAGES = {
    "weathra",
    "weathra.domain",
    "weathra.providers",
    "weathra.geocoding",
    "weathra.analytics",
    "weathra.weather",
    "weathra.mcp",
    "weathra.mcp.tools",
    "weathra.rag",
    "weathra.auth",
    "weathra.memory",
    "weathra.agents",
    "weathra.agents.llm",
    "weathra.agents.nodes",
    "weathra.api",
    "weathra.api.routers",
    "weathra.evaluation",
    "weathra.db",
}

# Every documentation deliverable named in task group 24.
EXPECTED_DOCS = {
    "architecture.md",
    "agents.md",
    "authentication.md",
    "configuration.md",
    "api.md",
    "mcp.md",
    "rag.md",
    "evaluation.md",
    "privacy-ethics.md",
    "deployment.md",
    "roadmap.md",
}


def _discovered_packages() -> set[str]:
    found = {"weathra"}
    for module in pkgutil.walk_packages(weathra.__path__, prefix="weathra."):
        if module.ispkg:
            found.add(module.name)
    return found


def test_every_designed_package_exists() -> None:
    assert _discovered_packages().issuperset(EXPECTED_PACKAGES)


@pytest.mark.parametrize("name", sorted(EXPECTED_PACKAGES))
def test_package_imports_cleanly(name: str) -> None:
    assert importlib.import_module(name) is not None


def test_every_module_imports_cleanly() -> None:
    """No module in the tree fails on import — including the ones nothing imports yet."""
    for module in pkgutil.walk_packages(weathra.__path__, prefix="weathra."):
        importlib.import_module(module.name)


def test_monorepo_directories_present(project_root: Path) -> None:
    for relative in ("backend", "frontend", "docs", "openspec"):
        assert (project_root / relative).is_dir(), f"missing {relative}/"


def test_the_project_lives_in_its_own_top_level_directory(
    project_root: Path, repo_root: Path
) -> None:
    """The applications sit under `weathra/`; only repository-level files sit above it."""
    assert project_root.name == "weathra"
    assert project_root.parent == repo_root


def test_the_ci_workflows_stay_at_the_repository_root(repo_root: Path) -> None:
    """GitHub Actions only discovers workflows in the repository's own `.github/workflows/`."""
    workflows = repo_root / ".github" / "workflows"
    assert workflows.is_dir(), "missing .github/workflows/"
    assert {path.name for path in workflows.glob("*.yml")} >= {"backend.yml", "frontend.yml"}


def test_the_repository_level_files_stay_at_the_repository_root(repo_root: Path) -> None:
    for name in ("README.md", "LICENSE", ".gitignore"):
        assert (repo_root / name).is_file(), f"missing {name}"


def test_documentation_placeholders_present(project_root: Path) -> None:
    docs = project_root / "docs"
    present = {path.name for path in docs.glob("*.md")}
    assert present.issuperset(EXPECTED_DOCS), f"missing docs: {sorted(EXPECTED_DOCS - present)}"
    assert (docs / "design").is_dir()


@pytest.mark.parametrize("name", sorted(EXPECTED_DOCS))
def test_documentation_placeholder_is_not_empty(project_root: Path, name: str) -> None:
    assert (project_root / "docs" / name).read_text().strip()
