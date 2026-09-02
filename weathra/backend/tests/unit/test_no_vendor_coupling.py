"""Task 13.6 — the backend imports no model-vendor SDK and names no model.

``specs/agent-orchestration``: "No agent, supervisor, or graph node SHALL import or reference a
specific model vendor's SDK or a specific model name." This test enforces it across the *whole*
backend rather than only those three, because the rule is easier to keep than to restore and the
place it would first be broken is a helper nobody thought of as an agent.

**The one exception, and why it is not a loophole.** ``weathra/config.py`` holds a default for
``LLM_MODEL``, because the same spec calls the model "environment configuration" and a service that
cannot start without every variable set is not configurable, it is merely demanding. The exception
is narrow and checked: the default must be a ``Field`` default in ``config.py`` and nowhere else.
An agent node that named the same model would still fail.

**The detector is tested too.** A test that scans for a pattern is worth exactly as much as the
pattern, so ``test_the_detector_catches_a_hard_coded_model`` runs it over source that *does* hard-
code a model and asserts it is caught. Without that, a typo in a regex would turn this file into a
green light that checks nothing.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = BACKEND_ROOT / "weathra"

# Where a model identifier is legitimately allowed to appear, and only as a configuration default.
CONFIGURATION_FILE = PACKAGE_ROOT / "config.py"

# Vendor SDKs. Weathra talks to a gateway over one POST (design.md decision 3), so any of these
# appearing is a coupling that the abstraction exists to avoid. ``anthropic`` is on the list on
# purpose: Claude Code is a development tool and must not become a runtime dependency.
BANNED_MODULES = frozenset(
    {
        "anthropic",
        "cohere",
        "google.ai",
        "google.generativeai",
        "google.genai",
        "groq",
        "huggingface_hub",
        "langchain_anthropic",
        "langchain_google_genai",
        "langchain_openai",
        "litellm",
        "llama_cpp",
        "mistralai",
        "ollama",
        "openai",
        "replicate",
        "sentence_transformers",
        "together",
        "transformers",
        "vertexai",
    }
)

# Shapes a specific model identifier takes. Deliberately about *vendor* model names: Weathra's own
# local embedder id ("weathra-hashing-v1") is not a third-party model and is not what the spec is
# about.
MODEL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgpt-[0-9]", re.IGNORECASE),
    re.compile(r"\bo[13]-(mini|preview)\b", re.IGNORECASE),
    re.compile(r"\bclaude-[0-9a-z]", re.IGNORECASE),
    re.compile(r"\bgemini-[0-9a-z]", re.IGNORECASE),
    re.compile(r"\bllama-?[0-9]", re.IGNORECASE),
    re.compile(r"\bmistral(-|\b)", re.IGNORECASE),
    re.compile(r"\bmixtral\b", re.IGNORECASE),
    re.compile(r"\bnemotron\b", re.IGNORECASE),
    re.compile(r"\bdeepseek\b", re.IGNORECASE),
    re.compile(r"\bqwen\b", re.IGNORECASE),
    re.compile(r"\bgrok-[0-9]", re.IGNORECASE),
    # A gateway model id: "vendor/model" or "vendor/model:free".
    re.compile(r"\b[a-z0-9-]+/[a-z0-9._-]+:free\b", re.IGNORECASE),
)


def _python_files() -> list[Path]:
    return sorted(
        path
        for path in PACKAGE_ROOT.rglob("*.py")
        if "__pycache__" not in path.parts and "migrations" not in path.parts
    )


def _imported_modules(tree: ast.AST) -> set[str]:
    """Every module a file imports, by dotted name."""
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


def _banned_import(module: str) -> str | None:
    """The banned module a dotted import belongs to, if any."""
    parts = module.split(".")
    for depth in range(1, len(parts) + 1):
        candidate = ".".join(parts[:depth])
        if candidate in BANNED_MODULES:
            return candidate
    return None


def _model_literals(tree: ast.AST) -> list[tuple[int, str, str]]:
    """String literals that look like a specific model identifier, with the pattern that matched."""
    found: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        for pattern in MODEL_PATTERNS:
            if pattern.search(node.value):
                found.append((node.lineno, node.value, pattern.pattern))
                break
    return found


# =========================================================================== the rules


def test_there_is_something_to_scan() -> None:
    """A scanner that found no files would pass every other test in this module."""
    files = _python_files()
    assert len(files) > 40, f"only {len(files)} files found under {PACKAGE_ROOT}"
    assert PACKAGE_ROOT / "agents" / "llm" / "openrouter.py" in files


@pytest.mark.parametrize("path", _python_files(), ids=lambda path: str(path.name))
def test_no_backend_file_imports_a_model_vendor_sdk(path: Path) -> None:
    tree = ast.parse(path.read_text(), filename=str(path))
    offending = {
        module: banned
        for module in _imported_modules(tree)
        if (banned := _banned_import(module)) is not None
    }
    assert not offending, (
        f"{path.relative_to(BACKEND_ROOT)} imports a model vendor SDK: {offending}. Weathra talks "
        "to a gateway over one POST; a vendor SDK is the coupling the abstraction exists to avoid."
    )


@pytest.mark.parametrize("path", _python_files(), ids=lambda path: str(path.name))
def test_no_backend_file_hard_codes_a_model_identifier(path: Path) -> None:
    literals = _model_literals(ast.parse(path.read_text(), filename=str(path)))
    if path == CONFIGURATION_FILE:
        pytest.skip("config.py holds the documented LLM_MODEL default; checked separately below")
    assert not literals, (
        f"{path.relative_to(BACKEND_ROOT)} names a specific model: "
        f"{[(line, value) for line, value, _ in literals]}. The model is configuration "
        "(LLM_MODEL), so naming one here would make changing it a code change."
    )


def test_the_configured_default_lives_only_in_the_settings_field() -> None:
    """The one exception, pinned to one field so it cannot spread.

    A model id in ``config.py`` is a default for an environment variable. A model id anywhere else
    in ``config.py`` — a hard-coded branch, a lookup table — would be architecture pretending to be
    configuration, so the exception is checked rather than assumed.
    """
    tree = ast.parse(CONFIGURATION_FILE.read_text(), filename=str(CONFIGURATION_FILE))
    literals = _model_literals(tree)
    assert len(literals) == 1, f"expected exactly one model literal in config.py, found {literals}"

    line, value, _ = literals[0]
    source = CONFIGURATION_FILE.read_text().splitlines()[line - 1]
    assert value in source
    # The line before it declares the field it defaults.
    assert "llm_model" in "\n".join(CONFIGURATION_FILE.read_text().splitlines()[line - 3 : line])


def test_the_openrouter_client_names_no_model() -> None:
    """Named explicitly, because it is the file where a model id would look most at home."""
    client = PACKAGE_ROOT / "agents" / "llm" / "openrouter.py"
    assert not _model_literals(ast.parse(client.read_text(), filename=str(client)))


def test_the_runtime_dependencies_declare_no_vendor_sdk() -> None:
    """Not importable is good; not installable is better.

    A vendor SDK in the dependency list is one ``import`` away from being a coupling, and would
    also put a vendor's release cadence on Weathra's critical path.
    """
    manifest = (BACKEND_ROOT / "pyproject.toml").read_text()
    runtime = manifest.split("[project.optional-dependencies]")[0]
    for module in sorted(BANNED_MODULES):
        distribution = module.replace("_", "-")
        assert f'"{distribution}' not in runtime, f"{distribution} is a runtime dependency"


# =========================================================================== the detector itself


HARD_CODED = '''
from weathra.agents.llm.base import Message

SYSTEM = "You are a weather assistant."


async def route(client):
    """A node that decided to pick its own model."""
    return await client.complete(
        system=SYSTEM, messages=[Message.user("Berlin?")], model="anthropic/claude-3-opus"
    )
'''

VENDOR_IMPORT = """
import anthropic


def build():
    return anthropic.AsyncAnthropic()
"""


def test_the_detector_catches_a_hard_coded_model() -> None:
    """The test that makes the two tests above worth running.

    A scan is worth exactly as much as its pattern. This runs the same detector over source that
    does hard-code a model and asserts it is caught — so a typo in a regex fails here rather than
    silently turning this whole module green.
    """
    literals = _model_literals(ast.parse(HARD_CODED))
    assert literals, "the detector missed a hard-coded model identifier"
    assert literals[0][1] == "anthropic/claude-3-opus"


def test_the_detector_catches_a_vendor_sdk_import() -> None:
    modules = _imported_modules(ast.parse(VENDOR_IMPORT))
    assert _banned_import("anthropic") == "anthropic"
    assert any(_banned_import(module) for module in modules)


def test_the_detector_catches_a_submodule_import_of_a_banned_package() -> None:
    """``from openai.types import ...`` is the same coupling by a longer name."""
    assert _banned_import("openai.types.chat") == "openai"
    assert _banned_import("google.generativeai.types") == "google.generativeai"


@pytest.mark.parametrize(
    "name",
    [
        "gpt-4o-mini",
        "claude-3-5-sonnet",
        "gemini-1.5-pro",
        "meta-llama/llama-3.1-8b-instruct:free",
        "mistralai/mistral-7b",
        "nvidia/nemotron-nano-9b-v2:free",
        "deepseek/deepseek-chat",
        "qwen/qwen-2-7b",
    ],
)
def test_the_detector_recognises_real_model_identifiers(name: str) -> None:
    assert _model_literals(ast.parse(f"MODEL = {name!r}")), f"{name} was not recognised"


@pytest.mark.parametrize(
    "text",
    [
        "weathra-hashing-v1",
        "open-meteo",
        "https://openrouter.ai/api/v1",
        "postgresql+asyncpg://localhost/weathra",
        "Europe/Berlin",
        "historical_observation",
        "the model interprets but never calculates",
    ],
)
def test_the_detector_does_not_flag_ordinary_strings(text: str) -> None:
    """A detector that flagged "Europe/Berlin" would be turned off within a week."""
    assert not _model_literals(ast.parse(f"VALUE = {text!r}")), f"{text} was flagged"
