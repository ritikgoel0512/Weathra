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


@pytest.fixture(scope="module")
def script(repo_root: Path) -> Any:
    path = repo_root / SCRIPT
    assert path.is_file(), f"{SCRIPT} is missing: no origin can be allowed"
    spec = importlib.util.spec_from_file_location("weathra_render_allowed_origin", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeService:
    """A Render service, and a running container that only reflects what it booted with."""

    def __init__(
        self,
        env: dict[str, Any] | None = None,
        *,
        reflects_immediately: bool = True,
        fail_get: bool = False,
        fail_put: bool = False,
        malformed: Any = None,
        page_size: int | None = None,
    ) -> None:
        self.env: dict[str, Any] = dict(EXISTING if env is None else env)
        self.booted: dict[str, Any] = dict(self.env)
        self.reflects = reflects_immediately
        self.fail_get = fail_get
        self.fail_put = fail_put
        self.malformed = malformed
        self.page_size = page_size
        self.calls: list[tuple[str, str]] = []
        self.restarts = 0

    def api(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        self.calls.append((method, path.split("?")[0]))
        if method == "GET":
            if self.fail_get:
                raise RuntimeError("Render refused the API key")
            if self.malformed is not None:
                return self.malformed
            entries = [
                {"envVar": {"key": key, "value": value}, "cursor": f"c{index}"}
                for index, (key, value) in enumerate(sorted(self.env.items()))
            ]
            size = self.page_size or len(entries) + 1
            cursor = None
            if "cursor=" in path:
                cursor = path.split("cursor=")[1].split("&")[0]
            start = (
                0
                if cursor is None
                else next(
                    index + 1 for index, entry in enumerate(entries) if entry["cursor"] == cursor
                )
            )
            return entries[start : start + size]
        if method == "PUT":
            if self.fail_put:
                raise RuntimeError("Render answered 500")
            assert body is not None
            self.env[path.rsplit("/", 1)[1]] = body["value"]
            return {"key": path.rsplit("/", 1)[1], "value": body["value"]}
        if method == "POST" and path.endswith("/restart"):
            self.restarts += 1
            self.booted = dict(self.env)
            return None
        raise AssertionError(f"unexpected call: {method} {path}")

    def probe(self, method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        effective = self.env if self.reflects else self.booted
        if method == "GET":
            return 200, {}
        allowed = [
            part.strip()
            for part in str(effective["CORS_ALLOWED_ORIGINS"]).split(",")
            if part.strip()
        ]
        origin = headers["Origin"]
        if origin.rstrip("/") in [entry.rstrip("/") for entry in allowed]:
            return 200, {"access-control-allow-origin": origin}
        # Starlette's answer to a disallowed origin: 400, and no allow-origin header at all.
        return 400, {"access-control-allow-methods": "GET, POST"}


def _apply(script: Any, service: FakeService, origin: str = ORIGIN) -> int:
    exit_code: int = script.apply(
        service.api, service.probe, SERVICE_ID, BASE_URL, origin, attempts=2, pause=0
    )
    return exit_code


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
    writes = [(method, path) for method, path in service.calls if method != "GET"]
    assert writes == [("PUT", f"/services/{SERVICE_ID}/env-vars/CORS_ALLOWED_ORIGINS")]


def test_a_second_run_changes_nothing(script: Any) -> None:
    """Idempotent, and specifically: no write, so no restart of production for nothing."""
    service = FakeService()
    assert _apply(script, service) == 0
    stored = service.env["CORS_ALLOWED_ORIGINS"]
    service.calls.clear()
    assert _apply(script, service) == 0
    assert service.env["CORS_ALLOWED_ORIGINS"] == stored
    assert not [call for call in service.calls if call[0] != "GET"], "a second run wrote to Render"
    assert service.restarts == 0


@pytest.mark.parametrize(
    "configured",
    [
        ORIGIN,
        f"{ORIGIN}/",
        f"http://localhost:3000,{ORIGIN}",
        f" {ORIGIN} ,http://localhost:3000",
    ],
)
def test_an_origin_already_allowed_in_any_spelling_is_not_duplicated(
    script: Any, configured: str
) -> None:
    """A trailing slash or surrounding whitespace is not a different origin.

    Comparison is normalised for exactly those and nothing else; nothing already configured is
    rewritten, because rewriting an entry is a change to an origin this operation was asked to
    preserve.
    """
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": configured})
    assert _apply(script, service) == 0
    assert service.env["CORS_ALLOWED_ORIGINS"] == configured
    assert not [call for call in service.calls if call[0] != "GET"]


def test_a_differently_cased_entry_does_not_count_as_the_origin(script: Any) -> None:
    """Case is deliberately *not* normalised, and this is the test that found out why.

    The backend's CORS middleware compares the browser's `Origin` header against the configured
    list as exact strings, and browsers send the scheme and host lower-cased. So an entry spelled
    `https://WEATHRA-BICE.vercel.app` never matches anything: treating it as an equivalent
    spelling would skip the addition and leave production refusing the origin — while every check
    short of a real preflight reported success.
    """
    miscased = "https://WEATHRA-BICE.vercel.app"
    service = FakeService({**EXISTING, "CORS_ALLOWED_ORIGINS": miscased})
    assert _apply(script, service) == 0
    assert script.parse_origins(service.env["CORS_ALLOWED_ORIGINS"]) == [miscased, ORIGIN]


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
    assert not [call for call in service.calls if call[0] != "GET"]


def test_a_failed_read_changes_nothing(script: Any) -> None:
    service = FakeService(fail_get=True)
    with pytest.raises(RuntimeError):
        _apply(script, service)
    assert not [call for call in service.calls if call[0] != "GET"]


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
    assert not [call for call in service.calls if call[0] != "GET"]


def test_a_failed_update_is_reported(script: Any) -> None:
    service = FakeService(fail_put=True)
    with pytest.raises(RuntimeError):
        _apply(script, service)
    assert service.env["CORS_ALLOWED_ORIGINS"] == EXISTING["CORS_ALLOWED_ORIGINS"]


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


# ------------------------------------------------------------------ proving it took effect


def test_a_saved_value_that_is_not_in_force_restarts_the_service_once(script: Any) -> None:
    """The case that would otherwise be reported as success.

    The backend reads its configuration at start-up, so a container that booted with the old list
    keeps refusing the origin however correct Render's stored value is. A restart re-reads
    configuration and keeps serving the same release — it deploys nothing.
    """
    service = FakeService(reflects_immediately=False)
    assert _apply(script, service) == 0
    assert service.restarts == 1
    assert script.preflight_allows(service.probe, BASE_URL, ORIGIN)


def test_a_service_that_never_accepts_the_origin_fails(script: Any) -> None:
    service = FakeService()

    def refusing_probe(
        method: str, url: str, headers: dict[str, str]
    ) -> tuple[int, dict[str, str]]:
        if method == "GET":
            return 200, {}
        return 400, {}

    with pytest.raises(script.RenderError, match="production still refuses it"):
        script.apply(service.api, refusing_probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0)


def test_the_health_endpoint_is_checked(script: Any) -> None:
    """The same endpoint `release.yml` verifies a release against."""
    service = FakeService()
    asked: list[str] = []

    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        asked.append(f"{method} {url}")
        return service.probe(method, url, headers)

    assert script.apply(service.api, probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0) == 0
    assert f"GET {BASE_URL}/api/v1/health" in asked


def test_an_unhealthy_backend_fails_the_run(script: Any) -> None:
    service = FakeService()

    def unhealthy(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "GET":
            return 503, {}
        return service.probe(method, url, headers)

    with pytest.raises(script.RenderError, match="health endpoint answered 503"):
        script.apply(service.api, unhealthy, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0)


def test_the_preflight_asks_with_exactly_the_canonical_origin(script: Any) -> None:
    """A check that asked with a different origin, or without the header, would prove nothing."""
    service = FakeService()
    asked: list[dict[str, str]] = []

    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        if method == "OPTIONS":
            asked.append(headers)
        return service.probe(method, url, headers)

    script.apply(service.api, probe, SERVICE_ID, BASE_URL, ORIGIN, attempts=1, pause=0)
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
    service = FakeService(reflects_immediately=False)
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
