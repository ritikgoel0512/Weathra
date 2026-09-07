"""Group 24 — the documentation describes the system that exists.

Prose about code rots quietly: a module is renamed, an endpoint is added, a metric is redefined, and
the document that described it keeps reading plausibly. These tests make the usual failure loud, by
asserting each document against the thing it documents.

They check *correspondence*, not wording. A missing endpoint, an undocumented setting, a module
listed under the wrong package, a metric the code no longer computes — those are caught. How well a
paragraph explains a decision is not something a test can judge, and pretending otherwise would
only produce assertions that fail on an improvement.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from weathra.config import Settings

# The `weathra/` project directory. Every path a document names is relative to it, because the
# documents sit inside it alongside the applications they describe. The README is the exception:
# it belongs to the repository, one level up.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PROJECT_ROOT.parent
DOCS = PROJECT_ROOT / "docs"
PACKAGE = PROJECT_ROOT / "backend" / "weathra"


def _read(name: str) -> str:
    path = DOCS / name if name != "README.md" else REPO_ROOT / "README.md"
    assert path.is_file(), f"{name} is missing"
    text = path.read_text()
    assert "> Placeholder" not in text, f"{name} is still a placeholder"
    return text


def _flat(text: str) -> str:
    """The document as one line, so a phrase check is not defeated by where a paragraph wrapped."""
    return re.sub(r"\s+", " ", text)


def _fenced_block(text: str, containing: str) -> str:
    """The fenced code block that contains a marker line."""
    blocks: list[str] = re.findall(r"```[a-z]*\n(.*?)```", text, re.DOTALL)
    for block in blocks:
        if containing in block:
            return block
    raise AssertionError(f"no fenced block contains {containing!r}")


# ---------------------------------------------------------------- 24.2 architecture and agents


def _documented_layout(block: str) -> tuple[set[str], set[str]]:
    """The module paths and package paths a layout block names.

    Indentation carries the nesting, exactly as a reader sees it: a line beginning with a
    ``name/`` token opens that package, and the file names that follow — on that line or on the
    more-indented lines beneath it — belong to it.
    """
    stack: list[tuple[int, str]] = []
    modules: set[str] = set()
    packages: set[str] = set()

    for raw in block.splitlines():
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip())
        stripped = raw.strip()
        first = stripped.split()[0]

        while stack and stack[-1][0] >= indent:
            stack.pop()

        remainder = stripped
        if first.endswith("/"):
            parent = stack[-1][1] if stack else ""
            path = f"{parent}{first}"
            stack.append((indent, path))
            packages.add(path)
            remainder = stripped[len(first) :]

        parent = stack[-1][1] if stack else ""
        for token in remainder.split():
            if token.endswith(".py"):
                modules.add(f"{parent}{token}")

    return modules, packages


@pytest.fixture(scope="module")
def architecture() -> str:
    return _read("architecture.md")


def test_every_documented_module_exists(architecture: str) -> None:
    modules, packages = _documented_layout(_fenced_block(architecture, "backend/weathra/"))

    assert len(modules) > 60, "the layout block parsed as almost nothing; check its formatting"
    for path in sorted(modules | packages):
        assert (PROJECT_ROOT / path).exists(), (
            f"docs/architecture.md names {path}, which does not exist"
        )


def test_every_subpackage_is_documented(architecture: str) -> None:
    """The other direction: a package added to the backend appears in the layout."""
    _, packages = _documented_layout(_fenced_block(architecture, "backend/weathra/"))
    documented = {path.rstrip("/").split("/")[-1] for path in packages}

    for directory in sorted(PACKAGE.iterdir()):
        if not directory.is_dir() or directory.name in {"__pycache__", "corpus", "dataset"}:
            continue
        assert directory.name in documented, (
            f"weathra/{directory.name}/ is not in the documented layout"
        )


def test_the_dependency_rule_names_every_layer(architecture: str) -> None:
    """The layer diagram and the enforced rule are the same rule."""
    from tests.test_architecture import LAYERS

    block = _fenced_block(architecture, "domain")
    for layer in LAYERS:
        assert layer in block, f"the documented dependency rule omits {layer}"


def test_the_agents_document_names_every_agent_and_capability() -> None:
    from weathra.agents.plan import Capability
    from weathra.domain.evidence import AgentName

    text = _read("agents.md")
    for capability in Capability:
        assert f"**{capability.value}**" in text, f"agents.md does not describe {capability.value}"
    for agent in AgentName:
        assert agent.value in text, f"agents.md does not mention the {agent.value} agent"


def test_the_agents_document_states_the_execution_decision() -> None:
    """Decision 2 is the one a reader most needs: the graph executes, the model proposes."""
    text = _read("agents.md")
    assert "graph executes tools" in text
    assert "never" in text and "calculat" in text


# ---------------------------------------------------------------- 24.3 authentication


@pytest.fixture(scope="module")
def authentication() -> str:
    return _read("authentication.md")


def _table_rows(text: str, header: str) -> list[list[str]]:
    """The rows of the markdown table whose header row contains *header*."""
    rows: list[list[str]] = []
    collecting = False
    for line in text.splitlines():
        if not line.startswith("|"):
            collecting = False
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if header in cells:
            collecting = True
            continue
        if collecting and set("".join(cells)) <= set("-: "):
            continue
        if collecting:
            rows.append(cells)
    return rows


def test_the_documented_table_classification_matches_the_models(authentication: str) -> None:
    from weathra.db.models import Base, ownership_of

    documented = {
        row[0].strip("`"): row[1].split(",")[0].strip()
        for row in _table_rows(authentication, "Class")
    }

    for name in Base.metadata.tables:
        assert name in documented, f"authentication.md does not classify {name}"
        expected = {"user": "user-owned", "shared": "shared", "operational": "operational"}[
            ownership_of(name).value
        ]
        assert documented[name] == expected, (
            f"authentication.md classifies {name} as {documented[name]}, the models say {expected}"
        )

    for name in documented:
        assert name in Base.metadata.tables, f"authentication.md classifies {name}, which is gone"


def _migration_tables(constant: str) -> tuple[str, ...]:
    """A table tuple read out of the RLS migration's source.

    Read rather than imported: a revision file is named `0002_row_level_security.py`, which is not
    an importable module name — Alembic loads it by path. The names are what matter here, and a
    regex over the source is honest about that.
    """
    source = (PACKAGE / "db" / "migrations" / "versions" / "0002_row_level_security.py").read_text()
    match = re.search(rf"{constant}[^=]*=\s*\(([^)]*)\)", source)
    assert match is not None, f"{constant} is not declared in the RLS migration"
    return tuple(re.findall(r'"([a-z_]+)"', match.group(1)))


def test_the_documented_classification_matches_the_migration(authentication: str) -> None:
    """The policies are applied by name; the document must name the same tables."""
    documented = {
        row[0].strip("`"): row[1].split(",")[0].strip()
        for row in _table_rows(authentication, "Class")
    }

    user_owned = _migration_tables("USER_OWNED_TABLES")
    shared = _migration_tables("SHARED_READ_ONLY_TABLES") + _migration_tables(
        "SHARED_APPEND_TABLES"
    )
    assert len(user_owned) >= 5 and len(shared) >= 3

    for name in user_owned:
        assert documented.get(name) == "user-owned", f"{name} carries an RLS policy"
    for name in shared:
        assert documented.get(name) == "shared", f"{name} is deliberately unrestricted"


def test_the_two_database_roles_are_documented(authentication: str) -> None:
    settings = Settings(supabase_url="https://project.supabase.co")

    assert settings.database_restricted_role in authentication
    assert "DATABASE_URL_PRIVILEGED" in authentication
    assert "NOBYPASSRLS" in authentication


def test_every_authentication_requirement_is_addressed(authentication: str) -> None:
    """Each requirement in `specs/authentication` has something in the document about it.

    The mapping is curated — a phrase per requirement — and the *list* is checked against the spec,
    so a requirement added to the spec fails here until somebody decides what the document should
    say about it. A test that tried to judge whether prose "addresses" a requirement would either
    pass on anything or fail on a rewording.
    """
    spec = (
        PROJECT_ROOT
        / "openspec"
        / "changes"
        / "weathra-mvp"
        / "specs"
        / "authentication"
        / "spec.md"
    ).read_text()
    requirements = re.findall(r"^### Requirement: (.+)$", spec, re.MULTILINE)
    assert len(requirements) >= 15

    expected: dict[str, str] = {
        "Supabase Auth is the identity system": "Supabase Auth owns credentials",
        "Account creation with email and password": "password rules are stated",
        "Mandatory email verification": "no session",
        "Verification code entry, resend, and states": "rate-limited",
        "Sign in and sign out": "non-disclosing",
        "Forgot password and password reset": "identical for a known and an unknown",
        "Session persistence and expiry": "expired-session state",
        "Backend validates every token": "JSON Web Key Set",
        "Application profile linked to the auth user": "keyed by the Supabase user id",
        "User-owned data is scoped to its owner": "ownership predicate",
        "Cross-user access is denied": "same not-found response",
        "Endpoint protection classification": "explicitly classified",
        "Authorization enforced in the backend, not the client": (
            "enforced in the backend, not the client"
        ),
        "Row Level Security on user-owned tables": "WITH CHECK",
        "Secret handling": "NEXT_PUBLIC_",
        "Authentication in streaming requests": "terminal authentication error",
        "Account and data deletion": "count removed per table",
        "Administrative and internal roles are server-held": "no client-supplied field grants it",
        "Plan and model entitlement are derived, never asserted": "derived, never asserted",
        "Row Level Security on the SaaS-ready tables": "SaaS-ready tables",
    }

    missing = set(requirements) - set(expected)
    assert not missing, (
        f"specs/authentication has requirements this test does not map: {sorted(missing)}. "
        "Decide what docs/authentication.md should say about them."
    )

    for requirement, phrase in expected.items():
        if requirement not in requirements:
            continue
        assert phrase in _flat(authentication), (
            f"docs/authentication.md says nothing recognisable about {requirement!r} "
            f"(looked for {phrase!r})"
        )


# ---------------------------------------------------------------- 24.4 configuration and API


def test_every_setting_is_documented_with_its_classification() -> None:
    """Every variable `Settings` reads appears in docs/configuration.md, classified."""
    text = _read("configuration.md")
    rows = {row[0].strip("`"): row for row in _table_rows(text, "Class")}

    for name, field in Settings.model_fields.items():
        variable = str(field.validation_alias or name).upper()
        assert variable in rows, f"docs/configuration.md does not document {variable}"
        classification = rows[variable][2] if len(rows[variable]) > 3 else rows[variable][1]
        assert classification, f"{variable} is documented without a classification"


def test_configuration_documents_nothing_the_code_does_not_read() -> None:
    text = _read("configuration.md")
    known = {
        str(field.validation_alias or name).upper() for name, field in Settings.model_fields.items()
    } | {"NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_API_BASE_URL"}

    for row in _table_rows(text, "Class"):
        variable = row[0].strip("`")
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", variable):
            continue
        assert variable in known, f"docs/configuration.md documents {variable}, which nothing reads"


def test_the_secrets_are_marked_secret() -> None:
    from tests.test_env_example import BACKEND_SECRETS

    rows = {row[0].strip("`"): row for row in _table_rows(_read("configuration.md"), "Class")}
    for secret in BACKEND_SECRETS:
        assert "secret" in rows[secret][2], f"{secret} is not documented as a secret"


def test_every_route_is_documented_with_its_access() -> None:
    """Every path the application serves appears in docs/api.md with its classification.

    Read from the committed OpenAPI snapshot rather than from a list here, so an endpoint added to
    the backend is undocumented until somebody documents it.
    """
    text = _read("api.md")
    schema = json.loads((PROJECT_ROOT / "backend" / "openapi.json").read_text())
    documented = {row[1].strip("`"): row for row in _table_rows(text, "Method")}

    for path, operations in schema["paths"].items():
        assert path in documented, f"docs/api.md does not document {path}"
        access = documented[path][2].strip("*")
        assert access in {"public", "protected"}, f"{path} is documented without an access class"

        methods = {method.upper() for method in operations}
        documented_methods = {
            row[0].strip("`") for row in _table_rows(text, "Method") if row[1].strip("`") == path
        }
        assert methods <= documented_methods, (
            f"docs/api.md documents {sorted(documented_methods)} for {path}, "
            f"the application serves {sorted(methods)}"
        )


def test_the_documented_access_matches_the_enforced_classification() -> None:
    from weathra.api.classification import classifications

    settings = Settings(supabase_url="https://project.supabase.co")
    prefix = settings.api_version_prefix
    documented = {
        row[1].strip("`"): row[2].strip("*") for row in _table_rows(_read("api.md"), "Method")
    }

    for classification in classifications():
        path = f"{prefix}{classification.path}"
        assert documented.get(path) == classification.access.value, (
            f"docs/api.md classifies {path} as {documented.get(path)!r}, "
            f"the application enforces {classification.access.value!r}"
        )


def test_every_stream_event_is_in_the_catalogue() -> None:
    from weathra.api.streaming import StreamEventType

    text = _read("api.md")
    for event in StreamEventType:
        assert f"`{event.value}`" in text, f"docs/api.md omits the {event.value} event"


def test_the_error_envelope_is_documented_as_it_is_returned() -> None:
    """The envelope's field names are the contract clients branch on."""
    from weathra.api.errors import ErrorBody

    text = _read("api.md")
    for field in ErrorBody.model_fields:
        assert f'"{field}"' in text, f"docs/api.md's error envelope omits {field}"


# ---------------------------------------------------------------- 24.5 MCP and RAG


def test_every_tool_is_documented_with_its_arguments() -> None:
    """Each tool the server can register appears with the arguments its schema declares."""
    from weathra.mcp import schemas

    text = _read("mcp.md")
    flat = _flat(text)

    models: dict[str, type[BaseModel]] = {
        "geocode_location": schemas.GeocodeInput,
        "weather_current": schemas.CurrentInput,
        "weather_forecast": schemas.ForecastInput,
        "weather_history": schemas.HistoryInput,
        "weather_compare": schemas.CompareInput,
        "weather_statistics": schemas.StatisticsInput,
        "weather_anomaly": schemas.AnomalyInput,
    }
    assert set(models) == set(schemas.TOOL_NAMES), (
        "this test's tool-to-schema map is out of step with TOOL_NAMES"
    )

    for tool, model in models.items():
        assert f"`{tool}`" in flat, f"docs/mcp.md does not document {tool}"
        for field, definition in model.model_fields.items():
            if definition.is_required():
                assert f"`{field}`" in flat, (
                    f"docs/mcp.md does not name {tool}'s required argument {field}"
                )


def test_every_tool_error_class_is_documented() -> None:
    from weathra.mcp.errors import ToolErrorClass

    flat = _flat(_read("mcp.md"))
    for error in ToolErrorClass:
        assert f"`{error.value}`" in flat, f"docs/mcp.md omits the {error.value} error class"


def test_the_documented_corpus_matches_the_files() -> None:
    """Every corpus document appears in docs/rag.md with its topic, and nothing invented does."""
    corpus = PACKAGE / "rag" / "corpus"
    documents = sorted(corpus.glob("*.md"))
    assert len(documents) >= 10

    text = _read("rag.md")
    rows = {row[0].strip("`"): row for row in _table_rows(text, "Document")}

    for path in documents:
        front = path.read_text()
        identifier = re.search(r"^id: (.+)$", front, re.MULTILINE)
        topic = re.search(r"^topic: (.+)$", front, re.MULTILINE)
        assert identifier is not None and topic is not None, f"{path.name} has no id or topic"

        name = identifier.group(1).strip()
        assert name in rows, f"docs/rag.md does not list the {name} document"
        assert rows[name][2] == topic.group(1).strip(), (
            f"docs/rag.md gives {name} the topic {rows[name][2]!r}"
        )

    assert set(rows) == {
        re.search(r"^id: (.+)$", path.read_text(), re.MULTILINE).group(1).strip()  # type: ignore[union-attr]
        for path in documents
    }, "docs/rag.md lists a document that is not in the corpus"


def test_the_re_index_requirement_is_documented() -> None:
    """The mismatch check is the reason a model change is not a configuration change."""
    flat = _flat(_read("rag.md"))
    assert "VectorIndexMismatch" in flat
    assert "re-ingest" in flat or "re-index" in flat
    assert "weathra-ingest-corpus" in flat


def test_the_relevance_threshold_is_documented_with_its_default() -> None:
    settings = Settings(supabase_url="https://project.supabase.co")
    flat = _flat(_read("rag.md"))

    assert "RAG_RELEVANCE_THRESHOLD" in flat
    assert str(settings.rag_relevance_threshold) in flat
    assert str(settings.embedding_dimension) in flat
    assert settings.embedding_model_id in flat


# ---------------------------------------------------------------- 24.6 evaluation


def test_every_metric_is_defined_in_the_document() -> None:
    from weathra.evaluation.metrics import MetricName

    flat = _flat(_read("evaluation.md"))
    for metric in MetricName:
        assert f"`{metric.value}`" in flat, f"docs/evaluation.md does not define {metric.value}"


def test_the_documented_thresholds_match_the_gates() -> None:
    """Every gate, with its number. A threshold documented loosely is a threshold nobody checks."""
    from weathra.evaluation.thresholds import NON_GATING_METRICS, THRESHOLDS

    flat = _flat(_read("evaluation.md"))

    for threshold in THRESHOLDS:
        bound = threshold.minimum if threshold.minimum is not None else threshold.maximum
        assert bound is not None
        rendered = f"{bound * 100:g}%"
        assert rendered in flat, (
            f"docs/evaluation.md does not state {threshold.metric.value}'s bound of {rendered}"
        )

    assert "Reported, not gating" in flat
    for metric in NON_GATING_METRICS:
        assert f"`{metric.value}`" in flat


def test_the_documented_dataset_composition_matches_the_dataset() -> None:
    from weathra.evaluation.cases import DATASET_VERSION, load_dataset

    cases = load_dataset()
    counts: dict[str, int] = {}
    for case in cases:
        counts[case.category.value] = counts.get(case.category.value, 0) + 1

    text = _read("evaluation.md")
    flat = _flat(text)
    assert f"`{DATASET_VERSION}`" in flat
    assert f"{len(cases)} cases" in flat

    rows = {row[0].strip("`"): row for row in _table_rows(text, "Category")}
    for category, count in counts.items():
        assert category in rows, f"docs/evaluation.md omits the {category} category"
        assert rows[category][1] == str(count), (
            f"docs/evaluation.md says {rows[category][1]} {category} cases, the dataset has {count}"
        )

    multi_turn = sum(1 for case in cases if len(case.turns) > 1)
    assert f"{multi_turn} of the {len(cases)} are multi-turn" in flat


def test_the_document_says_how_to_run_it_and_how_the_user_is_provisioned() -> None:
    flat = _flat(_read("evaluation.md"))

    assert "weathra-evaluate" in flat
    assert "DATABASE_URL" in flat
    assert "evaluation+" in flat, "the derived test-user email is not documented"
    assert "does not serialize" in flat, "the document must say the token is not recorded"


def test_the_recorded_results_cover_every_metric() -> None:
    """The recorded results are a table with a row per metric, not a sentence saying it passed."""
    from weathra.evaluation.metrics import MetricName

    rows = _table_rows(_read("evaluation.md"), "Result")
    assert len(rows) >= len(list(MetricName)), (
        "the recorded-results table does not have a row for every metric"
    )


# ---------------------------------------------------------------- 24.7 privacy and ethics


def test_every_safety_requirement_is_addressed() -> None:
    """Each requirement in `specs/safety-grounding` has something in the document about it.

    Curated phrases again, with the *list* checked against the spec — see the equivalent test for
    `specs/authentication` for why.
    """
    spec = (
        PROJECT_ROOT
        / "openspec"
        / "changes"
        / "weathra-mvp"
        / "specs"
        / "safety-grounding"
        / "spec.md"
    ).read_text()
    requirements = re.findall(r"^### Requirement: (.+)$", spec, re.MULTILINE)
    assert len(requirements) >= 10

    expected = {
        "No fabricated weather measurements": "Nothing is fabricated",
        "Numerical analytics are deterministic": "pure functions over normalized series",
        "Data classes are labelled and never conflated": "never mixed in one figure",
        "Source attribution on every weather answer": "assembled by code, never by a model",
        "Uncertainty is communicated": "confidence falls with distance",
        "Weathra does not present itself as a forecaster": "not a forecaster",
        "Not a replacement for official warnings": "official national meteorological service",
        "No unsupported severe-weather claims": "no measure Weathra currently normalizes",
        "Honest handling of unavailable data": "substitutes nothing",
        "Data minimization in persistence": "reference a person only by their authentication",
    }

    missing = set(requirements) - set(expected)
    assert not missing, (
        f"specs/safety-grounding has requirements this test does not map: {sorted(missing)}"
    )

    flat = _flat(_read("privacy-ethics.md"))
    for requirement, phrase in expected.items():
        if requirement not in requirements:
            continue
        assert phrase in flat, (
            f"docs/privacy-ethics.md says nothing recognisable about {requirement!r} "
            f"(looked for {phrase!r})"
        )


def test_every_data_class_is_documented() -> None:
    from weathra.domain.weather import DataClass

    flat = _flat(_read("privacy-ethics.md"))
    for data_class in DataClass:
        assert f"`{data_class.value}`" in flat, f"privacy-ethics.md omits {data_class.value}"


def test_the_retention_windows_are_documented_by_their_settings() -> None:
    flat = _flat(_read("privacy-ethics.md"))
    settings = Settings(supabase_url="https://project.supabase.co")

    assert "THREAD_RETENTION_DAYS" in flat
    assert f"({settings.thread_retention_days} by default)" in flat
    assert "SNAPSHOT_RETENTION_DAYS" in flat
    assert f"({settings.snapshot_retention_days} by default)" in flat


def test_every_persisted_table_is_accounted_for() -> None:
    """A table added to the schema is a category of data somebody has to justify keeping."""
    from weathra.db.models import Base

    flat = _flat(_read("privacy-ethics.md"))
    accounted = {
        "profiles": "profiles",
        "preferences": "Preferences",
        "saved_locations": "Saved locations",
        "threads": "Threads",
        "agent_runs": "agent_runs",
        "forecast_snapshots": "Forecast snapshots",
        "knowledge_documents": "Knowledge corpus",
        "knowledge_chunks": "Knowledge corpus",
        "evaluation_runs": "Evaluation records",
        "evaluation_case_results": "Evaluation records",
    }
    assert set(accounted) == set(Base.metadata.tables), (
        "a table was added or removed; docs/privacy-ethics.md must account for it"
    )
    for phrase in set(accounted.values()):
        assert phrase in flat, f"docs/privacy-ethics.md does not account for {phrase}"


def test_the_grounding_limits_are_stated_rather_than_implied() -> None:
    """The audit's refusal to accept unit conversions is a limit worth stating."""
    flat = _flat(_read("privacy-ethics.md"))
    assert "does not accept unit conversions" in flat
    assert "8.5" in flat and "47.3" in flat
    assert "qualitative" in flat


# ---------------------------------------------------------------- 24.8 deployment and roadmap


def test_the_roadmap_and_part_b_agree() -> None:
    """Every post-MVP item Part B records appears in the roadmap.

    Part B is the change's own record of what the architecture keeps room for. Two lists that
    disagree are worse than one: a reader cannot tell which is the plan.
    """
    tasks = (PROJECT_ROOT / "openspec" / "changes" / "weathra-mvp" / "tasks.md").read_text()
    part_b = tasks.split("# Part B")[1]
    items = re.findall(r"^- \*{0,2}(.+?)\*{0,2}(?: —|\.|$)", part_b, re.MULTILINE)
    assert len(items) >= 20, "Part B parsed as almost nothing; check its formatting"

    flat = _flat(_read("roadmap.md"))
    for item in items:
        # The roadmap may phrase an item more fully, so the distinctive words are what is checked.
        subject = re.sub(r"[^a-zA-Z ]", " ", item).split("(")[0]
        significant = [word for word in subject.split() if len(word) > 4][:3]
        if not significant:
            continue
        for word in significant:
            assert word.lower() in flat.lower(), (
                f"docs/roadmap.md does not mention {word!r} from Part B's {item!r}"
            )


def test_the_roadmap_names_the_post_mvp_screens() -> None:
    flat = _flat(_read("roadmap.md"))
    for screen in (
        "Weather Intelligence Report",
        "Forecast Explorer",
        "Weather Scenario Lab",
        "Weather Watch",
        "Travel Intelligence",
    ):
        assert screen in flat, f"docs/roadmap.md does not classify {screen}"
    assert "not implemented" in flat


def test_the_deployment_document_covers_the_topology_and_rollback() -> None:
    flat = _flat(_read("deployment.md"))

    for target in ("Vercel", "Render", "Supabase", "Open-Meteo", "OpenRouter", "GitHub"):
        assert target in flat, f"docs/deployment.md does not name {target}"

    assert "Rollback" in flat
    assert "alembic downgrade" in flat
    assert "before the new release serves traffic" in flat


WITHDRAWN_HOSTS = ("Cloudflare", "Cloud Run", "Google Cloud Secret Manager", "Artifact Registry")
"""Runtimes and secret stores that were chosen once and are no longer part of the architecture."""

SUPERSESSION_MARKERS = ("withdrawn", "superseded", "Superseded")
"""Words a paragraph must carry to be allowed to name a withdrawn host."""


def _paragraphs(text: str) -> list[str]:
    """Blank-line-delimited blocks, which is the unit a decision is recorded in."""
    return [block for block in re.split(r"\n\s*\n", text) if block.strip()]


def test_the_withdrawn_hosting_decision_is_not_reintroduced() -> None:
    """The selected runtimes are Vercel and Render, and drifting back must fail rather than pass.

    Cloudflare and Google Cloud Run were the earlier choice, with production secrets in Google Cloud
    Secret Manager behind a service-account IAM grant. Withdrawing a decision only sticks if
    something notices its return — a stale provider name reads perfectly plausibly, which is how the
    old one survived as long as it did.

    So a withdrawn name is allowed in exactly one circumstance: a paragraph that says it is gone.
    Recording *why* a choice was reversed is worth more than deleting the evidence it was ever made,
    and this is what keeps that record from being mistaken for an instruction. Everywhere else — any
    paragraph without a supersession marker, in any of these documents — is a failure.

    The unit is the paragraph rather than the file, so a supersession note somewhere in a long
    document cannot license a stale mention hundreds of lines away.
    """
    documents = {
        f"docs/{name}": _read(name) for name in ("deployment.md", "configuration.md", "agents.md")
    }
    change = PROJECT_ROOT / "openspec" / "changes" / "weathra-mvp"
    for name in ("tasks.md", "design.md", "proposal.md"):
        path = change / name
        assert path.is_file(), f"{path} is missing"
        documents[f"openspec/changes/weathra-mvp/{name}"] = path.read_text()

    offences: list[str] = []
    for where, text in documents.items():
        for paragraph in _paragraphs(text):
            flat = _flat(paragraph)
            if any(marker in flat for marker in SUPERSESSION_MARKERS):
                continue
            for term in WITHDRAWN_HOSTS:
                if term in flat:
                    offences.append(f"{where}: {term!r} in a paragraph that does not withdraw it")

    assert not offences, (
        "The selected runtimes are Vercel (frontend) and Render (backend). "
        "These mentions read as current architecture:\n  " + "\n  ".join(offences)
    )


def test_the_selected_runtimes_are_named_in_the_task_list() -> None:
    """The deployment tasks name what is actually being deployed to."""
    tasks = _flat((PROJECT_ROOT / "openspec" / "changes" / "weathra-mvp" / "tasks.md").read_text())

    assert "Render" in tasks, "no task names the backend runtime"
    assert "Vercel" in tasks, "no task names the frontend runtime"


def test_the_required_supabase_configuration_is_recorded() -> None:
    """Configuration the application depends on, recorded rather than left as console state."""
    flat = _flat(_read("deployment.md"))

    assert "{{ .Token }}" in flat, "the email templates' one-time token is not documented"
    assert "Redirect URLs" in flat
    assert "AGENT_WALL_CLOCK_BUDGET_SECONDS" in flat, (
        "the token-lifetime relationship to the agent budget is not documented"
    )
    assert "pgvector" in flat


def test_the_deployment_secrets_are_documented_where_they_live() -> None:
    from tests.test_env_example import BACKEND_SECRETS

    flat = _flat(_read("deployment.md"))
    for secret in BACKEND_SECRETS:
        assert secret in flat, f"docs/deployment.md does not say where {secret} lives"
