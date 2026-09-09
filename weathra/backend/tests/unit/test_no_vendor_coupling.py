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


# ============================================ 27.4 the vendor-identifier confinement rule


# Where a gateway model identifier is *allowed* to appear, and nowhere else (design.md decision 23,
# `specs/model-catalog`'s "vendor identifier confined"). Each is a place the string is genuinely the
# subject rather than a decision:
#
#   db/migrations/  the catalog seed. The catalog is data, and data is where the vendor string lives.
#   config.py       the LLM_MODEL default, already pinned to one field by the tests above.
#   .env.example    the same default, documented for a deployment.
#   the adapter     the outbound request body, which is the one place a model id is *sent*.
#
# Anywhere else it would be a decision made in code about a specific vendor's model, which is the
# coupling the catalog key exists to prevent.
CONFINED_TO = (
    PACKAGE_ROOT / "db" / "migrations",
    PACKAGE_ROOT / "config.py",
    BACKEND_ROOT / ".env.example",
    PACKAGE_ROOT / "agents" / "llm" / "openrouter.py",
)

PROJECT_ROOT = BACKEND_ROOT.parent
FRONTEND_ROOT = PROJECT_ROOT / "frontend"

# Frontend directories that are ours. `node_modules`, build output and Playwright artefacts are
# full of vendor names and none of it is Weathra's source.
FRONTEND_SOURCE_DIRECTORIES = ("app", "components", "hooks", "lib")


# Text files outside the backend package that would carry a model id into a decision: the seeded
# evaluation dataset (a case must not pin a vendor's model) and the frontend's own source.
def _confinement_candidates() -> list[Path]:
    found: list[Path] = []
    for path in PACKAGE_ROOT.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if path.suffix not in {".py", ".json", ".md", ".yaml", ".yml", ".txt"}:
            continue
        if any(path == allowed or allowed in path.parents for allowed in CONFINED_TO):
            continue
        found.append(path)
    for directory in FRONTEND_SOURCE_DIRECTORIES:
        for path in (FRONTEND_ROOT / directory).rglob("*"):
            if not path.is_file() or path.suffix not in {".ts", ".tsx", ".json", ".css"}:
                continue
            if _is_a_test_file(path):
                continue
            found.append(path)
    return sorted(found)


def _is_a_test_file(path: Path) -> bool:
    """Whether *path* is a test rather than shipped source.

    Excluded from the confinement scan, and the distinction is real rather than convenient. The
    rule forbids *selecting behaviour* by a vendor model name. A component test that passes
    ``model="somevendor/some-model"`` in and asserts the screen shows it back is doing the
    opposite: it proves the UI renders whatever the backend reported and decides nothing itself,
    which is exactly what `specs/web-ui` requires of the provenance display. Forbidding the string
    there would mean the only way to test pass-through is to not test it.

    Shipped frontend source is still scanned, and `test_no_shipped_frontend_source_is_excluded`
    keeps this exclusion from quietly widening.
    """
    return any(part in {"tests", "e2e", "__tests__"} for part in path.parts) or any(
        marker in path.name for marker in (".test.", ".spec.")
    )


def _model_identifiers_in_text(text: str) -> list[tuple[int, str]]:
    """Lines carrying something shaped like a gateway model identifier.

    Text rather than an AST walk, because this rule is about more than Python literals: a model id
    in a JSON evaluation case, a Markdown table, or a TypeScript user-facing string is the same
    coupling and none of them parse as Python.
    """
    hits: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for pattern in MODEL_PATTERNS:
            if pattern.search(line):
                hits.append((number, line.strip()[:120]))
                break
    return hits


def test_the_confinement_scan_covers_something() -> None:
    """A scan over an empty set passes vacuously, which is the failure mode of a scan."""
    candidates = _confinement_candidates()
    assert len(candidates) > 60, f"only {len(candidates)} files in the confinement scan"
    assert any(path.suffix == ".tsx" for path in candidates), "no frontend source was scanned"
    assert any(path.suffix == ".json" for path in candidates), "no evaluation data was scanned"
    assert any(
        path.parts[-2:] == ("routers", "agent.py") or path.name == "supervisor.py"
        for path in candidates
    ), "the agent and route source the rule is chiefly about was not scanned"


def test_no_shipped_frontend_source_is_excluded_as_a_test() -> None:
    """The exclusion above must cover tests and nothing else.

    A widened exclusion is how a confinement rule stops confining: exclude `components/` because
    one file was noisy, and the rule still passes while protecting nothing.
    """
    scanned = set(_confinement_candidates())
    for directory in FRONTEND_SOURCE_DIRECTORIES:
        for path in (FRONTEND_ROOT / directory).rglob("*"):
            if not path.is_file() or path.suffix not in {".ts", ".tsx"}:
                continue
            if _is_a_test_file(path):
                assert ".test." in path.name or ".spec." in path.name or "tests" in path.parts, (
                    f"{path} was excluded but does not look like a test"
                )
                continue
            assert path in scanned, f"shipped frontend source {path} escaped the scan"


def test_a_gateway_model_identifier_appears_only_where_it_is_confined() -> None:
    """Task 27.4. The identifier may live in catalog data, configuration, and the outbound request.

    Not in a policy record, a plan mapping, a quota rule, an agent, a node, a route, an evaluation
    case, or a user-facing string — because each of those would be behaviour selected by a vendor's
    model name, and the whole point of the catalog key is that behaviour never is.
    """
    offenders: dict[str, list[tuple[int, str]]] = {}
    for path in _confinement_candidates():
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:  # pragma: no cover - binary assets are not source
            continue
        if hits := _model_identifiers_in_text(content):
            offenders[str(path.relative_to(PROJECT_ROOT))] = hits

    assert not offenders, (
        "a gateway model identifier appears outside the places it is confined to "
        f"({[str(p.relative_to(PROJECT_ROOT)) for p in CONFINED_TO]}): {offenders}"
    )


def test_the_seeded_policy_and_plan_data_reference_catalog_keys_and_not_vendor_names() -> None:
    """The data half of the rule, read out of the seed migration itself.

    A policy's candidates and a plan's mapping are the two places where naming a vendor model would
    be most tempting and least visible — they are rows, so no code review would show a diff of them
    once seeded. The seed is the one place they are written down, so it is where this is checkable.
    """
    import importlib.util

    seed = PACKAGE_ROOT / "db" / "migrations" / "versions" / "0008_seed_model_policy_data.py"
    spec = importlib.util.spec_from_file_location("weathra_seed_confinement", seed)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    catalog_keys = {entry[0] for entry in module.CATALOG}
    for policy_id, _display, candidates, *_rest in module.POLICIES:
        for candidate in candidates:
            assert candidate in catalog_keys, f"{policy_id} names {candidate!r}, not a catalog key"
            assert not _model_identifiers_in_text(candidate), (
                f"{policy_id} names a vendor model identifier as a candidate: {candidate!r}"
            )
    for plan_code, _name, _rank, mapping in module.PLANS:
        for role, policy in mapping.items():
            assert not _model_identifiers_in_text(policy), (
                f"the {plan_code} plan maps {role} to something vendor-shaped: {policy!r}"
            )


# ---------------------------------------------------------------- the confinement detector itself

APPLICATION_LOGIC = '''
async def choose(client, question):
    """A node deciding for itself, which is the whole thing being prevented."""
    if "forecast" in question:
        return await client.complete(model="openai/gpt-5.1", messages=[])
    return await client.complete(model="anthropic/claude-haiku-4.5", messages=[])
'''

POLICY_RULE = """
CANDIDATES = {"high_reasoning": ["nvidia/nemotron-3-ultra-550b-a55b", "openai/gpt-oss-120b"]}
"""

UI_STRING = """
export const ModelBadge = () => <span>Answered by GPT-5.1 Turbo</span>;
"""

EVALUATION_CASE = """
{"case_id": "forecast-berlin", "pinned_model": "deepseek/deepseek-v4-flash-latest"}
"""


@pytest.mark.parametrize(
    ("label", "source"),
    [
        ("application logic", APPLICATION_LOGIC),
        ("a policy rule", POLICY_RULE),
        ("a UI string", UI_STRING),
        ("an evaluation case", EVALUATION_CASE),
    ],
)
def test_the_confinement_detector_catches_a_model_name_being_introduced(
    label: str, source: str
) -> None:
    """Task 27.4's own verification: the test fails when a model name reaches somewhere it may not.

    Four shapes, because the rule names four kinds of place and a detector that only understood
    Python would silently permit the other three.
    """
    assert _model_identifiers_in_text(source), f"the detector missed a model name in {label}"
