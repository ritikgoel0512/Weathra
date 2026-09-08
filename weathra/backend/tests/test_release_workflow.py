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
import subprocess
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

# The names the identifiers reach the CLI under, and deliberately not VERCEL_ORG_ID and
# VERCEL_PROJECT_ID: under those names the CLI auto-detects the pair and re-resolves the project
# through the API on every command, instead of reading the link the release wrote and checked. The
# repository secrets keep their own names; only what the CLI process sees is renamed.
ORG_ID_VAR = "WEATHRA_VERCEL_ORG_ID"
PROJECT_ID_VAR = "WEATHRA_VERCEL_PROJECT_ID"

# The script that stands in for `vercel pull`. Its own behaviour — failing closed on every partial
# answer, and keeping backend secrets and the release token out of the build environment — is
# asserted in `test_frontend_release_environment.py`. What is asserted here is that the workflow
# uses it, and that nothing puts `vercel pull` back.
RELEASE_ENV_SCRIPT = ".github/scripts/vercel_release_env.py"

# The other half, and the reason it exists: `vercel deploy` prints the deployment's own URL, which
# Vercel's Standard Deployment Protection answers with a 302 to `vercel.com/sso-api`. Production is
# served on the project's production domain, which the script reads from the deployment's `alias`
# field — and only after proving the deployment is this project's, targets production, is READY and
# has its aliases assigned. `test_frontend_release_alias.py` holds that behaviour.
RELEASE_ALIAS_SCRIPT = ".github/scripts/vercel_release_alias.py"
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

# Neither ordinary CI, nor a release, nor a diagnostic: it changes the *configuration* of a service
# that is already released, and never what is running on it.
#
# `backend-allowed-origin.yml` adds one browser origin to the backend's CORS_ALLOWED_ORIGINS.
# `render.yaml` declares that variable with `sync: false`, so its value lives in Render and no
# commit can reach it — and task 23.5 needs the production frontend's origin in it, or a browser
# refuses every call the frontend makes before the bearer token is looked at. It holds a Render
# credential, so the compensating controls are the same as the diagnostic's: hand-dispatched only,
# and every capability it does not need is absent rather than merely unused.
MAINTENANCE = ("backend-allowed-origin.yml",)

# The one workflow that runs unattended, and the only one that deletes rows.
#
# `database-retention.yml` is design.md decision 11's "retention routine invoked from a scheduled CI
# job in the MVP, no in-process scheduler" (task 23.6). It holds the privileged connection because
# removing expired rows belonging to *other people* is precisely the work the request-serving role
# must not be able to do — so the compensating controls are that it can do nothing else with it: no
# Alembic, no Render credential, no service-role key, and a read-only verification of the schema
# before anything is removed.
SCHEDULED = ("database-retention.yml",)

# The workflow that checks the deployed pair rather than the code — tasks 25.3 and 25.4.
#
# `live-acceptance.yml` reads production, and in its authenticated tier signs in as two dedicated
# test accounts and writes one saved location to one of them before deleting it again. That is the
# only write, it reaches nobody's own account, and it never touches the database directly: it holds
# no privileged connection, no service-role key, and no Render or Vercel credential. Its
# credential-free tier runs through a client that refuses any method but GET, HEAD and OPTIONS.
ACCEPTANCE = ("live-acceptance.yml",)


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
    unclassified = (
        workflows
        - set(ORDINARY_CI)
        - set(DIAGNOSTIC)
        - set(RELEASE_PIPELINES)
        - set(MAINTENANCE)
        - set(SCHEDULED)
        - set(ACCEPTANCE)
    )
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


def test_the_maintenance_workflow_can_only_be_dispatched_by_hand(repo_root: Path) -> None:
    """A workflow holding an account-scoped Render key must not be reachable by pushing a commit.

    `RENDER_API_KEY` is the most powerful credential in this repository's store — it reaches every
    service on the account, not just this one — so the control is that only a person can start
    this, and only deliberately. A `push` trigger here would put that key on the ordinary
    contribution path.
    """
    for name in MAINTENANCE:
        path = repo_root / ".github" / "workflows" / name
        assert path.is_file(), f"{name} is classified as maintenance but does not exist"

        # PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way.
        parsed: dict[Any, Any] = yaml.safe_load(path.read_text())
        triggers = set(parsed[True])
        assert triggers == {"workflow_dispatch"}, (
            f"{name} has triggers beyond workflow_dispatch: "
            f"{sorted(triggers - {'workflow_dispatch'})}"
        )
        assert parsed["concurrency"]["cancel-in-progress"] is False, (
            f"{name} cancels a running change; two runs racing would each read the origin list "
            "before the other wrote it, and the second write would drop the first one's origin"
        )


def test_the_maintenance_workflow_changes_configuration_and_nothing_else(
    repo_root: Path,
) -> None:
    """It edits one environment variable. Migrating and reading the database are absent.

    It does deploy, and it has to: Render does not apply a saved environment variable until the
    service's next deploy, and its restart is documented to reuse "the exact same Git commit and
    configuration as the running instance". What must stay absent is everything else — and the
    deploy it asks for is pinned to the commit already running, which
    `test_the_maintenance_workflow_never_promotes_a_commit` holds.
    """
    for name in MAINTENANCE:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()

        for forbidden in (
            "DATABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "WEATHRA_PRIVILEGED_SERVICE_ROLE_KEY",
            "OPENROUTER_API_KEY",
        ):
            assert forbidden not in rendered, f"{name} has {forbidden} in scope"

        for forbidden in ("alembic upgrade", "alembic downgrade", "alembic stamp"):
            assert forbidden not in rendered, f"{name} runs `{forbidden}`"

        assert "RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}" in rendered, (
            f"{name} does not take the Render key from the repository secret"
        )
        for step in yaml.safe_load(rendered)["jobs"]["allow"]["steps"]:
            command = str(step.get("run", ""))
            assert "RENDER_API_KEY" not in command, (
                f"{name} names the Render key in a command, where it would be visible in the "
                f"runner's process list: {command!r}"
            )
            assert "secrets." not in command, f"{name} names a secret in a command: {command!r}"


def test_the_maintenance_workflow_never_promotes_a_commit(repo_root: Path) -> None:
    """It may restart the running commit. It may never choose a different one.

    An unpinned `POST /v1/services/<id>/deploys` deploys the branch tip, and the tip may be a
    commit whose Alembic migrations have not run — the ordering `release.yml`'s `needs:` edge
    exists to guarantee. Pinning the deploy to the commit the service is already serving is what
    keeps this workflow a configuration change rather than a second, quieter release path.

    `test_render_allowed_origin.py` proves the behaviour — that the body carries the live commit,
    and that a service with no identifiable live commit is refused rather than deployed. This
    holds the shape, so the pin cannot be dropped without a test failing.
    """
    source = (repo_root / ".github" / "scripts" / "render_allowed_origin.py").read_text()
    assert '"commitId": commit_id' in source, (
        "the redeploy no longer pins a commit, so it would promote whatever the branch tip is"
    )
    assert "live_commit(deploys)" in source, (
        "the pinned commit no longer comes from the service's live deploy"
    )
    assert "/rollback" not in source, "the operation can roll production back to another deploy"


def test_the_maintenance_workflow_cannot_replace_the_whole_environment(repo_root: Path) -> None:
    """The one Render endpoint that could delete the database credentials, and its absence.

    `PUT /v1/services/<id>/env-vars` replaces a service's entire environment; a partial body there
    deletes everything omitted. The per-key endpoint used instead — `.../env-vars/<key>` — updates
    only the variable named in the path, so unrelated variables survive by construction rather than
    by care. `test_render_allowed_origin.py` holds the behaviour; this holds the shape.
    """
    source = (repo_root / ".github" / "scripts" / "render_allowed_origin.py").read_text()
    assert '"/services/{quoted}/env-vars/{ENV_KEY}"' in source, (
        "the script no longer writes through Render's per-key endpoint"
    )
    assert 'api("PUT", f"/services/{quoted}/env-vars",' not in source, (
        "the script writes through Render's whole-environment endpoint, which deletes every "
        "variable omitted from the body"
    )


def test_the_retention_job_runs_unattended_and_by_hand(repo_root: Path) -> None:
    """A schedule is the requirement, and a manual dispatch is how it is ever proven.

    Task 23.6 asks for the routine to be *invoked on a schedule from CI*, so the cron entry is the
    thing being required rather than a convenience. `workflow_dispatch` sits beside it because a
    scheduled job that has never run is not evidence of anything, and waiting a day to learn
    whether it works is not a verification strategy.

    What must stay absent is `push` and `pull_request`: a contributor's commit must not be able to
    start a job that deletes rows under the privileged connection.
    """
    for name in SCHEDULED:
        path = repo_root / ".github" / "workflows" / name
        assert path.is_file(), f"{name} is classified as scheduled but does not exist"

        # PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way.
        parsed: dict[Any, Any] = yaml.safe_load(path.read_text())
        triggers = set(parsed[True])
        assert triggers == {"schedule", "workflow_dispatch"}, (
            f"{name} has triggers beyond schedule and workflow_dispatch: "
            f"{sorted(triggers - {'schedule', 'workflow_dispatch'})}"
        )
        assert parsed[True]["schedule"], f"{name} declares no cron schedule"
        assert parsed["concurrency"]["cancel-in-progress"] is False, (
            f"{name} cancels a running pass; cancelling mid-delete leaves the next pass more to do"
        )
        assert parsed["jobs"]["retain"].get("timeout-minutes"), (
            f"{name} is unbounded; an unattended job that hangs holds the privileged connection "
            "until somebody notices"
        )


def test_the_unattended_pass_removes_rather_than_counts(repo_root: Path) -> None:
    """The scheduled run must do the thing the task requires, and a dispatch must be readable.

    This exists because it went wrong. The first two dispatches were a checkbox apart, both
    rendered `[ "true" = "true" ]`, and both counted — the second was meant to be the real pass,
    and the only way to tell was to read the `--dry-run` in the step's echoed script. A run that
    did not do what it was dispatched to do reported success.

    So: the mode is a named choice whose default is the real pass, the schedule (which supplies no
    inputs at all) falls back to that same default, and the chosen word is printed before anything
    runs. "Which mode was that run?" is then answerable from the top of the log rather than by
    decoding a shell condition.
    """
    for name in SCHEDULED:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()
        parsed: dict[Any, Any] = yaml.safe_load(rendered)

        mode = parsed[True]["workflow_dispatch"]["inputs"]["mode"]
        assert mode["type"] == "choice", (
            f"{name} takes its mode as something other than a named choice; a checkbox was misread "
            "once already"
        )
        assert mode["default"] == "remove", (
            f"{name} defaults to something other than the real pass, so an untouched dispatch "
            "would not do what the schedule does"
        )
        assert set(mode["options"]) == {"remove", "count-only"}

        step = next(
            step
            for step in parsed["jobs"]["retain"]["steps"]
            if "weathra-retention" in str(step.get("run", ""))
        )
        assert "inputs.mode || 'remove'" in str(step.get("env", {}).get("MODE", "")), (
            f"{name} does not fall back to the real pass when no input is supplied, which is every "
            "scheduled run"
        )
        assert 'echo "mode: ' in str(step["run"]), (
            f"{name} does not say which mode it is running in, so a log cannot be read back"
        )


def test_the_retention_job_verifies_before_it_deletes(repo_root: Path) -> None:
    """The order is a safety property, not a tidiness one.

    A schema that is not the one this code expects is the last state in which to start deleting
    rows, so the read-only verification runs first and a failure there stops the run. It is also
    the only evidence task 23.6 can have about the deployed database: the `db` suite truncates every
    user-owned table between tests (`tests/db_support.py`), so pointing it at production would
    delete everybody's data in order to prove a schema claim.
    """
    for name in SCHEDULED:
        parsed: dict[Any, Any] = yaml.safe_load(
            (repo_root / ".github" / "workflows" / name).read_text()
        )
        commands = [str(step.get("run", "")) for step in parsed["jobs"]["retain"]["steps"]]
        verify_at = next(
            index for index, command in enumerate(commands) if "verify_database.py" in command
        )
        delete_at = next(
            index for index, command in enumerate(commands) if "weathra-retention" in command
        )
        assert verify_at < delete_at, f"{name} deletes before it verifies the schema"

    assert (repo_root / "weathra" / "backend" / "scripts" / "verify_database.py").is_file(), (
        "the verification script is missing, so the retention job cannot check what it deletes from"
    )


def test_the_retention_job_can_do_nothing_but_retain(repo_root: Path) -> None:
    """It holds the most dangerous connection in the project, so every other capability is absent.

    `WEATHRA_RUNTIME_MODE: privileged` is asserted as a *presence*, for the opposite reason to the
    rest: both the verifier and the routine refuse to run without it, because under the
    request-serving configuration the policies narrow every delete to nothing and the job would
    report success having removed almost nothing.
    """
    for name in SCHEDULED:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()

        for forbidden in (
            "SUPABASE_SERVICE_ROLE_KEY",
            "WEATHRA_PRIVILEGED_SERVICE_ROLE_KEY",
            "OPENROUTER_API_KEY",
            "RENDER_API_KEY",
            "RENDER_SERVICE_ID",
            "api.render.com",
            "VERCEL_TOKEN",
        ):
            assert forbidden not in rendered, f"{name} has {forbidden} in scope"

        for forbidden in ("alembic upgrade", "alembic downgrade", "alembic stamp"):
            assert forbidden not in rendered, f"{name} runs `{forbidden}`; it may not migrate"

        assert "WEATHRA_RUNTIME_MODE: privileged" in rendered, (
            f"{name} does not run in privileged mode, so it would delete almost nothing and report "
            "that it had succeeded"
        )
        assert "DATABASE_URL_PRIVILEGED: ${{ secrets.DATABASE_URL_PRIVILEGED }}" in rendered, (
            f"{name} does not take the privileged connection from the repository secret"
        )
        assert re.search(r"\bDATABASE_URL\b(?!_)", rendered) is None, (
            f"{name} has the request-path DATABASE_URL in scope; retention needs only the "
            "privileged connection"
        )
        for step in yaml.safe_load(rendered)["jobs"]["retain"]["steps"]:
            command = str(step.get("run", ""))
            assert "secrets." not in command, f"{name} names a secret in a command: {command!r}"
            assert "hide_password=False" not in command, f"{name} could render a DSN"


def test_the_acceptance_workflow_only_runs_by_hand(repo_root: Path) -> None:
    """It reads production and signs in as real accounts, so nothing but a person may start it."""
    for name in ACCEPTANCE:
        path = repo_root / ".github" / "workflows" / name
        assert path.is_file(), f"{name} is classified as acceptance but does not exist"

        # PyYAML reads a bare `on` key as the boolean `True` — YAML 1.1 spells true that way.
        parsed: dict[Any, Any] = yaml.safe_load(path.read_text())
        assert set(parsed[True]) == {"workflow_dispatch"}, (
            f"{name} has triggers beyond workflow_dispatch: {sorted(parsed[True])}"
        )
        assert parsed["jobs"]["verify"].get("timeout-minutes"), f"{name} is unbounded"


def test_the_acceptance_workflow_holds_no_privileged_credential(repo_root: Path) -> None:
    """It is the least privileged credential-holding workflow here, and stays that way.

    Two dedicated account passwords and a public client key: that is all it needs to prove one
    account cannot read another's data. A service-role key would let it provision accounts, a
    database connection would let it check isolation by reading the tables directly, and either
    would mean the suite was no longer testing what a caller can actually do.
    """
    for name in ACCEPTANCE:
        rendered = (repo_root / ".github" / "workflows" / name).read_text()

        for forbidden in (
            "SUPABASE_SERVICE_ROLE_KEY",
            "WEATHRA_PRIVILEGED_SERVICE_ROLE_KEY",
            "DATABASE_URL_PRIVILEGED",
            "OPENROUTER_API_KEY",
            "RENDER_API_KEY",
            "VERCEL_TOKEN",
            "api.render.com",
        ):
            assert forbidden not in rendered, f"{name} has {forbidden} in scope"

        for forbidden in ("alembic", "weathra-retention", "vercel "):
            assert forbidden not in rendered, f"{name} can run `{forbidden}`"

        assert re.search(r"\bDATABASE_URL\b(?!_)", rendered) is None, (
            f"{name} has a database connection in scope; it must check the deployment through its API"
        )
        for step in yaml.safe_load(rendered)["jobs"]["verify"]["steps"]:
            command = str(step.get("run", ""))
            assert "secrets." not in command, f"{name} names a secret in a command: {command!r}"


def test_the_acceptance_workflow_checks_the_canonical_deployment(repo_root: Path) -> None:
    """The addresses are written down, so a run's log says which deployment it examined.

    A suite that defaulted silently could check a stale URL and report a healthy deployment nobody
    is using.
    """
    for name in ACCEPTANCE:
        parsed: dict[Any, Any] = yaml.safe_load(
            (repo_root / ".github" / "workflows" / name).read_text()
        )
        environment = parsed["jobs"]["verify"]["env"]
        assert environment["WEATHRA_LIVE_FRONTEND_URL"] == "https://weathra-bice.vercel.app"
        assert environment["WEATHRA_LIVE_BACKEND_URL"] == "https://weathra-backend.onrender.com"

        commands = " ".join(str(step.get("run", "")) for step in parsed["jobs"]["verify"]["steps"])
        assert "-m deployed" in commands, (
            f"{name} does not select the deployed marker, so it would run the ordinary suite"
        )
        assert "-rs" in commands, (
            f"{name} does not report skip reasons, so a run could not say whether the "
            "authenticated tier ran"
        )


# ------------------------------------------------------------------ 6. the frontend release (23.5)


@pytest.fixture(scope="module")
def frontend_release(repo_root: Path) -> dict[Any, Any]:
    """The parsed workflow.

    Keyed by `Any`, not `str`, and that is YAML rather than sloppiness: `on:` parses as the boolean
    `True`, so `frontend_release[True]` is how the triggers are reached — see
    `test_the_frontend_release_runs_only_on_frontend_changes`.
    """
    path = repo_root / FRONTEND_RELEASE
    assert path.is_file(), f"{FRONTEND_RELEASE} is missing: the frontend has no release pipeline"
    loaded: dict[Any, Any] = yaml.safe_load(path.read_text())
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
    """The promotion names the project it is promoting to, by id.

    The deploy is the step that would do the damage if the link were ever wrong, so it resolves the
    project explicitly rather than inheriting whatever the runner happens to have on disk. It is
    also what sets the CLI's `failIfNotFound` — see
    `test_the_frontend_release_cannot_create_a_vercel_project`.

    The build deliberately names nothing: it consumes the link the release wrote and the ownership
    check vouched for, and re-resolving the project there would be a second chance to disagree
    with it.
    """
    invocations = _vercel_invocations(frontend_release)
    assert "deploy" in invocations, f"{FRONTEND_RELEASE} never runs `vercel deploy`"
    assert f'--project "${PROJECT_ID_VAR}"' in invocations["deploy"], (
        "`vercel deploy` does not name the existing project"
    )
    assert "--project" not in invocations.get("build", ""), (
        "`vercel build` names the project, which sends it back to the API to re-resolve what the "
        "ownership check just vouched for"
    )


def test_the_frontend_release_does_not_run_vercel_pull(
    frontend_release: dict[str, Any], frontend_release_text: str
) -> None:
    """`vercel pull` cannot work under this pipeline's credential, and this is why.

    Reading Vercel CLI 59.11.7: `getLinkedProject` resolves `--project <id>` *before* printing its
    `Retrieving project…` spinner, and then — once it holds a link — calls `getOrgById(orgId)`,
    which is `GET /v2/teams/<team_id>`. A token scoped to a team rather than to the whole account
    is refused there with 403 `team_unauthorized`, and the CLI reports that refusal as *"Could not
    retrieve Project Settings. To link your Project, remove the `.vercel` directory and deploy
    again"* — a message about a directory a fresh runner does not have, for a request that never
    touched the project.

    `vercel deploy` survives it: it is the only command that passes `allowOwnerLookupFallback`,
    which lets it fall back to the project's own `accountId`. `pull` passes neither that nor
    `skipRemoteLookup`, and then reads `org.type`/`org.id`, so the refusal is fatal.

    **No flag changes this.** Three runs were spent on flags — `--scope`, then renaming the
    auto-detected identifiers, then `--project` — and all three failed at the same step, because
    the failing request is one `pull` makes regardless. Restoring it puts the release back on a
    path that cannot succeed, so its absence is asserted rather than assumed.
    """
    assert "pull" not in _vercel_invocations(frontend_release), (
        f"{FRONTEND_RELEASE} runs `vercel pull`, which is refused on a team lookup no flag "
        "removes; the release resolves the project through the project-scoped API instead"
    )
    assert "vercel env" not in frontend_release_text, (
        f"{FRONTEND_RELEASE} runs `vercel env`, which resolves the project the same way "
        "`vercel pull` does and is refused the same way"
    )


def test_the_frontend_release_writes_the_project_link_itself(
    repo_root: Path, frontend_release: dict[str, Any]
) -> None:
    """The two files `vercel pull` would have written, written from the project-scoped API instead.

    `.vercel/project.json` carries the project's settings — above all `rootDirectory`, which is
    what makes a build invoked from the repository root build `weathra/frontend` — and
    `.vercel/.env.production.local` carries the Production environment Next.js inlines at build
    time. Both come from `/v9/projects/<id>` and `/v9/projects/<id>/env`, which a team-scoped token
    can read.

    Asserted here: the script exists, the release runs it, and it is handed both identifiers
    through the neutral variables rather than either being written into the file.
    """
    assert (repo_root / RELEASE_ENV_SCRIPT).is_file(), (
        f"{RELEASE_ENV_SCRIPT} is missing: the release has no way to resolve its project"
    )
    steps = _frontend_steps(frontend_release)
    matching = [step for step in steps if RELEASE_ENV_SCRIPT in str(step.get("run", ""))]
    assert matching, f"{FRONTEND_RELEASE} never runs {RELEASE_ENV_SCRIPT}"
    body = " ".join(str(matching[0]["run"]).replace("\\\n", " ").split())
    for variable in (PROJECT_ID_VAR, ORG_ID_VAR):
        assert f'"${variable}"' in body, f"{RELEASE_ENV_SCRIPT} is not given {variable}: {body!r}"
    index = steps.index(matching[0])
    for name in ("vercel build", "vercel deploy"):
        at = next(
            position
            for position, candidate in enumerate(steps)
            if name in str(candidate.get("run", ""))
        )
        assert at > index, f"`{name}` runs before the project and its environment are resolved"


def test_the_frontend_release_never_names_the_scope(frontend_release: dict[str, Any]) -> None:
    """`--scope` cannot be used with this token, and its failure is not obvious from the message.

    The CLI resolves `--scope` *through the user identity*: `getUser` runs first, and the scope
    string is matched against the user and their team list before any direct team lookup is tried.
    A Vercel access token scoped to a team is blocked from the user-level `/v2/user` endpoint —
    Vercel's own support confirms this — so `--scope` exits with "Not able to load user because of
    unexpected error: User not found. (404)" before it ever reaches the project.

    A team-scoped token needs no scope flag: Vercel infers the team from the token. So this is not
    a preference. Reinstating `--scope` breaks the release, and the message it breaks with does not
    say why.
    """
    for subcommand, command in _vercel_invocations(frontend_release).items():
        assert "--scope" not in command, (
            f"`vercel {subcommand}` passes --scope, which resolves the team through a user-level "
            f"lookup a team-scoped token is refused: {command!r}"
        )
        assert "--team" not in command, (
            f"`vercel {subcommand}` passes --team, which is an alias for --scope and fails the "
            f"same way: {command!r}"
        )


def test_the_frontend_release_hides_the_identifiers_from_the_cli(
    frontend_release: dict[str, Any],
) -> None:
    """The identifiers must not reach the CLI process under the names it auto-detects.

    This was once believed to be the fix for the pull failure, and it was not — the team lookup
    that breaks `vercel pull` happens whatever these are called. It is kept for a different and
    smaller reason, which is worth stating precisely so it is not mistaken for the old one again.

    With `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` both set, the CLI takes its implicit env-link path
    and re-resolves the project through the API on every command. Under neutral names it cannot
    find them, so `.vercel/project.json` — the file the release wrote and the ownership check
    vouched for — stays the authority, and `vercel build` and `vercel deploy --prebuilt` resolve
    the project from disk without a lookup that could disagree with it or be refused.
    """
    env = frontend_release["jobs"]["deploy"]["env"]
    for name in ("VERCEL_ORG_ID", "VERCEL_PROJECT_ID"):
        assert name not in env, (
            f"{FRONTEND_RELEASE} exports {name} to the CLI, which puts it back on the implicit "
            "env-link path a team-scoped token is refused on"
        )
    for step in _frontend_steps(frontend_release):
        for name in step.get("env") or {}:
            assert name not in ("VERCEL_ORG_ID", "VERCEL_PROJECT_ID"), (
                f"step {step.get('name')!r} exports {name} to the CLI"
            )


def test_the_frontend_release_consumes_the_project_identifiers(
    frontend_release: dict[str, Any],
) -> None:
    """The identifiers still come from the same repository secrets, under neutral names.

    Renaming what the CLI sees must not turn into renaming what GitHub holds: the secrets keep
    their names, and this asserts each neutral variable is a reference to the original secret
    rather than a value written into the file.
    """
    env = frontend_release["jobs"]["deploy"]["env"]
    for local, secret in ((ORG_ID_VAR, "VERCEL_ORG_ID"), (PROJECT_ID_VAR, "VERCEL_PROJECT_ID")):
        assert local in env, f"{FRONTEND_RELEASE} does not carry {local}"
        assert f"secrets.{secret}" in env[local], (
            f"{local} is not read from the {secret} repository secret: {env[local]!r}"
        )


def test_the_frontend_release_proves_the_project_belongs_to_the_team(
    frontend_release: dict[str, Any],
) -> None:
    """The org id stops being a lookup input and becomes the check on the answer.

    An identifier handed to a lookup is an assumption. The answer is the `accountId` the project
    API returns — the project the id actually named saying who owns it — and the release script
    holds that to `WEATHRA_VERCEL_ORG_ID` before it writes anything, which
    `test_a_project_owned_by_another_team_is_never_built` covers.

    This asserts the second gate: the same claim restated against the artifact the build consumes.
    The script writes the API's `accountId` into `.vercel/project.json`, so holding that file's
    `orgId` to the expected team checks the link `vercel build` and `vercel deploy --prebuilt`
    will resolve the project from, rather than restating the value we passed in. Both have to be
    fatal and both have to come before the build: a project owned by another team must not be
    built for, let alone promoted.
    """
    steps = _frontend_steps(frontend_release)
    matching = [
        (index, step)
        for index, step in enumerate(steps)
        if ".vercel/project.json" in str(step.get("run", ""))
    ]
    assert matching, (
        f"{FRONTEND_RELEASE} never checks the project the pull resolved against "
        f"{ORG_ID_VAR}; the release could deploy a project owned by another team"
    )
    index, step = matching[0]
    body = str(step["run"])
    assert f"${ORG_ID_VAR}" in body, f"the check does not compare against {ORG_ID_VAR}: {body!r}"
    assert "orgId" in body, "the check does not read the resolved project's orgId"
    assert "exit 1" in body, "the check does not fail when the team does not match"
    assert not step.get("continue-on-error"), "the team check continues on error"

    for name, position in (("vercel build", None), ("vercel deploy", None)):
        at = next(
            position
            for position, candidate in enumerate(steps)
            if name in str(candidate.get("run", ""))
        )
        assert at > index, (
            f"`{name}` runs before the team check, so a project resolved under the wrong team "
            "would be built or promoted"
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
        assert "--token" not in command, f"a step passes the token on a command line: {command!r}"
        assert "VERCEL_TOKEN" not in command, f"a step names the token in a command: {command!r}"


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
            assert f'--project "${PROJECT_ID_VAR}"' in command, (
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
    """Resolve, then build, then deploy, then verify — in one job, in that order.

    The order is the correctness condition, not a preference. Next.js inlines NEXT_PUBLIC_ values
    at build time, so a build before the environment is written bakes in nothing; `--prebuilt`
    promotes whatever is in `.vercel/output`, so a deploy before the build promotes the previous
    run's bundle or fails.
    """
    markers = (RELEASE_ENV_SCRIPT, "vercel build", "vercel deploy")
    commands = [
        str(step.get("run", ""))
        for step in _frontend_steps(frontend_release)
        if any(marker in str(step.get("run", "")) for marker in markers)
    ]
    assert len(commands) == 3, (
        f"{FRONTEND_RELEASE} does not resolve, build and deploy as three steps"
    )
    assert RELEASE_ENV_SCRIPT in commands[0], (
        "the project and its environment are not resolved first"
    )
    assert "vercel build" in commands[1], "the build does not follow the environment"
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
    verification reads a domain resolved from *this* run's deployment rather than one written into
    the file.
    """
    steps = _frontend_steps(frontend_release)
    deploy_index = next(
        index for index, step in enumerate(steps) if "vercel deploy" in str(step.get("run", ""))
    )
    verify_index = next(
        index for index, step in enumerate(steps) if "/sign-in" in str(step.get("run", ""))
    )
    assert verify_index > deploy_index, f"{FRONTEND_RELEASE} verifies before it deploys"
    verify = steps[verify_index]
    assert "if" not in verify, (
        "the verification carries an `if:`, which can let it run after a failed deploy: "
        f"{verify.get('if')!r}"
    )
    assert "steps.alias.outputs.host" in str(verify.get("run", "")), (
        "the verification does not read the domain resolved from this run's deployment, so it may "
        "be checking something other than what this run promoted"
    )


def test_the_frontend_release_verifies_the_public_production_domain(
    repo_root: Path, frontend_release: dict[str, Any]
) -> None:
    """The verification target, and the defect that made a 500 in production look like a 302.

    `vercel deploy` prints the deployment's own URL. Vercel's Standard Deployment Protection
    answers it — and the generated `<project>-<team>.vercel.app` alias — with a 302 to
    `vercel.com/sso-api`, so a check pointed there can never see a 200. It could not see a 500
    either: the 2026-09-08 release promoted a frontend that answered 500 on every route, and the
    verification reported the same 302 it would have reported for a healthy one.

    So the public production domain is resolved from the deployment's own `alias` field and
    verified instead. Resolved, not written down: a hard-coded hostname stays green while pointing
    at whatever was promoted last — possibly another commit — and outlives a domain change in
    silence. Both halves are asserted, because either alone would let the defect back.
    """
    assert (repo_root / RELEASE_ALIAS_SCRIPT).is_file(), (
        f"{RELEASE_ALIAS_SCRIPT} is missing: the release has no way to find the public production "
        "domain"
    )
    steps = _frontend_steps(frontend_release)
    resolving = [step for step in steps if RELEASE_ALIAS_SCRIPT in str(step.get("run", ""))]
    assert resolving, f"{FRONTEND_RELEASE} never resolves the public production domain"
    body = " ".join(str(resolving[0]["run"]).replace("\\\n", " ").split())
    assert f'"${PROJECT_ID_VAR}"' in body, (
        f"the resolver is not told which project to check: {body!r}"
    )
    assert "steps.deploy.outputs.url" in body, (
        "the resolver is not given the deployment this run promoted, so it could resolve the "
        "domain of an earlier one"
    )

    verify = next(step for step in steps if "/sign-in" in str(step.get("run", "")))
    assert "steps.deploy.outputs.url" not in str(verify.get("run", "")), (
        "the verification reads the deployment URL `vercel deploy` printed, which Vercel's "
        "Deployment Protection answers with a 302 to vercel.com/sso-api; it can never pass and it "
        "cannot see a broken frontend either"
    )
    assert steps.index(resolving[0]) < steps.index(verify), (
        "the domain is resolved after the verification that uses it"
    )
    assert "sso-api" in str(verify.get("run", "")), (
        "the verification does not recognise Vercel's SSO redirect, so a protected domain would "
        "read as a frontend that is slow to start"
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
    frontend_release: dict[Any, Any],
) -> None:
    """Path-filtered, which is the reason it is a separate workflow rather than a job in `release.yml`."""
    paths = frontend_release[True]["push"]["paths"]
    assert "weathra/frontend/**" in paths, f"{FRONTEND_RELEASE} does not watch the frontend"
    assert frontend_release[True]["push"]["branches"] == ["main"], (
        f"{FRONTEND_RELEASE} releases from a branch other than main"
    )


def test_the_frontend_release_builds_on_the_runner_and_promotes_that_build(
    frontend_release: dict[str, Any],
) -> None:
    """What is promoted is what this commit built, and the two halves of that are separate.

    `vercel build --prod` runs here rather than on Vercel, so the bundle exists on the runner and
    was produced from this checkout. `vercel deploy --prebuilt` then promotes *that* output rather
    than asking Vercel to build again from the connected repository — which would be a second build
    of a possibly different commit, and would put the three `NEXT_PUBLIC_` values back in the hands
    of whatever the remote build happened to resolve.

    Losing either half would still deploy something, which is why both are asserted.
    """
    invocations = _vercel_invocations(frontend_release)
    assert "build" in invocations, f"{FRONTEND_RELEASE} never builds on the runner"
    assert "--prod" in invocations["build"], (
        "`vercel build` does not build for production, so the bundle would carry the preview "
        "environment"
    )
    deploy = invocations["deploy"]
    assert "--prebuilt" in deploy, (
        "`vercel deploy` does not promote the runner's build, so Vercel would build again from a "
        "commit this workflow did not verify"
    )
    assert "--prod" in deploy, "`vercel deploy` does not promote to production"


def test_no_vercel_runtime_state_is_committed(repo_root: Path) -> None:
    """`.vercel/` is runner state, and one of the two files in it is a downloaded environment.

    The release writes `project.json` and `.env.production.local` on every run, so a committed copy
    would be a stale project link and a snapshot of the Production configuration sitting in the
    tree — the second of which is the reason this is asserted rather than left to habit. Locally it
    is account state that has no business in the repository either.
    """
    ignored = (repo_root / ".gitignore").read_text().splitlines()
    assert any(line.strip() == ".vercel/" for line in ignored), (
        ".gitignore no longer ignores `.vercel/`, so a pulled environment can be committed"
    )
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.vercel/*", ".vercel/*"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    tracked = [name for name in listed.stdout.split("\0") if name]
    assert not tracked, f"Vercel runtime state is committed: {tracked}"


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
