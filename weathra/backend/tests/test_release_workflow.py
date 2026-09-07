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
# The release pipeline is deliberately not in this set; it is the only workflow that may read a
# repository secret.
ORDINARY_CI = ("backend.yml", "frontend.yml")


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
    unclassified = workflows - set(ORDINARY_CI) - {"release.yml"}
    assert not unclassified, (
        f"a workflow exists that is neither ordinary CI nor the release pipeline: {unclassified}. "
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
