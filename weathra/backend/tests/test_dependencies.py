"""Task 1.3 — no model-vendor SDK is a backend dependency, and none is importable from the tree.

`anthropic` is deliberately absent: Claude Code is a development tool for building Weathra, not
Weathra's runtime inference provider. Every model is reached through `agents/llm/`'s Protocol over
the OpenRouter gateway (design.md decision 3), so a vendor SDK would be a coupling the specs forbid.
"""

from __future__ import annotations

import tomllib
from importlib.metadata import distributions
from pathlib import Path

import pytest

# Distribution names that would couple the runtime to one model vendor.
FORBIDDEN_DISTRIBUTIONS = frozenset(
    {
        "anthropic",
        "openai",
        "google-generativeai",
        "google-genai",
        "google-cloud-aiplatform",
        "vertexai",
        "cohere",
        "mistralai",
        "groq",
        "together",
        "replicate",
        "boto3",  # would carry Bedrock
        "ollama",
        "llama-cpp-python",
        "transformers",
        "langchain-anthropic",
        "langchain-openai",
        "langchain-google-genai",
        "langchain-cohere",
        "langchain-mistralai",
        "langchain-aws",
    }
)

# Top-level import names for the same SDKs.
FORBIDDEN_IMPORTS = frozenset(
    {
        "anthropic",
        "openai",
        "cohere",
        "mistralai",
        "groq",
        "together",
        "replicate",
        "boto3",
        "ollama",
        "vertexai",
        "langchain_anthropic",
        "langchain_openai",
        "langchain_google_genai",
        "langchain_cohere",
        "langchain_mistralai",
        "langchain_aws",
    }
)


def _normalize(name: str) -> str:
    return name.lower().replace("_", "-")


def _declared_dependencies(backend_root: Path) -> set[str]:
    manifest = tomllib.loads((backend_root / "pyproject.toml").read_text())
    project = manifest["project"]
    declared: list[str] = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        declared.extend(extra)
    names = set()
    for requirement in declared:
        # "name[extra1,extra2]>=1.2" -> "name"
        head = requirement.split(";")[0].strip()
        for separator in ("[", ">", "<", "=", "!", "~", " "):
            head = head.split(separator)[0]
        names.add(_normalize(head))
    return names


def test_no_vendor_sdk_is_declared(backend_root: Path) -> None:
    offenders = _declared_dependencies(backend_root) & FORBIDDEN_DISTRIBUTIONS
    assert not offenders, f"model-vendor SDKs declared as dependencies: {sorted(offenders)}"


def test_anthropic_is_not_declared(backend_root: Path) -> None:
    assert "anthropic" not in _declared_dependencies(backend_root)


def test_no_vendor_sdk_is_installed() -> None:
    """The resolved dependency tree — not only the direct declarations — carries no vendor SDK."""
    installed = {
        _normalize(dist.metadata["Name"]) for dist in distributions() if dist.metadata["Name"]
    }
    offenders = installed & FORBIDDEN_DISTRIBUTIONS
    assert not offenders, f"model-vendor SDKs present in the environment: {sorted(offenders)}"


@pytest.mark.parametrize("module", sorted(FORBIDDEN_IMPORTS))
def test_vendor_sdk_is_not_importable(module: str) -> None:
    import importlib.util

    assert importlib.util.find_spec(module) is None, f"{module} is importable in the backend env"
