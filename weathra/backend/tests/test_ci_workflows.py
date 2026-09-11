"""Tasks 3.5 and 23.1 — the pull-request CI workflows.

A workflow file is configuration, not code, so what is checked here is the properties the tasks
actually require: a pgvector-capable service, a `pytest -m db` step pointed at it, migrations
applied under the *privileged* connection, the frontend's lint, type-check, tests and build, the
secret-exposure check running after that build, and no step that assumes a particular local
machine.

The two applications are built and deployed separately (design.md decision 1), so they have
separate workflows — a frontend-only change does not wait for a database to start, and a backend
change does not install npm. What must hold for *both* is asserted for both.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML is needed to parse the workflow files")


@pytest.fixture(scope="module")
def backend_workflow(repo_root: Path) -> dict[str, Any]:
    path = repo_root / ".github" / "workflows" / "backend.yml"
    assert path.is_file(), "the backend CI workflow is missing"
    loaded: dict[str, Any] = yaml.safe_load(path.read_text())
    return loaded


@pytest.fixture(scope="module")
def frontend_workflow(repo_root: Path) -> dict[str, Any]:
    path = repo_root / ".github" / "workflows" / "frontend.yml"
    assert path.is_file(), "the frontend CI workflow is missing"
    loaded: dict[str, Any] = yaml.safe_load(path.read_text())
    return loaded


def _steps(workflow: dict[str, Any], job: str) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = workflow["jobs"][job]["steps"]
    return steps


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    """The workflow's `on:` block.

    PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way — so the
    key is not the string one would expect. Named here once rather than explained at each use.
    """
    key: Any = True
    triggers: dict[str, Any] = workflow[key]
    return triggers


def _all_run_commands(workflow: dict[str, Any]) -> str:
    return "\n".join(
        step.get("run", "") for job in workflow["jobs"].values() for step in job["steps"]
    )


def test_a_postgres_service_with_pgvector_is_provided(backend_workflow: dict[str, Any]) -> None:
    services = backend_workflow["jobs"]["lint-and-test"]["services"]
    assert "postgres" in services
    assert "pgvector" in services["postgres"]["image"]


def test_the_service_is_health_checked_before_use(backend_workflow: dict[str, Any]) -> None:
    options = backend_workflow["jobs"]["lint-and-test"]["services"]["postgres"]["options"]
    assert "--health-cmd" in options
    assert "pg_isready" in options


def test_database_backed_tests_run_against_the_service(backend_workflow: dict[str, Any]) -> None:
    steps = _steps(backend_workflow, "lint-and-test")
    db_steps = [step for step in steps if "pytest -m db" in step.get("run", "")]
    assert db_steps, "no step runs the `db`-marked tests"
    for step in db_steps:
        url = step.get("env", {}).get("WEATHRA_TEST_DATABASE_URL", "")
        assert url.startswith("postgresql://"), "the db step is not pointed at the service"


def test_migrations_are_applied_under_the_privileged_connection(
    backend_workflow: dict[str, Any],
) -> None:
    """A migration under the restricted role would fail confusingly; decision 5 separates them."""
    steps = [
        step
        for step in _steps(backend_workflow, "lint-and-test")
        if "alembic" in step.get("run", "")
    ]
    assert steps
    for step in steps:
        env = step.get("env", {})
        assert env.get("WEATHRA_RUNTIME_MODE") == "privileged"
        assert env.get("DATABASE_URL_PRIVILEGED", "").startswith("postgresql://")


def test_the_offline_suite_runs_without_a_database(backend_workflow: dict[str, Any]) -> None:
    steps = _steps(backend_workflow, "lint-and-test")
    offline = [
        step
        for step in steps
        if step.get("run", "").strip() == "pytest"
        or step.get("name", "").lower().startswith("test (offline")
    ]
    assert offline, "no step runs the default, offline suite"
    for step in offline:
        assert "WEATHRA_TEST_DATABASE_URL" not in step.get("env", {})


def test_lint_and_type_check_run_in_ci(backend_workflow: dict[str, Any]) -> None:
    commands = _all_run_commands(backend_workflow)
    assert "ruff check" in commands
    assert "ruff format --check" in commands
    assert "mypy" in commands


def test_the_migrations_are_verified_to_downgrade(backend_workflow: dict[str, Any]) -> None:
    commands = _all_run_commands(backend_workflow)
    assert "alembic downgrade base" in commands


def test_no_inference_credential_is_configured_in_ci(backend_workflow: dict[str, Any]) -> None:
    """The suite must pass with no inference credential at all — that is the whole point."""
    rendered = yaml.safe_dump(backend_workflow)
    assert "OPENROUTER_API_KEY" not in rendered
    assert "SUPABASE_SERVICE_ROLE_KEY" not in rendered


def test_nothing_in_ci_depends_on_a_particular_local_machine(
    backend_workflow: dict[str, Any],
) -> None:
    """Constraint 5 of the design: every setup, test, and deploy path runs in a cloud environment."""
    for job in backend_workflow["jobs"].values():
        assert job["runs-on"].startswith("ubuntu-"), "CI must run on a hosted runner"
    commands = _all_run_commands(backend_workflow)
    for local_only in (
        "brew ",
        "apt-get install postgresql",
        "pg_ctl",
        "initdb",
        "localhost:55432",
    ):
        assert local_only not in commands


# --------------------------------------------------------------------------- the frontend workflow


def test_the_frontend_runs_lint_type_check_tests_and_build(
    frontend_workflow: dict[str, Any],
) -> None:
    commands = _all_run_commands(frontend_workflow)
    for required in ("npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build"):
        assert required in commands, f"the frontend workflow does not run `{required}`"


def test_the_frontend_installs_from_the_lockfile(frontend_workflow: dict[str, Any]) -> None:
    """`npm install` would let CI resolve a different tree than a developer has."""
    commands = _all_run_commands(frontend_workflow)
    assert "npm ci" in commands
    assert "npm install" not in commands


def test_the_secret_exposure_check_runs_after_the_build(
    frontend_workflow: dict[str, Any],
) -> None:
    """Task 18.11. Next.js inlines NEXT_PUBLIC_ values at build time, so the bundle is the only
    place that shows what a browser actually receives. Checking before the build would inspect a
    directory that does not exist yet — and pass."""
    steps = _steps(frontend_workflow, "lint-and-test")
    commands = [step.get("run", "").strip() for step in steps]

    assert "npm run check:secrets" in commands, "no step runs the secret-containment check"
    assert commands.index("npm run check:secrets") > commands.index("npm run build")


def test_the_frontend_workflow_holds_only_public_configuration(
    frontend_workflow: dict[str, Any],
) -> None:
    """The frontend's whole configuration is public by design (decision 19). A secret named here
    would be a secret in the repository, whatever the containment check said about the bundle."""
    rendered = yaml.safe_dump(frontend_workflow)
    for secret in (
        "SERVICE_ROLE",
        "DATABASE_URL",
        "OPENROUTER_API_KEY",
        "JWT_SECRET",
    ):
        assert secret not in rendered, f"the frontend workflow names {secret}"

    for name in frontend_workflow.get("env", {}):
        assert name.startswith("NEXT_PUBLIC_") or name in {
            "NODE_ENV",
            "NEXT_TELEMETRY_DISABLED",
        }, f"{name} is not public frontend configuration"


def test_each_workflow_only_runs_for_its_own_application(
    backend_workflow: dict[str, Any], frontend_workflow: dict[str, Any]
) -> None:
    """Separately built and deployed: a frontend change must not wait on a Postgres service.

    The paths are repository-relative, and the applications live under the `weathra/` project
    directory — a trigger left at the old top-level `backend/` would match nothing at all, so the
    prefix is asserted in full rather than by suffix.
    """
    backend_triggers = _triggers(backend_workflow)["pull_request"]["paths"]
    frontend_triggers = _triggers(frontend_workflow)["pull_request"]["paths"]

    assert any(path.startswith("weathra/backend/") for path in backend_triggers)
    assert not any(path.startswith("weathra/frontend/") for path in backend_triggers)
    assert any(path.startswith("weathra/frontend/") for path in frontend_triggers)
    assert not any(path.startswith("weathra/backend/") for path in frontend_triggers)


def test_the_workflow_guards_run_when_the_files_they_guard_change(
    backend_workflow: dict[str, Any],
) -> None:
    """The guards in this file describe `.github/`, so `.github/` has to trigger them.

    `test_each_workflow_only_runs_for_its_own_application` above is about the *applications*: a
    frontend change must not start a Postgres service. This is about the *guards*, and it is the
    gap that rule left open.

    Two tests in this suite assert properties of files outside `weathra/backend/` —
    `test_ci_workflows.py` says what `frontend.yml` must contain, and
    `test_frontend_release_environment.py` says how `.github/scripts/vercel_release_env.py` must
    fail closed. Both ran only when the backend changed. So editing `frontend.yml` ran
    `frontend.yml`, which does not hold the test that says what `frontend.yml` has to be: the file
    could be edited into violating its own contract, and the only thing that would have noticed was
    the next unrelated backend change.

    The frontend prefix stays out. What is added is the directory the guards actually describe.
    """
    for event in ("pull_request", "push"):
        paths = _triggers(backend_workflow)[event]["paths"]
        assert any(
            path.startswith(".github/workflows/") for path in paths
        ), f"a change to a workflow file does not run its own guard on {event}"
        assert any(
            path.startswith(".github/scripts/") for path in paths
        ), f"a change to a release script does not run its guard on {event}"


def test_both_workflows_run_on_pull_requests_and_on_main(
    backend_workflow: dict[str, Any], frontend_workflow: dict[str, Any]
) -> None:
    for workflow in (backend_workflow, frontend_workflow):
        triggers = _triggers(workflow)
        assert "pull_request" in triggers
        assert triggers["push"]["branches"] == ["main"]


def test_nothing_in_the_frontend_workflow_depends_on_a_particular_local_machine(
    frontend_workflow: dict[str, Any],
) -> None:
    for job in frontend_workflow["jobs"].values():
        assert job["runs-on"].startswith("ubuntu-")
    commands = _all_run_commands(frontend_workflow)
    for local_only in ("brew ", "nvm use", "~/", "/Users/", "C:\\"):
        assert local_only not in commands


def test_the_evaluation_gate_runs_on_every_pull_request(backend_workflow: dict[str, Any]) -> None:
    """Task 23.1 lists the offline evaluation run as part of the pull-request workflow, and it is a
    gate rather than a report: `weathra-evaluate` exits non-zero on a missed threshold."""
    commands = _all_run_commands(backend_workflow)
    assert "weathra-evaluate" in commands
