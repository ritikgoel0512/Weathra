"""Task 23.5 — resolving the URL production is actually served on, and proving it is this build's.

`vercel deploy` prints the deployment's own URL, and production is not served on it: Vercel's
Standard Deployment Protection answers every generated deployment URL with a `302` to
`vercel.com/sso-api`. The 2026-09-08 release proved how bad that is as a verification target — it
promoted a frontend that returned 500 on every route, and the check could not tell that apart from
Vercel's login redirect, because it never saw either. It saw a 302 both times.

`.github/scripts/vercel_release_alias.py` reads the public production domain from the deployment
itself. What is asserted here is the part that makes a green verification mean something: the
script refuses to name a hostname until the deployment it was handed is this project's, targets
production, is READY, and has had its aliases assigned. Without those, a 200 could be the previous
build answering for the new one — a release that verifies the wrong deployment is worse than one
that does not verify at all, because it reports success.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPT = ".github/scripts/vercel_release_alias.py"

PROJECT_ID = "prj_weathra_frontend"
DEPLOYMENT_HOST = "weathra-g89kpe6w1-weathra.vercel.app"
PRODUCTION_DOMAIN = "weathra-bice.vercel.app"
# The generated project alias. Real, listed, and SSO-protected — verifying it would 302 forever.
GENERATED_ALIAS = "weathra-weathra.vercel.app"


@pytest.fixture(scope="module")
def script(repo_root: Path) -> Any:
    """The alias resolver, imported from its path with its sibling on the import path.

    It shares the API reader with `vercel_release_env.py` rather than carrying a second copy, which
    is also how it runs on the runner: `python3 .github/scripts/vercel_release_alias.py` puts that
    directory first on `sys.path`.
    """
    path = repo_root / SCRIPT
    assert path.is_file(), f"{SCRIPT} is missing: the release cannot resolve its production domain"
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location("weathra_vercel_release_alias", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(path.parent))
    return module


def _deployment(**overrides: Any) -> dict[str, Any]:
    deployment = {
        "id": "dpl_F9D5sDKyK9qsTLC5hkZwCwHKZeKz",
        "url": DEPLOYMENT_HOST,
        "projectId": PROJECT_ID,
        "target": "production",
        "readyState": "READY",
        "aliasAssigned": 1788869079000,
        "alias": [PRODUCTION_DOMAIN, GENERATED_ALIAS],
    }
    deployment.update(overrides)
    return deployment


def _fetcher(deployment: dict[str, Any] | None = None, *, seen: list[str] | None = None) -> Any:
    def fetch(path: str) -> Any:
        if seen is not None:
            seen.append(path)
        return deployment if deployment is not None else _deployment()

    return fetch


# ------------------------------------------------------------------ what gets verified


def test_the_public_production_domain_is_what_is_returned(script: Any) -> None:
    """The `alias` entry the CLI itself calls primary, not the URL it printed to stdout."""
    hostnames = script.production_alias(_deployment(), DEPLOYMENT_HOST, PROJECT_ID)
    assert hostnames[0] == PRODUCTION_DOMAIN


def test_the_sso_protected_deployment_url_is_never_what_is_verified(script: Any) -> None:
    """The defect this script exists for: the deployment's own URL must not be the target.

    It answers 302 to `vercel.com/sso-api` whatever the deployment's health, so a check pointed at
    it can neither pass nor detect a broken frontend.
    """
    hostnames = script.production_alias(_deployment(), DEPLOYMENT_HOST, PROJECT_ID)
    assert DEPLOYMENT_HOST not in hostnames


def test_stdout_carries_the_hostname_alone(script: Any, capsys: pytest.CaptureFixture[str]) -> None:
    """The workflow captures stdout into a step output, so anything else on it corrupts the URL."""
    assert script.run(PROJECT_ID, f"https://{DEPLOYMENT_HOST}", _fetcher()) == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == PRODUCTION_DOMAIN
    assert PRODUCTION_DOMAIN in captured.err, "the log does not report what will be verified"


def test_a_custom_domain_is_preferred_over_a_generated_one(script: Any) -> None:
    """The address the product is used at, and the one Deployment Protection never covers."""
    deployment = _deployment(alias=[GENERATED_ALIAS, "weathra.app", PRODUCTION_DOMAIN])
    assert script.production_alias(deployment, DEPLOYMENT_HOST, PROJECT_ID)[0] == "weathra.app"


@pytest.mark.parametrize(
    "given",
    [
        f"https://{DEPLOYMENT_HOST}",
        DEPLOYMENT_HOST,
        f"https://{DEPLOYMENT_HOST}/",
        f"  https://{DEPLOYMENT_HOST}\n",
    ],
)
def test_the_deploy_step_s_url_is_read_in_every_form_it_arrives_in(script: Any, given: str) -> None:
    """`vercel deploy` prints a URL; the deployments API wants a hostname, as the CLI's own
    `getDeployment` also converts it."""
    assert script.deployment_host(given) == DEPLOYMENT_HOST


def test_only_deployment_scoped_reads_are_made(script: Any) -> None:
    """The token is team-scoped: a team or user lookup is refused, as `vercel pull` proved."""
    seen: list[str] = []
    script.run(PROJECT_ID, f"https://{DEPLOYMENT_HOST}", _fetcher(seen=seen))
    assert seen == [f"/v13/deployments/{DEPLOYMENT_HOST}"]
    for path in seen:
        assert "/v2/teams" not in path and "/v2/user" not in path


# ------------------------------------------------------------------ proving it is this build


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"projectId": "prj_something_else"}, "does not belong to the project"),
        ({"target": "preview"}, "not 'production'"),
        ({"readyState": "ERROR"}, "not READY"),
        ({"readyState": "BUILDING"}, "not READY"),
        ({"aliasAssigned": None}, "aliases are not assigned"),
        ({"aliasError": {"code": "conflict"}}, "alias error"),
        ({"alias": []}, "carries no production alias"),
        ({"alias": None}, "carries no production alias"),
        ({"url": "weathra-someotherbuild-weathra.vercel.app"}, "different deployment"),
    ],
)
def test_a_deployment_that_is_not_this_run_s_production_is_refused(
    script: Any, overrides: dict[str, Any], expected: str
) -> None:
    """Nine ways a verification could pass while proving nothing, each refused.

    The two that matter most: a `preview` target means the promotion never happened and production
    is untouched, and unassigned aliases mean the domains still point at the previous build — so a
    200 would be the old frontend answering for the new one.
    """
    with pytest.raises(script.ReleaseError, match=expected):
        script.production_alias(_deployment(**overrides), DEPLOYMENT_HOST, PROJECT_ID)


def test_a_missing_deployment_ends_the_verification(script: Any) -> None:
    with pytest.raises(script.ReleaseError, match="no deployment"):
        script.read_deployment(lambda _: {"nothing": True}, DEPLOYMENT_HOST)


def test_an_empty_deploy_url_ends_the_verification(script: Any) -> None:
    """A deploy step that printed nothing must not be read as "nothing to check"."""
    with pytest.raises(script.ReleaseError, match="no URL"):
        script.deployment_host("   ")


def test_a_missing_token_ends_the_verification(
    script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VERCEL_TOKEN", raising=False)
    assert script.main(["--project-id", PROJECT_ID, "--deployment-url", DEPLOYMENT_HOST]) == 1
