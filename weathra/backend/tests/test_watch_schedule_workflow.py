"""The scheduled watch pass, and the four properties that make it safe to run unattended.

Weather Watch tells a person when their watches will next be checked. That sentence is only true if
something keeps the cadence it names, and the thing that keeps it is a cron entry in a YAML file
that no other test reads. So the first assertion here is the one that would otherwise rot silently:
**the schedule the product states and the schedule CI runs are the same schedule.**

The other three are the boundary. The job holds the privileged connection — it must, because
evaluating other people's watches is exactly what the request-serving role cannot do — so
everything it does *not* need is asserted absent rather than merely unused, the same way
`test_release_workflow.py` treats retention.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from weathra.config import Settings

yaml = pytest.importorskip("yaml", reason="PyYAML is needed to parse the workflow files")

WORKFLOW = ".github/workflows/weather-watch.yml"
JOB = "evaluate"


@pytest.fixture(scope="module")
def workflow(repo_root: Path) -> dict[Any, Any]:
    path = repo_root / WORKFLOW
    assert path.is_file(), f"{WORKFLOW} is missing: nothing evaluates watches on a schedule"
    parsed: dict[Any, Any] = yaml.safe_load(path.read_text())
    return parsed


@pytest.fixture(scope="module")
def workflow_text(repo_root: Path) -> str:
    return (repo_root / WORKFLOW).read_text()


@pytest.fixture(scope="module")
def workflow_steps(repo_root: Path) -> str:
    """The file with its comment lines removed.

    The absence assertions below would otherwise match this workflow's own documentation, which
    names each forbidden capability in order to say it is absent. A comment cannot deploy anything.
    """
    return "\n".join(
        line
        for line in (repo_root / WORKFLOW).read_text().splitlines()
        if not line.lstrip().startswith("#")
    )


def test_the_stated_cadence_is_the_cadence_that_runs(workflow: dict[Any, Any]) -> None:
    """The screen says "next checked in 40 minutes". This is what makes that sentence true.

    `Settings.watch_cadence_minutes` reaches the browser in the dashboard's `cadence_minutes` and is
    what every "next evaluation" figure on the screen is derived from. If somebody slows the cron
    entry to every six hours and leaves the setting at sixty, nothing fails, nothing looks wrong,
    and the product quietly starts telling everybody a time that will not happen.
    """
    # PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way.
    crons = [entry["cron"] for entry in workflow[True]["schedule"]]
    assert crons, f"{WORKFLOW} declares no cron schedule"

    minutes, hours, *_ = crons[0].split()
    assert hours == "*", (
        f"{WORKFLOW} does not run every hour, so the product's stated cadence is not kept"
    )
    assert minutes.isdigit(), (
        f"{WORKFLOW} runs more than once an hour ({minutes!r}); a watch is a threshold on an "
        "hourly series, so a second pass in the same hour re-reads the same hour"
    )
    # The declared default, not a constructed `Settings`: this asserts about what the code ships,
    # which is what a deployment that sets nothing will run and what the screen will then state.
    declared = Settings.model_fields["watch_cadence_minutes"].default
    assert declared == 60, (
        f"watch_cadence_minutes ({declared}) and the hourly cron entry have diverged. The setting "
        "is what the screen tells people; the cron is what happens. Change both or neither."
    )


def test_a_commit_cannot_start_a_pass(workflow: dict[Any, Any]) -> None:
    """A contributor's push must not start a job holding the privileged connection."""
    triggers = set(workflow[True])
    assert triggers == {"schedule", "workflow_dispatch"}, (
        f"{WORKFLOW} has triggers beyond schedule and workflow_dispatch: "
        f"{sorted(triggers - {'schedule', 'workflow_dispatch'})}"
    )


def test_the_pass_is_bounded_and_never_cancelled_midway(workflow: dict[Any, Any]) -> None:
    """It runs every hour, so a hang would stack; and half a pass is worse than a late one."""
    assert workflow["concurrency"]["cancel-in-progress"] is False, (
        f"{WORKFLOW} cancels a running pass, which leaves some watches evaluated and some not"
    )
    assert workflow["jobs"][JOB].get("timeout-minutes"), (
        f"{WORKFLOW} is unbounded; an hourly unattended job that hangs holds the privileged "
        "connection until somebody notices"
    )


def test_the_unattended_pass_evaluates_rather_than_plans(
    workflow: dict[Any, Any], workflow_text: str
) -> None:
    """A scheduled run supplies no inputs, so the fallback is what actually runs every hour."""
    mode = workflow[True]["workflow_dispatch"]["inputs"]["mode"]
    assert mode["type"] == "choice", f"{WORKFLOW} takes its mode as something other than a choice"
    assert mode["default"] == "evaluate", (
        f"{WORKFLOW} defaults to something other than the real pass, so an untouched dispatch "
        "would not do what the schedule does"
    )
    assert set(mode["options"]) == {"evaluate", "plan-only"}

    step = next(
        step
        for step in workflow["jobs"][JOB]["steps"]
        if "weathra-watch-evaluate" in str(step.get("run", ""))
    )
    assert "inputs.mode || 'evaluate'" in str(step.get("env", {}).get("MODE", "")), (
        f"{WORKFLOW} does not fall back to the real pass when no input is supplied, which is "
        "every scheduled run"
    )
    assert 'echo "mode: ' in str(step["run"]), (
        f"{WORKFLOW} does not say which mode it ran in, so a log cannot be read back"
    )
    assert "verify_database.py" in workflow_text, (
        f"{WORKFLOW} writes rows about everybody's watches without first checking that the schema "
        "is the one this code expects"
    )


def test_the_pass_holds_nothing_it_does_not_need(workflow_steps: str) -> None:
    """It holds the privileged connection, so every capability beyond that is absent by assertion.

    Each of these has a reason rather than being a general tidiness rule. Alembic would let an
    hourly unattended job migrate production. A Render credential would let it deploy. The
    service-role key bypasses every policy and belongs to one CI job that provisions evaluation
    users. `DATABASE_URL` unqualified is the *request path's* connection, and a job that held both
    would blur the boundary the whole design rests on.
    """
    for forbidden, why in (
        ("alembic", "could migrate production from an unattended hourly job"),
        ("api.render.com", "could deploy"),
        ("RENDER_", "holds a Render credential"),
        ("SERVICE_ROLE", "holds the key that bypasses every policy"),
        ("VERCEL", "holds a frontend release credential"),
    ):
        assert forbidden.lower() not in workflow_steps.lower(), f"{WORKFLOW} {why}"

    assert "secrets.DATABASE_URL }}" not in workflow_steps, (
        f"{WORKFLOW} holds the request path's connection as well as the privileged one"
    )
