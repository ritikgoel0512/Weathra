"""Task 23.4 — the release pipeline, and the one property it exists to guarantee.

Task 23.4 requires Alembic migrations "applied under the privileged connection **before the new
backend release serves traffic**". That is an ordering claim, and ordering is the thing that
regresses silently: every individual job keeps working, the pipeline stays green, and the only
symptom is a container answering requests against a database that has not been migrated yet —
intermittently, because it depends on whether a container build happens to be slower than a
migration.

So the ordering is asserted structurally, from the parsed job graph, rather than by reading the
file. Three independent ways it could break, and a test for each:

1. **The job graph is flattened.** `deploy` stops depending on `migrate`, or the steps are merged
   into one job where a failure could be swallowed.
2. **Render deploys on its own.** `render.yaml` goes back to deploying on every push, and `main`
   moving releases the service regardless of what CI is doing. This is the default behaviour, so
   it is one careless edit away.
3. **The deploy stops naming a commit.** Without `commitId` Render deploys the branch tip, which
   may be a later commit whose migrations have not run.

The rest covers the privileged boundary: the migration job holds the privileged connection and
nothing else, and no job can print a credential.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML is needed to parse the workflow files")

RELEASE = ".github/workflows/release.yml"

# The workflows that run for ordinary contribution: a pull request, or a push to main. These hold
# no production credential at all — a fork's CI must work, and a contributor must never need one.
# The release pipelines are deliberately not in this set; they are the only workflows that may read
# a repository secret.
ORDINARY_CI = ("backend.yml", "frontend.yml")

# The workflows that release, and the only ones that may read a repository secret. `release.yml`
# releases the backend on Render; `frontend-release.yml` (task 23.5) releases the frontend on
# Vercel. They are separate because they share no ordering constraint and no path filter — see the
# header of `frontend-release.yml` — and because the frontend's credential reaches one Vercel
# project and nothing else. `test_the_frontend_release_holds_nothing_of_the_backend_s` is what
# keeps that second statement true.
FRONTEND_RELEASE = ".github/workflows/frontend-release.yml"
VERCEL_PROJECT = "weathra/frontend/vercel.json"
RELEASE_PIPELINES = ("release.yml", "frontend-release.yml")

# Neither ordinary CI nor the release pipeline, and recorded here because
# `test_only_the_release_pipeline_reads_a_repository_secret` requires every workflow to sit on
# one side of that boundary or be classified deliberately.
#
# `db-identity.yml` reads DATABASE_URL_PRIVILEGED — so it is not ordinary CI — and it cannot
# deploy, migrate, or write: hand-dispatched only, no Render credential in scope, no Alembic
# command, and a read-only PostgreSQL session. It exists to report which role the privileged DSN
# authenticates as on a GitHub-hosted runner, which is the one fact the migrate job's
# `permission denied for table alembic_version` does not tell us. Temporary: delete the workflow
# and this entry once that is known.
DIAGNOSTIC = ("db-identity.yml",)


@pytest.fixture(scope="module")
def release(repo_root: Path) -> dict[str, Any]:
    path = repo_root / RELEASE
    assert path.is_file(), f"{RELEASE} is missing: there is no release pipeline"
    loaded: dict[str, Any] = yaml.safe_load(path.read_text())
    return loaded


@pytest.fixture(scope="module")
def release_text(repo_root: Path) -> str:
    return (repo_root / RELEASE).read_text()


@pytest.fixture(scope="module")
def blueprint(repo_root: Path) -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load((repo_root / "render.yaml").read_text())
    return loaded


def _job(release: dict[str, Any], name: str) -> dict[str, Any]:
    jobs = release.get("jobs") or {}
    assert name in jobs, f"{RELEASE} declares no {name!r} job"
    found: dict[str, Any] = jobs[name]
    return found


def _needs(job: dict[str, Any]) -> set[str]:
    declared = job.get("needs")
    if declared is None:
        return set()
    if isinstance(declared, str):
        return {declared}
    return set(declared)


def _steps_text(job: dict[str, Any]) -> str:
    """Every `run:` body in a job, as one string."""
    return "\n".join(str(step.get("run", "")) for step in job.get("steps", []))


def _job_env_text(job: dict[str, Any]) -> str:
    """The job's `env:` block plus every step-level `env:`, rendered."""
    blocks = [job.get("env") or {}]
    blocks.extend(step.get("env") or {} for step in job.get("steps", []))
    rendered: str = yaml.safe_dump(blocks)
    return rendered


# ------------------------------------------------------------------ 1. the ordering


def test_the_release_pipeline_orders_migrate_before_deploy(release: dict[str, Any]) -> None:
    """The load-bearing assertion. `deploy` may only run after `migrate` has succeeded.

    GitHub Actions runs a job whose `needs:` are unmet never, and a job whose `needs:` failed never
    — so this single edge is what makes "migrations applied before the new release serves traffic"
    a property of the system rather than of timing.
    """
    assert "migrate" in _needs(_job(release, "deploy")), (
        "the deploy job does not depend on the migration job: a release could reach production "
        "before its migrations had been applied"
    )


def test_readiness_verification_runs_only_after_a_successful_deploy(
    release: dict[str, Any],
) -> None:
    """Verifying the previous release would be worse than not verifying at all."""
    assert "deploy" in _needs(_job(release, "verify")), (
        "the verify job does not depend on the deploy job, so it would probe whichever release "
        "happened to be serving"
    )


def test_the_ordering_is_a_chain_with_no_shortcut(release: dict[str, Any]) -> None:
    """Migrate, deploy and verify are separate jobs, and each waits for the last.

    Collapsing any two into one job would put the ordering back in the hands of step order inside a
    single runner, where a `continue-on-error`, an `if: always()`, or a backgrounded command could
    let a later step run after an earlier one failed. Separate jobs cannot do that.
    """
    jobs = release.get("jobs") or {}
    for name in ("image", "migrate", "deploy", "verify"):
        assert name in jobs, f"{RELEASE} no longer declares a separate {name!r} job"

    assert "image" in _needs(_job(release, "migrate")), (
        "the migration job does not wait for the image to build, so the database could be migrated "
        "for a release that cannot start"
    )

    # A job that always runs is a job that runs after its dependency failed.
    for name in ("migrate", "deploy", "verify"):
        condition = str(_job(release, name).get("if", ""))
        assert "always()" not in condition, f"the {name} job runs even when its dependency failed"


def test_a_release_is_never_cancelled_half_way(release: dict[str, Any]) -> None:
    """Cancelling between migrate and deploy leaves a migrated database under the old release."""
    concurrency = release.get("concurrency") or {}
    assert concurrency.get("cancel-in-progress") is False, (
        "the release pipeline cancels in-progress runs; a release interrupted between the "
        "migration and the deploy would leave the database ahead of the running code"
    )


def test_render_does_not_deploy_on_its_own(blueprint: dict[str, Any]) -> None:
    """The other half of the ordering, and the half that lives outside the workflow.

    Render's default is to deploy on every push to the tracked branch. With that default, pushing
    to `main` starts a build immediately — in parallel with, and possibly ahead of, the migration
    job — and the job graph above guarantees nothing at all. Turning it off is what makes the
    `needs:` edge the only route to production.

    YAML 1.1 reads a bare `off` as the boolean false, so `render.yaml` quotes it; both spellings
    are accepted here because either means the same thing to a reader, and only the string form
    means it to Render.
    """
    service = (blueprint.get("services") or [{}])[0]
    trigger = service.get("autoDeployTrigger", "commit")

    assert trigger in ("off", False), (
        f"render.yaml sets autoDeployTrigger to {trigger!r}: Render would release a push to main "
        "without waiting for the migration job"
    )


def test_the_deploy_releases_the_commit_that_was_migrated(release_text: str) -> None:
    """Without `commitId`, Render deploys the branch tip — possibly a later, un-migrated commit."""
    assert "commitId" in release_text, "the deploy does not pin the commit it releases"
    assert re.search(r"commitId[^\n]*GITHUB_SHA", release_text), (
        "the deploy names a commitId that is not this run's commit"
    )


# ------------------------------------------------------------------ 2. the privileged boundary


def test_the_migration_runs_under_the_privileged_connection(release: dict[str, Any]) -> None:
    """The credential, the runtime mode, and the command that uses them."""
    migrate = _job(release, "migrate")
    env = _job_env_text(migrate)

    assert "DATABASE_URL_PRIVILEGED" in env, "the migration job is not given the privileged URL"
    assert "secrets.DATABASE_URL_PRIVILEGED" in env, (
        "the migration job's privileged URL does not come from the repository secret store"
    )
    assert "privileged" in env, "the migration job does not run in privileged mode"
    assert "alembic upgrade head" in _steps_text(migrate), (
        "the migration job does not apply migrations"
    )


def test_the_migration_has_no_fallback_to_the_request_connection(release: dict[str, Any]) -> None:
    """`DATABASE_URL` must not be in scope for the migration job, in any form.

    `resolve_url()` already refuses to substitute one connection for the other, so a fallback could
    not silently succeed — but a `DATABASE_URL` in this job's environment would be a standing
    invitation to "fix" a failing migration by pointing it at the restricted role, which would then
    fail part-way through a revision instead of before it.
    """
    env = _job_env_text(_job(release, "migrate"))

    # `DATABASE_URL_PRIVILEGED` contains `DATABASE_URL`, so the boundary matters.
    bare = re.findall(r"\bDATABASE_URL\b(?!_)", env)
    assert not bare, (
        "the migration job has DATABASE_URL in scope; the privileged URL has no fallback"
    )


def test_the_migration_fails_closed_when_the_credential_is_absent(release: dict[str, Any]) -> None:
    """An unset secret must stop the release, not produce a run that migrated nothing.

    A secret that is not configured expands to the empty string rather than failing, so without an
    explicit check the job would proceed and only Alembic's own error would stop it — after it had
    started. Worse, a future step ordering could let an empty value look like a successful no-op.
    """
    steps = _steps_text(_job(release, "migrate"))

    assert re.search(r'-z\s+"\$\{?DATABASE_URL_PRIVILEGED', steps), (
        "the migration job does not refuse to run when DATABASE_URL_PRIVILEGED is unset"
    )
    assert "exit 1" in steps, "the migration job's guard does not fail the job"


def test_the_release_pipeline_never_holds_the_service_role_key(release_text: str) -> None:
    """It provisions evaluation test users. It has no business in a release."""
    assert "SUPABASE_SERVICE_ROLE_KEY" not in release_text, (
        "the release pipeline reads the service-role key, which no release step needs"
    )


def test_no_step_prints_a_credential(release: dict[str, Any], release_text: str) -> None:
    """Two ways a workflow leaks: it echoes a value, or it traces every command it runs.

    GitHub masks registered secret values in logs, but masking is a backstop and not a design —
    it does not cover a value derived from a secret, such as a connection string with the password
    substituted out of it.
    """
    assert not re.search(r"set\s+-[a-z]*x", release_text), (
        "a step enables shell tracing, which prints every expanded command including credentials"
    )

    jobs = release.get("jobs") or {}
    for name, job in jobs.items():
        for command in re.findall(r"echo[^\n]*", _steps_text(job)):
            assert "secrets." not in command, f"the {name} job echoes a secret: {command!r}"
            assert not re.search(r"\$\{?(RENDER_API_KEY|DATABASE_URL_PRIVILEGED)", command), (
                f"the {name} job echoes a credential: {command!r}"
            )


# ------------------------------------------------------------------ 3. verification after release


def test_the_release_is_verified_against_the_deployed_service(release: dict[str, Any]) -> None:
    """Task 23.4's verification clause: a deployment succeeded, and readiness reports reachable."""
    steps = _steps_text(_job(release, "verify"))

    assert "/api/v1/health" in steps, "the release is never checked for liveness"
    assert "/api/v1/ready" in steps, "the release is never checked for readiness"
    assert re.search(r"\.ready", steps), "the readiness check does not read the `ready` field"


def test_the_deploy_waits_for_render_to_report_the_release_live(release: dict[str, Any]) -> None:
    """Triggering a deploy is not a deployment. The job must wait, and must fail on failure.

    An unrecognised status keeps polling and therefore times out, which is the fail-closed
    direction: `verify` must never run against a release that is not live.
    """
    steps = _steps_text(_job(release, "deploy"))

    assert "live" in steps, "the deploy job does not wait for the release to be live"
    for failure in ("build_failed", "update_failed", "canceled"):
        assert failure in steps, f"the deploy job does not treat {failure} as a failure"


def test_every_wait_is_bounded(release: dict[str, Any]) -> None:
    """An unbounded poll is a job that hangs until the runner's own limit, holding the queue."""
    for name in ("image", "deploy", "verify"):
        steps = _steps_text(_job(release, name))
        if "for attempt in" in steps or "seq 1" in steps:
            assert re.search(r"seq 1 \d+", steps), f"the {name} job polls without a bound"


# ------------------------------------------------------------------ 4. ordinary CI stays clean


def test_only_the_release_pipeline_reads_a_repository_secret(repo_root: Path) -> None:
    """A pull request must never need a production credential, and a fork's CI must work.

    `test_ordinary_ci_needs_no_production_credential` asserts the same boundary from the other
    side. This one is the completeness half: any workflow that is neither ordinary CI nor the
    release pipeline has appeared without anyone deciding which side of the boundary it is on.
    """
    workflows = {path.name for path in (repo_root / ".github" / "workflows").glob("*.yml")}
    unclassified = workflows - set(ORDINARY_CI) - set(DIAGNOSTIC) - set(RELEASE_PIPELINES)
    assert not unclassified, (
        f"a workflow exists that is neither ordinary CI nor a release pipeline: {unclassified}. "
        "Decide whether it may hold a production credential and record it here."
    )

    for name in ORDINARY_CI:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()
        assert "secrets." not in rendered, f"{name} reads a repository secret"


def test_ordinary_ci_never_deploys(repo_root: Path) -> None:
    """Only the release pipeline may reach Render. A second route around it is a second race."""
    for name in ORDINARY_CI:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()
        assert "api.render.com" not in rendered, f"{name} triggers a Render deploy"
        assert "deploys" not in rendered, f"{name} appears to trigger a deploy"


# ------------------------------------------------------------------ 5. the diagnostic stays inert


def test_the_diagnostic_workflow_can_only_be_dispatched_by_hand(repo_root: Path) -> None:
    """A workflow holding the privileged DSN must not be reachable by pushing a commit.

    `DIAGNOSTIC` is classified as credential-holding, so the compensating control is that nothing
    but a person can start it. A `push` or `pull_request` trigger added here would put the
    privileged connection on the ordinary contribution path, which is the boundary
    `test_ordinary_ci_needs_no_production_credential` defends from the other side.
    """
    for name in DIAGNOSTIC:
        path = repo_root / ".github" / "workflows" / name
        assert path.is_file(), f"{name} is classified as a diagnostic but does not exist"

        # PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way.
        parsed: dict[Any, Any] = yaml.safe_load(path.read_text())
        triggers = set(parsed[True])
        assert triggers == {"workflow_dispatch"}, (
            f"{name} has triggers beyond workflow_dispatch: {sorted(triggers - {'workflow_dispatch'})}"
        )

        # Fail closed: an accidental dispatch must refuse before it connects to anything.
        rendered = path.read_text()
        assert "read-only-identity-probe" in rendered, (
            f"{name} does not require an explicit confirmation input"
        )


def test_the_diagnostic_workflow_cannot_deploy_or_migrate(repo_root: Path) -> None:
    """It reports an identity. Every other capability is absent rather than merely unused."""
    for name in DIAGNOSTIC:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()

        for forbidden in ("api.render.com", "RENDER_API_KEY", "RENDER_SERVICE_ID"):
            assert forbidden not in rendered, f"{name} can reach Render via {forbidden}"

        for forbidden in ("alembic upgrade", "alembic downgrade", "alembic stamp"):
            assert forbidden not in rendered, f"{name} runs `{forbidden}`"

        # The read-only session is the reason a probe against production is safe at all, and the
        # write guard is what proves it at run time rather than in this comment.
        assert "postgresql_readonly=True" in rendered, (
            f"{name} does not open a read-only PostgreSQL session"
        )
        assert "write guard" in rendered, f"{name} does not verify the server-side write guard"

        # It may reference the privileged secret. It may never print one.
        assert "DATABASE_URL_PRIVILEGED: ${{ secrets.DATABASE_URL_PRIVILEGED }}" in rendered, (
            f"{name} does not take the privileged URL from the repository secret"
        )
        assert re.search(r"\bDATABASE_URL\b(?!_)", rendered) is None, (
            f"{name} has DATABASE_URL in scope; the diagnostic needs only the privileged URL"
        )
        assert "hide_password=False)}" not in rendered, f"{name} interpolates a rendered DSN"


# ------------------------------------------------------------------ 6. the frontend release (23.5)


@pytest.fixture(scope="module")
def frontend_release(repo_root: Path) -> dict[str, Any]:
    path = repo_root / FRONTEND_RELEASE
    assert path.is_file(), f"{FRONTEND_RELEASE} is missing: the frontend has no release pipeline"
    loaded: dict[str, Any] = yaml.safe_load(path.read_text())
    return loaded


@pytest.fixture(scope="module")
def frontend_release_text(repo_root: Path) -> str:
    """The workflow with its comments stripped.

    What a workflow *does* is its steps, not its prose. These assertions read the executable half
    deliberately: a comment explaining that this pipeline holds no Alembic command must not be the
    thing that trips the test asserting it holds none.
    """
    lines = (repo_root / FRONTEND_RELEASE).read_text().splitlines()
    return "\n".join(line for line in lines if not line.lstrip().startswith("#"))


def test_the_frontend_release_holds_nothing_of_the_backend_s(frontend_release_text: str) -> None:
    """A second credential-holding workflow earns its place by reaching one thing only.

    The frontend release exists to publish a static-and-server-rendered bundle to Vercel. If it
    ever holds a database connection, the service-role key, or Render's API key, then the boundary
    that made it acceptable to add has gone, and the blast radius of a leaked Vercel token is no
    longer one Vercel project.
    """
    forbidden = (
        "DATABASE_URL",
        "DATABASE_URL_PRIVILEGED",
        "SUPABASE_SERVICE_ROLE_KEY",
        "WEATHRA_PRIVILEGED_SERVICE_ROLE_KEY",
        "OPENROUTER_API_KEY",
        "RENDER_API_KEY",
        "RENDER_SERVICE_ID",
    )
    for name in forbidden:
        assert name not in frontend_release_text, (
            f"{FRONTEND_RELEASE} names {name}; the frontend release must reach Vercel and nothing else"
        )


def test_the_frontend_release_cannot_migrate_or_release_the_backend(
    frontend_release_text: str,
) -> None:
    """One route to the backend, and it is `release.yml`. A second is a second race."""
    assert "alembic" not in frontend_release_text.lower(), (
        f"{FRONTEND_RELEASE} runs Alembic; migrations belong to the backend release alone"
    )
    assert "api.render.com" not in frontend_release_text, (
        f"{FRONTEND_RELEASE} triggers a Render deploy"
    )


def test_no_frontend_release_step_names_the_token(frontend_release: dict[str, Any]) -> None:
    """The Vercel token reaches the CLI through the environment, never through a command line.

    A token interpolated into `run:` is visible in the runner's process list and in any shell
    trace. The CLI reads `VERCEL_TOKEN` on its own, so no step needs to name it.
    """
    for name, job in frontend_release["jobs"].items():
        for step in job.get("steps", []):
            command = step.get("run", "")
            assert "secrets." not in command, (
                f"the {name} job names a secret in a command: {command!r}"
            )


def _frontend_steps(frontend_release: dict[str, Any]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = frontend_release["jobs"]["deploy"]["steps"]
    return steps


def _vercel_invocations(frontend_release: dict[str, Any]) -> dict[str, str]:
    """Every `vercel <subcommand>` in the deploy job, keyed by subcommand.

    Line continuations are folded away first: the flags that make the linking explicit are spread
    over several lines for legibility, and a test that reads the file line by line would not see
    them.
    """
    found: dict[str, str] = {}
    for step in _frontend_steps(frontend_release):
        body = " ".join(str(step.get("run", "")).replace("\\\n", " ").split())
        for fragment in body.split("vercel ")[1:]:
            subcommand = fragment.split(" ", 1)[0]
            if subcommand in {"pull", "build", "deploy", "link", "project", "env"}:
                found[subcommand] = f"vercel {fragment}"
    return found


def test_the_frontend_release_targets_the_existing_vercel_project(
    frontend_release: dict[str, Any],
) -> None:
    """The linking assertion, and the one that regressed.

    `vercel pull` cannot bring anything down until it has resolved *which* project it is talking
    about, and the identifiers alone are not enough to resolve one that a team owns: the CLI's
    owner lookup goes out with no team attached unless the scope is named, and a team-owned project
    answers that with a 403 rendered as "Could not retrieve Project Settings. To link your Project,
    remove the `.vercel` directory and deploy again" — misleading on a runner, which has no
    `.vercel` directory to remove.

    So both commands that reach the API name the team and the project explicitly. Asserted per
    command rather than by searching the file, because a flag on the pull that is missing from the
    deploy is the shape this would come back in.
    """
    invocations = _vercel_invocations(frontend_release)
    for subcommand in ("pull", "deploy"):
        assert subcommand in invocations, f"{FRONTEND_RELEASE} never runs `vercel {subcommand}`"
        command = invocations[subcommand]
        assert '--scope "$VERCEL_ORG_ID"' in command, (
            f"`vercel {subcommand}` does not name the team that owns the project; "
            "without --scope the CLI resolves the project outside any team and is refused"
        )
        assert '--project "$VERCEL_PROJECT_ID"' in command, (
            f"`vercel {subcommand}` does not name the existing project"
        )


def test_the_frontend_release_consumes_the_project_identifiers(
    frontend_release: dict[str, Any],
) -> None:
    """The identifiers come from repository secrets, and the job passes both.

    The CLI refuses a half-configured pair — one without the other is an error, not a fallback —
    so this asserts the job environment carries both and that each is a secret reference rather
    than a value written into the file.
    """
    env = frontend_release["jobs"]["deploy"]["env"]
    for name in ("VERCEL_ORG_ID", "VERCEL_PROJECT_ID"):
        assert name in env, f"{FRONTEND_RELEASE} does not carry {name}"
        assert f"secrets.{name}" in env[name], (
            f"{name} is not read from a repository secret: {env[name]!r}"
        )


def test_the_frontend_release_holds_the_token_in_the_environment_only(
    frontend_release: dict[str, Any],
) -> None:
    """The token reaches the CLI through the environment and is never named by a step.

    Two separate properties. It has to be *there* — the job environment reads it from a repository
    secret — and it must never reach a command line, where it would be visible in the runner's
    process list and in any shell trace. The identifiers are passed as flags precisely because
    they are not credentials; the token is not, precisely because it is.
    """
    job = frontend_release["jobs"]["deploy"]
    assert "secrets.VERCEL_TOKEN" in job["env"].get("VERCEL_TOKEN", ""), (
        f"{FRONTEND_RELEASE} does not read VERCEL_TOKEN from a repository secret"
    )
    for step in _frontend_steps(frontend_release):
        command = str(step.get("run", ""))
        assert "--token" not in command, (
            f"a step passes the token on a command line: {command!r}"
        )
        assert "VERCEL_TOKEN" not in command, (
            f"a step names the token in a command: {command!r}"
        )


def test_the_frontend_release_cannot_create_a_vercel_project(
    frontend_release: dict[str, Any],
) -> None:
    """A second Vercel project is the failure mode that would look like success.

    `--yes` answers the CLI's prompts, and one of the things it answers is "set this directory up
    as a new project?" — named after the directory it ran in, which from the repository root would
    be a project called after the repository, deployed to, and promoted, all while the real one
    sits untouched. Naming the project makes an unresolved project a hard failure instead.

    So every `vercel` command that both auto-confirms and reaches the API must also name the
    project, and nothing here may create one by hand.
    """
    invocations = _vercel_invocations(frontend_release)
    for subcommand, command in invocations.items():
        if subcommand == "build":
            continue
        if "--yes" in command or "-y " in command:
            assert '--project "$VERCEL_PROJECT_ID"' in command, (
                f"`vercel {subcommand}` auto-confirms without naming the project, so an "
                f"unresolved project would be created rather than reported: {command!r}"
            )
    assert "project" not in invocations, (
        f"{FRONTEND_RELEASE} runs `vercel project`; the release may only deploy to the project "
        "that already exists"
    )


def test_the_frontend_release_sequence_is_deterministic(
    frontend_release: dict[str, Any],
) -> None:
    """Pull, then build, then deploy, then verify — in one job, in that order.

    The order is the correctness condition, not a preference. Next.js inlines NEXT_PUBLIC_ values
    at build time, so a build before the pull bakes in nothing; `--prebuilt` promotes whatever is
    in `.vercel/output`, so a deploy before the build promotes the previous run's bundle or fails.
    """
    order = [
        index
        for index, step in enumerate(_frontend_steps(frontend_release))
        if "vercel pull" in str(step.get("run", ""))
        or "vercel build" in str(step.get("run", ""))
        or "vercel deploy" in str(step.get("run", ""))
    ]
    commands = [
        str(_frontend_steps(frontend_release)[index].get("run", "")) for index in order
    ]
    assert len(commands) == 3, (
        f"{FRONTEND_RELEASE} does not run pull, build and deploy as three steps"
    )
    assert "vercel pull" in commands[0], "the pull is not first"
    assert "vercel build" in commands[1], "the build does not follow the pull"
    assert "vercel deploy" in commands[2], "the deploy does not follow the build"
    for step in _frontend_steps(frontend_release):
        assert not step.get("continue-on-error"), (
            f"step {step.get('name')!r} continues on error, so a failed step would not stop the "
            "release"
        )


def test_the_frontend_verification_runs_only_after_a_successful_deploy(
    frontend_release: dict[str, Any],
) -> None:
    """Verification that can run without a deployment verifies the previous deployment.

    Steps in a job stop at the first failure unless a step says otherwise, so the ordering is
    enough — as long as no `if:` reintroduces the step after a failed deploy, and as long as the
    verification reads the URL the deploy produced rather than one written into the file.
    """
    steps = _frontend_steps(frontend_release)
    deploy_index = next(
        index for index, step in enumerate(steps) if "vercel deploy" in str(step.get("run", ""))
    )
    verify_index = next(
        index for index, step in enumerate(steps) if "/sign-in" in str(step.get("run", ""))
    )
    assert verify_index > deploy_index, (
        f"{FRONTEND_RELEASE} verifies before it deploys"
    )
    verify = steps[verify_index]
    assert "if" not in verify, (
        "the verification carries an `if:`, which can let it run after a failed deploy: "
        f"{verify.get('if')!r}"
    )
    assert "steps.deploy.outputs.url" in str(verify.get("run", "")), (
        "the verification does not read the URL the deploy produced, so it may be checking "
        "something other than what this run promoted"
    )


def test_the_frontend_release_verifies_what_it_deployed(frontend_release: dict[str, Any]) -> None:
    """The deployment answers for itself, as the backend release makes the service do.

    An upload that succeeded is not a frontend that renders: a build can publish and still fail to
    serve. The release ends by asking the deployment it just promoted for a public route.
    """
    steps = frontend_release["jobs"]["deploy"]["steps"]
    commands = " ".join(step.get("run", "") for step in steps)
    assert "vercel deploy" in commands, f"{FRONTEND_RELEASE} never deploys"
    assert "/sign-in" in commands, (
        f"{FRONTEND_RELEASE} does not ask the deployment for a public route after promoting it"
    )


def test_the_frontend_release_is_not_cancelled_half_way(frontend_release: dict[str, Any]) -> None:
    """Two racing deployments can finish out of order and promote the older commit."""
    assert frontend_release["concurrency"]["cancel-in-progress"] is False, (
        f"{FRONTEND_RELEASE} cancels a running release"
    )


def test_the_frontend_release_runs_only_on_frontend_changes(
    frontend_release: dict[str, Any],
) -> None:
    """Path-filtered, which is the reason it is a separate workflow rather than a job in `release.yml`."""
    paths = frontend_release[True]["push"]["paths"]
    assert "weathra/frontend/**" in paths, f"{FRONTEND_RELEASE} does not watch the frontend"
    assert frontend_release[True]["push"]["branches"] == ["main"], (
        f"{FRONTEND_RELEASE} releases from a branch other than main"
    )


def test_vercel_does_not_deploy_on_its_own(repo_root: Path) -> None:
    """The frontend's half of `autoDeployTrigger: "off"`, and it fails the same way if lost.

    Vercel's default, once a project is connected to a repository, is to build and promote on every
    push to the production branch. With the default left in place a push to `main` would produce
    two production deployments — Vercel's own and `frontend-release.yml`'s — racing to be promoted
    last, so which commit ends up live depends on which build happened to be slower.

    Disabling it here rather than in the dashboard keeps the setting in version control, where a
    change to it arrives as a diff. `render.yaml` holds the identical line for the backend, and for
    the identical reason.
    """
    import json

    path = repo_root / VERCEL_PROJECT
    assert path.is_file(), (
        f"{VERCEL_PROJECT} is missing: Vercel's own Git deployments are unbounded"
    )
    project = json.loads(path.read_text())
    assert project.get("git", {}).get("deploymentEnabled", {}).get("main") is False, (
        f"{VERCEL_PROJECT} lets Vercel deploy `main` itself; "
        "the release workflow must be the only route to production"
    )
