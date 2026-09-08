"""Task 23.5 — adding one allowed origin to the deployed backend, and the deletions it must not do.

The production frontend cannot call the backend: it is served from a Vercel domain that the
service's ``CORS_ALLOWED_ORIGINS`` does not list, so a browser refuses every call before the bearer
token is looked at. ``render.yaml`` declares that variable with ``sync: false``, so its value lives
in Render and no commit can change it — which is why ``.github/scripts/render_allowed_origin.py``
exists and why it is tested this carefully.

The risk here is not that the origin fails to be added. It is what an environment-changing
operation can destroy while doing it:

1. **Other variables.** Render's ``PUT /v1/services/<id>/env-vars`` replaces a service's entire
   environment; the failure mode of getting that wrong is deleting the database credentials. The
   script uses the per-key endpoint, which touches only the named variable, and reads the
   environment back to hold that to be true rather than trusting it.
2. **Other origins.** An operation that "sets" the origin list would remove every origin someone
   added in Render that the repository does not know about. This one appends and never rewrites.
3. **Nothing at all, twice.** A second run must make no write, so it cannot restart production for
   a value that is already correct.
4. **The truth.** The backend reads configuration at start-up, so a saved value the running
   container has not picked up looks exactly like a value that was saved correctly. The run ends by
   asking production with a real preflight from the real origin.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPT = ".github/scripts/render_allowed_origin.py"

SERVICE_ID = "srv-weathra-backend"
LIVE_COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9"
BASE_URL = "https://weathra-backend.onrender.com"
ORIGIN = "https://weathra-bice.vercel.app"

# What the service holds today: one allowed origin, and credentials that must survive untouched.
EXISTING = {
    "CORS_ALLOWED_ORIGINS": "http://localhost:3000",
    "DATABASE_URL": "postgresql://user:pw@db.example.com:5432/postgres",
    "SUPABASE_URL": "https://project.supabase.co",
    "OPENROUTER_API_KEY": "or-key",
    "WEATHRA_RUNTIME_MODE": "request",
}


# Set by the `script` fixture, so the fake service can raise the script's own error type.
_module: Any = None


@pytest.fixture(scope="module")
def script(repo_root: Path) -> Any:
    global _module
    path = repo_root / SCRIPT
    assert path.is_file(), f"{SCRIPT} is missing: no origin can be allowed"
    spec = importlib.util.spec_from_file_location("weathra_render_allowed_origin", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _module = module
    return module


class FakeService:
    """A Render service, and a running process that only ever sees the environment it started with.

    That second half is the whole point of this harness. Render's restart is documented as reusing
    "the exact same Git commit **and configuration** as the running instance", and its dashboard
    says a saved variable is not used "until its next deploy" — so a fake whose process picked up
    `env` immediately would let the code that failed in production pass its tests. Here `booted`
    changes only when a deploy goes live.
    """

    def __init__(
        self,
        env: dict[str, Any] | None = None,
        *,
        fail_get: bool = False,
        fail_put: bool = False,
        malformed: Any = None,
        page_size: int | None = None,
        deploys: list[dict[str, Any]] | None = None,
        progression: list[str] | None = None,
        reject_deploy_mode: bool = False,
        error: type[Exception] | None = None,
    ) -> None:
        self.env: dict[str, Any] = dict(EXISTING if env is None else env)
        self.booted: dict[str, Any] = dict(self.env)
        self.fail_get = fail_get
        self.fail_put = fail_put
        self.malformed = malformed
        self.page_size = page_size
        self.error = error or RuntimeError
        self.deploys: list[dict[str, Any]] = (
            deploys
            if deploys is not None
            else [{"id": "dep-live", "status": "live", "commit": {"id": LIVE_COMMIT}}]
        )
        # The statuses a deploy this operation starts will walk through, newest read first.
        self.progression = list(progression or ["live"])
        self.reject_deploy_mode = reject_deploy_mode
        self.created: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str]] = []
        self.restarts = 0

    # -------------------------------------------------------------- the Render API

    def api(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        bare = path.split("?")[0]
        self.calls.append((method, bare))
        if bare.endswith("/env-vars") and method == "GET":
            return self._env_page(path)
        if "/env-vars/" in bare and method == "PUT":
            if self.fail_put:
                raise self.error("Render answered 500")
            assert body is not None
            self.env[bare.rsplit("/", 1)[1]] = body["value"]
            return {"key": bare.rsplit("/", 1)[1], "value": body["value"]}
        if bare.endswith("/deploys") and method == "GET":
            self._advance()
            return [
                {"deploy": deploy, "cursor": f"d{index}"}
                for index, deploy in enumerate(self.deploys)
            ]
        if bare.endswith("/deploys") and method == "POST":
            assert body is not None
            if self.reject_deploy_mode and "deployMode" in body:
                raise _module.RenderError("Render answered 400", status=400)
            self.created.append(dict(body))
            deploy = {
                "id": f"dep-{len(self.created)}",
                "status": self.progression[0],
                "commit": {"id": body.get("commitId", "unpinned")},
            }
            self.deploys.insert(0, deploy)
            self._settle(deploy)
            return {"id": deploy["id"], "status": deploy["status"]}
        if bare.endswith("/restart") and method == "POST":
            self.restarts += 1
            return None
        raise AssertionError(f"unexpected call: {method} {path}")

    def _env_page(self, path: str) -> Any:
        if self.fail_get:
            raise self.error("Render refused the API key")
        if self.malformed is not None:
            return self.malformed
        entries = [
            {"envVar": {"key": key, "value": value}, "cursor": f"c{index}"}
            for index, (key, value) in enumerate(sorted(self.env.items()))
        ]
        size = self.page_size or len(entries) + 1
        cursor = path.split("cursor=")[1].split("&")[0] if "cursor=" in path else None
        start = (
            0
            if cursor is None
            else next(index + 1 for index, entry in enumerate(entries) if entry["cursor"] == cursor)
        )
        return entries[start : start + size]

    def _advance(self) -> None:
        """Walk the newest deploy this operation started along its declared statuses."""
        if not self.created or len(self.progression) <= 1:
            return
        newest = self.deploys[0]
        if newest["id"].startswith("dep-") and newest["status"] == self.progression[0]:
            self.progression.pop(0)
            newest["status"] = self.progression[0]
            self._settle(newest)

    def _settle(self, deploy: dict[str, Any]) -> None:
        """A deploy going live is the only thing that gives the process a new environment."""
        if deploy["status"] == "live":
            self.booted = dict(self.env)

    # -------------------------------------------------------------- production, from outside

    def probe(self, method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "GET":
            return 200, {}
        allowed = [
            part.strip()
            for part in str(self.booted["CORS_ALLOWED_ORIGINS"]).split(",")
            if part.strip()
        ]
        origin = headers["Origin"]
        if origin in allowed:
            return 200, {"access-control-allow-origin": origin}
        # Starlette's answer to a disallowed origin: 400, and no allow-origin header at all.
        return 400, {"access-control-allow-methods": "GET, POST"}


def _apply(script: Any, service: FakeService, origin: str = ORIGIN) -> int:
    exit_code: int = script.apply(
        service.api,
        service.probe,
        SERVICE_ID,
        BASE_URL,
        origin,
        attempts=2,
        pause=0,
        deploy_attempts=6,
    )
    return exit_code


def _writes(service: FakeService) -> list[tuple[str, str]]:
    return [call for call in service.calls if call[0] != "GET"]


# ------------------------------------------------------------------ what it changes


def test_the_origin_is_added_and_the_existing_one_is_kept(script: Any) -> None:
    service = FakeService()
    assert _apply(script, service) == 0
    assert script.parse_origins(service.env["CORS_ALLOWED_ORIGINS"]) == [
        "http://localhost:3000",
        ORIGIN,
    ]


def test_every_other_variable_is_left_exactly_as_it_was(script: Any) -> None:
    """The failure mode worth testing for is deleting the database credentials, not a missing origin."""
    service = FakeService()
    assert _apply(script, service) == 0
    for key, value in EXISTING.items():
        if key == "CORS_ALLOWED_ORIGINS":
            continue
        assert service.env[key] == value, f"{key} was modified"
    assert set(service.env) == set(EXISTING), "the set of environment variables changed"


def test_only_the_one_key_is_ever_written(script: Any) -> None:
    """Render's whole-environment endpoint is never called, so it cannot replace anything."""
    service = FakeService()
    _apply(script, service)
    assert ("PUT", f"/services/{SERVICE_ID}/env-vars/CORS_ALLOWED_ORIGINS") in _writes(service)
    assert ("PUT", f"/services/{SERVICE_ID}/env-vars") not in _writes(service)


def test_a_second_run_changes_nothing_and_deploys_nothing(script: Any) -> None:
    """Idempotent in the way that matters: no write, and no deploy of production for nothing."""
    service = FakeService()
    assert _apply(script, service) == 0
    stored = service.env["CORS_ALLOWED_ORIGINS"]
    service.calls.clear()
    service.created.clear()

    assert _apply(script, service) == 0
    assert service.env["CORS_ALLOWED_ORIGINS"] == stored
    assert not _writes(service), "a second run wrote to Render"
    assert not service.created, "a second run deployed production"


@pytest.mark.parametrize(
    "configured",
    [
        ORIGIN,
        f"http://localhost:3000,{ORIGIN}",
        f" {ORIGIN} ,http://localhost:3000",
    ],
)
def test_an_origin_already_allowed_is_not_duplicated(script: Any, configured: str) -> None:
    """Surrounding whitespace is the only difference that makes two entries the same origin.

    It is also the only one anything downstream forgives: `config.py` strips each comma-separated
    part before Starlette compares it. Nothing already configured is rewritten, because rewriting
    an entry is a change to an origin this operation was asked to preserve.
    """
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": configured})
    assert _apply(script, service) == 0
    assert service.env["CORS_ALLOWED_ORIGINS"] == configured
    assert not [call for call in _writes(service) if "/env-vars/" in call[1]]


@pytest.mark.parametrize(
    "lookalike", ["https://WEATHRA-BICE.vercel.app", f"{ORIGIN}/", "http://weathra-bice.vercel.app"]
)
def test_an_entry_that_only_looks_equivalent_does_not_count_as_the_origin(
    script: Any, lookalike: str
) -> None:
    """Neither case nor a trailing slash nor the scheme may be folded in, and tests found each.

    Starlette compares the browser's `Origin` header against the configured list as exact strings,
    and a browser sends the scheme and host lower-cased with no trailing slash. So every spelling
    here is an entry that matches nothing. Treating one as "already allowed" would skip adding the
    spelling that works and leave production refusing the origin — while every check short of a
    real preflight reported success.
    """
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": lookalike})
    assert _apply(script, service) == 0
    assert script.parse_origins(service.env["CORS_ALLOWED_ORIGINS"]) == [lookalike, ORIGIN]


def test_the_whole_environment_is_read_even_when_it_pages(script: Any) -> None:
    """A truncated read is the input that makes an environment change destructive."""
    service = FakeService(page_size=2)
    assert _apply(script, service) == 0
    assert set(service.env) == set(EXISTING)


# ------------------------------------------------------------------ what stops it


def test_a_service_without_the_variable_is_left_alone(script: Any) -> None:
    """Deliberately not created: the value may come from a linked environment group.

    Setting it here would replace whatever the service resolves today with this one origin, which
    is the opposite of adding one.
    """
    service = FakeService(
        {key: value for key, value in EXISTING.items() if key != "CORS_ALLOWED_ORIGINS"}
    )
    with pytest.raises(script.RenderError, match="no CORS_ALLOWED_ORIGINS"):
        _apply(script, service)
    assert not _writes(service)


def test_a_failed_read_changes_nothing(script: Any) -> None:
    service = FakeService(fail_get=True)
    with pytest.raises(RuntimeError):
        _apply(script, service)
    assert not _writes(service)


@pytest.mark.parametrize(
    "malformed",
    [
        "not a list",
        [{"no": "envVar"}],
        [{"envVar": {"value": "nameless"}}],
        [{"envVar": "not an object"}],
    ],
)
def test_a_malformed_read_changes_nothing(script: Any, malformed: Any) -> None:
    service = FakeService(malformed=malformed)
    with pytest.raises(script.RenderError):
        _apply(script, service)
    assert not _writes(service)


def test_a_failed_update_is_reported(script: Any) -> None:
    service = FakeService(fail_put=True)
    with pytest.raises(RuntimeError):
        _apply(script, service)
    assert service.env["CORS_ALLOWED_ORIGINS"] == EXISTING["CORS_ALLOWED_ORIGINS"]
    assert not service.created, "production was deployed after a failed update"


def test_an_update_that_drops_an_origin_is_refused(script: Any) -> None:
    """The read-back, doing its job: if the stored value comes back short, the run fails."""
    service = FakeService()

    def losing_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if method == "PUT":
            return service.api(method, path, {"value": ORIGIN})
        return service.api(method, path, body)

    with pytest.raises(script.RenderError, match="no longer configured"):
        script.apply(losing_api, service.probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0)


def test_another_variable_changing_underneath_is_refused(script: Any) -> None:
    service = FakeService()

    def meddling_api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        result = service.api(method, path, body)
        if method == "PUT":
            service.env["DATABASE_URL"] = "postgresql://someone-else@host/db"
        return result

    with pytest.raises(script.RenderError, match="other environment variables changed"):
        script.apply(meddling_api, service.probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0)


# ------------------------------------------------------------------ activating the change


def test_a_saved_value_is_activated_by_redeploying_the_running_commit(script: Any) -> None:
    """The defect that failed run #1, and the operation Render actually requires.

    Saving is not enough: the service reads its configuration when the process starts, and Render's
    dashboard says a saved variable is unused "until its next deploy". A restart is not enough
    either — it is documented to reuse "the exact same Git commit **and configuration** as the
    running instance", which is why run #1 waited nine times after restarting for a change a
    restart is defined never to apply.
    """
    service = FakeService()
    assert _apply(script, service) == 0
    assert len(service.created) == 1, "the change was not activated by exactly one deploy"
    assert service.restarts == 0, "the operation still restarts the service"
    assert script.preflight_allows(service.probe, BASE_URL, ORIGIN)


def test_the_redeploy_is_pinned_to_the_commit_already_running(script: Any) -> None:
    """Pinning is what keeps this from being a release.

    An unpinned deploy takes the branch tip, which may be a commit whose migrations have not run —
    the ordering `release.yml` exists to guarantee. So the commit is read from the service's live
    deploy, and `deployMode: deploy_only` skips the rebuild: the same code, started again with the
    configuration it now has.
    """
    service = FakeService()
    _apply(script, service)
    assert service.created == [
        {"commitId": LIVE_COMMIT, "clearCache": "do_not_clear", "deployMode": "deploy_only"}
    ]


def test_a_service_with_no_live_commit_is_not_deployed(script: Any) -> None:
    """Refusing beats falling back to "latest", which is how an unmigrated commit reaches production."""
    service = FakeService(deploys=[{"id": "dep-x", "status": "live", "commit": {}}])
    with pytest.raises(script.RenderError, match="names no commit"):
        _apply(script, service)
    assert not service.created


def test_no_live_deploy_at_all_is_not_deployed(script: Any) -> None:
    service = FakeService(deploys=[{"id": "dep-x", "status": "build_failed"}])
    with pytest.raises(script.RenderError, match="no live deploy"):
        _apply(script, service)
    assert not service.created


def test_a_rejected_deploy_mode_falls_back_to_a_rebuild(script: Any) -> None:
    """The field is documented but not worth failing the operation over."""
    service = FakeService(reject_deploy_mode=True)
    assert _apply(script, service) == 0
    assert service.created == [{"commitId": LIVE_COMMIT, "clearCache": "do_not_clear"}]


def test_the_run_waits_for_the_deploy_to_be_live_before_verifying(script: Any) -> None:
    """It waits on *this* deploy's status, not on a sleep.

    Checking the origin while the old process is still serving would report the failure this whole
    operation exists to remove — and checking after an arbitrary delay would pass or fail depending
    on how busy Render was.
    """
    service = FakeService(progression=["queued", "build_in_progress", "update_in_progress", "live"])
    asked: list[str] = []

    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        asked.append(f"{method} {service.deploys[0]['status']}")
        return service.probe(method, url, headers)

    assert (
        script.apply(
            service.api,
            probe,
            SERVICE_ID,
            BASE_URL,
            ORIGIN,
            attempts=2,
            pause=0,
            deploy_attempts=6,
        )
        == 0
    )
    after_start = asked[1:]
    assert after_start, "production was never asked again after the deploy"
    assert all("live" in entry for entry in after_start), (
        f"production was verified before the deploy was live: {asked}"
    )


@pytest.mark.parametrize(
    "outcome", ["build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"]
)
def test_a_deploy_that_does_not_go_live_fails_closed(script: Any, outcome: str) -> None:
    """Including `deactivated`: another deploy superseded ours, so waiting longer proves nothing."""
    service = FakeService(progression=[outcome])
    with pytest.raises(script.RenderError, match=f"ended as {outcome}"):
        _apply(script, service)


def test_a_deploy_that_never_finishes_fails_closed(script: Any) -> None:
    """A timeout must not be reported as a success, and must not wait forever either."""
    service = FakeService(progression=["build_in_progress"])
    with pytest.raises(script.RenderError, match="did not become live in time"):
        _apply(script, service)


def test_a_deploy_already_in_flight_is_awaited_rather_than_duplicated(script: Any) -> None:
    """Two deploys queued behind each other is the wasteful, confusing outcome to avoid.

    The one already running may well carry the new configuration — it was started after the value
    was saved — so it is waited for and then production is asked again.
    """
    service = FakeService(
        deploys=[
            {"id": "dep-inflight", "status": "update_in_progress", "commit": {"id": LIVE_COMMIT}},
            {"id": "dep-live", "status": "live", "commit": {"id": LIVE_COMMIT}},
        ]
    )

    reads = {"count": 0}
    original = service.api

    def api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        result = original(method, path, body)
        if method == "GET" and path.split("?")[0].endswith("/deploys"):
            reads["count"] += 1
            if reads["count"] >= 2:
                service.deploys[0]["status"] = "live"
                service.booted = dict(service.env)
        return result

    assert (
        script.apply(
            api, service.probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=2, pause=0, deploy_attempts=6
        )
        == 0
    )
    assert not service.created, "a second deploy was started while one was in flight"


def test_a_service_that_never_accepts_the_origin_fails(script: Any) -> None:
    service = FakeService()

    def refusing_probe(
        method: str, url: str, headers: dict[str, str]
    ) -> tuple[int, dict[str, str]]:
        if method == "GET":
            return 200, {}
        return 400, {}

    with pytest.raises(script.RenderError, match="production still refuses it"):
        script.apply(
            service.api,
            refusing_probe,
            SERVICE_ID,
            BASE_URL,
            ORIGIN,
            attempts=1,
            pause=0,
            deploy_attempts=6,
        )


def test_the_health_endpoint_is_checked(script: Any) -> None:
    """The same endpoint `release.yml` verifies a release against."""
    service = FakeService()
    asked: list[str] = []

    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        asked.append(f"{method} {url}")
        return service.probe(method, url, headers)

    assert (
        script.apply(
            service.api,
            probe,
            SERVICE_ID,
            BASE_URL,
            ORIGIN,
            attempts=1,
            pause=0,
            deploy_attempts=6,
        )
        == 0
    )
    assert f"GET {BASE_URL}/api/v1/health" in asked


def test_an_unhealthy_backend_fails_the_run(script: Any) -> None:
    service = FakeService()

    def unhealthy(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "GET":
            return 503, {}
        return service.probe(method, url, headers)

    with pytest.raises(script.RenderError, match=r"healthy after the redeploy|answered 503"):
        script.apply(
            service.api,
            unhealthy,
            SERVICE_ID,
            BASE_URL,
            ORIGIN,
            attempts=1,
            pause=0,
            deploy_attempts=6,
        )


def test_the_preflight_asks_with_exactly_the_canonical_origin(script: Any) -> None:
    """A check that asked with a different origin, or without the header, would prove nothing."""
    service = FakeService()
    asked: list[dict[str, str]] = []

    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "OPTIONS":
            asked.append(headers)
        return service.probe(method, url, headers)

    script.apply(
        service.api, probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0, deploy_attempts=6
    )
    assert asked, "no preflight was sent"
    for headers in asked:
        assert headers["Origin"] == ORIGIN
        assert headers["Access-Control-Request-Method"] == "GET"
        assert headers["Access-Control-Request-Headers"] == "authorization"


def test_an_allow_origin_for_a_different_origin_does_not_pass(script: Any) -> None:
    """`Access-Control-Allow-Origin` has to name the origin that was asked about."""

    def wrong_origin(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "OPTIONS":
            return 200, {"access-control-allow-origin": "http://localhost:3000"}
        return 200, {}

    assert not script.preflight_allows(wrong_origin, BASE_URL, ORIGIN)


# ------------------------------------------------------------------ the credential


def test_nothing_secret_reaches_the_output(script: Any, capsys: pytest.CaptureFixture[str]) -> None:
    """The API key, the origin list, and every other variable's value stay out of the log.

    An Actions log on a public repository is readable by anyone, and this run holds the most
    powerful credential in the store — an account-scoped Render key — alongside the database URLs
    it just read in order to prove it had not changed them.
    """
    service = FakeService()
    assert _apply(script, service) == 0
    printed = "".join(capsys.readouterr())
    for value in EXISTING.values():
        assert str(value) not in printed, "a variable's value was printed"
    assert "or-key" not in printed
    assert ORIGIN in printed, "the run does not say which origin it added"


def test_the_api_key_is_never_named_on_a_command_line(script: Any, repo_root: Path) -> None:
    """It reaches the process through the environment, so no argument list can carry it."""
    source = (repo_root / SCRIPT).read_text()
    assert 'os.environ.get("RENDER_API_KEY"' in source
    assert "--token" not in source and "--api-key" not in source
    assert 'add_argument("--origin"' in source


def test_a_missing_credential_stops_before_any_request(
    script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    monkeypatch.delenv("RENDER_SERVICE_ID", raising=False)
    assert script.main(["--origin", ORIGIN, "--base-url", BASE_URL]) == 1


def test_the_log_reports_counts_that_prove_nothing_was_lost(
    script: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    """Counts, never values — and enough of them to audit the run from the log alone.

    A public Actions log may not carry anyone's configuration, but "the service holds 5
    environment variables and the list has 2 origins" carries none of it and answers the two
    questions worth asking after a change: did anything disappear, and is the list the length it
    should be.
    """
    service = FakeService()
    assert _apply(script, service) == 0
    printed = "".join(capsys.readouterr())
    assert f"the service holds {len(EXISTING)} environment variables" in printed
    assert "lists 1 origins" in printed, "the log does not say how many origins were configured"
    assert "1 origins before, 2 after" in printed
    for value in EXISTING.values():
        assert str(value) not in printed


def test_an_already_configured_origin_is_reported_as_being_present_once(
    script: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": f"http://localhost:3000,{ORIGIN}"})
    assert _apply(script, service) == 0
    printed = "".join(capsys.readouterr())
    assert "already allows the origin exactly once" in printed
    assert "lists 2 origins" in printed
    assert not service.created, "production was deployed although the origin was already active"


def test_a_duplicated_origin_is_refused_rather_than_added_to(script: Any) -> None:
    """A duplicate means an earlier write went wrong, and appending again would compound it."""
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": f"{ORIGIN},{ORIGIN}"})
    with pytest.raises(script.RenderError, match="configured 2 times"):
        _apply(script, service)
    assert not _writes(service)


def test_the_deploy_it_started_is_named_in_the_log(
    script: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    """Which revision was restarted, and which deploy did it: both public, both auditable."""
    service = FakeService()
    assert _apply(script, service) == 0
    printed = "".join(capsys.readouterr())
    assert f"the live commit is {LIVE_COMMIT[:12]}" in printed
    assert "started deploy dep-1" in printed
