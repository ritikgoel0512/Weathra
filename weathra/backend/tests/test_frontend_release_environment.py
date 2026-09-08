"""Task 23.5 — the script that stands in for `vercel pull`, and every way it must fail closed.

`frontend-release.yml` no longer runs `vercel pull`. It cannot: Vercel CLI 59.11.7 resolves the
project fine and then calls `getOrgById` — `GET /v2/teams/<team_id>` — unconditionally, and this
pipeline's team-scoped token is refused there with 403 `team_unauthorized`, reported as the
misleading "Could not retrieve Project Settings … remove the `.vercel` directory". `vercel deploy`
tolerates that refusal, `vercel pull` does not, and no flag changes it.

`.github/scripts/vercel_release_env.py` writes the two files `pull` would have written, from the
project-scoped API the token can reach. That moves a piece of the release out of the CLI and into
this repository, so the properties the CLI used to be trusted with are asserted here instead:

1. **The environment is complete or the release stops.** Next.js inlines `NEXT_PUBLIC_` values at
   build time. A missing one does not fail the build — it produces a bundle that deploys, promotes,
   and then cannot reach Supabase from a browser. Every partial answer therefore ends the run:
   a refused token, a malformed body, an unreadable value, a missing public value.
2. **Nothing crosses the credential boundary.** The frontend may hold public configuration and
   nothing else. A backend secret configured on the Vercel project, or the release token itself,
   must not reach a build environment — and no value may reach a log.
3. **The files say what the API said.** `project.json`'s `orgId` is the owner the API reported, not
   the one we expected, which is what makes the workflow's check on that file a real second gate.
4. **Values survive the round trip.** The env file is parsed by dotenv, which expands `\\n` inside a
   quoted value and does not unescape `\\"`. A value that cannot be written faithfully ends the run
   rather than reaching the build altered.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import urllib.error
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

SCRIPT = ".github/scripts/vercel_release_env.py"

PROJECT_ID = "prj_weathra_frontend"
ORG_ID = "team_weathra"

# What a healthy Vercel project holds for this frontend: the three public values, and nothing else.
PUBLIC_ENVIRONMENT = {
    "NEXT_PUBLIC_SUPABASE_URL": "https://weathra.supabase.co",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon-key",
    "NEXT_PUBLIC_API_BASE_URL": "https://weathra-backend.onrender.com",
}


@pytest.fixture(scope="module")
def script(repo_root: Path) -> Any:
    """The release script, imported from its path — it lives beside the workflow, not in a package."""
    path = repo_root / SCRIPT
    assert path.is_file(), f"{SCRIPT} is missing: the frontend release cannot resolve its project"
    spec = importlib.util.spec_from_file_location("weathra_vercel_release_env", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _project(**overrides: Any) -> dict[str, Any]:
    project = {
        "id": PROJECT_ID,
        "name": "weathra",
        "accountId": ORG_ID,
        "framework": "nextjs",
        "rootDirectory": "weathra/frontend",
        "nodeVersion": "22.x",
        "createdAt": 1700000000000,
        "buildCommand": None,
        "directoryListing": False,
    }
    project.update(overrides)
    return project


def _records(values: dict[str, str], **overrides: Any) -> list[dict[str, Any]]:
    return [
        {"key": key, "value": value, "target": ["production"], "type": "encrypted", **overrides}
        for key, value in values.items()
    ]


def _fetcher(
    project: dict[str, Any] | None = None,
    records: list[dict[str, Any]] | None = None,
    *,
    seen: list[str] | None = None,
) -> Callable[[str], Any]:
    """A stand-in for the API reader, recording every path it is asked for."""

    def fetch(path: str) -> Any:
        if seen is not None:
            seen.append(path)
        if "/env" in path:
            return {"envs": records if records is not None else _records(PUBLIC_ENVIRONMENT)}
        return project if project is not None else _project()

    return fetch


def _parse_dotenv(text: str) -> dict[str, str]:
    """dotenv's semantics, as `vercel build` applies them to the file this script writes.

    Quotes are stripped and `\\n`/`\\r` are expanded inside them; nothing else is unescaped. Reading
    the file back through the same rules the build uses is the only way to assert a value survived.
    """
    found: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, _, raw = stripped.partition("=")
        if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
            raw = raw[1:-1].replace("\\n", "\n").replace("\\r", "\r")
        found[key.strip()] = raw
    return found


# ------------------------------------------------------------------ the files it writes


def test_the_project_link_is_what_the_cli_would_have_written(script: Any) -> None:
    """`vercel build` reads this file instead of asking the API, so it has to be the same file.

    `rootDirectory` is the load-bearing field: it is what makes a build invoked from the repository
    root build `weathra/frontend`. `projectName` matters almost as much — with it present,
    `vercel deploy --prebuilt` resolves the project from disk and never issues the lookup this
    token is refused on.
    """
    link = script.project_link(_project())
    assert link["projectId"] == PROJECT_ID
    assert link["projectName"] == "weathra"
    assert link["settings"]["rootDirectory"] == "weathra/frontend"
    assert link["settings"]["framework"] == "nextjs"
    # Absent settings are omitted rather than written as null, matching `writeProjectSettings`.
    assert "buildCommand" not in link["settings"]
    assert link["settings"]["directoryListing"] is False


def test_the_link_records_the_owner_the_api_reported(script: Any) -> None:
    """Not the owner we expected — the one the project named.

    If this took `orgId` from `WEATHRA_VERCEL_ORG_ID`, the workflow's check on the file would be
    comparing an input against itself and would pass for a project owned by anyone.
    """
    link = script.project_link(_project(accountId="team_someone_else"))
    assert link["orgId"] == "team_someone_else"


def test_the_files_land_where_the_cli_looks_for_them(script: Any, tmp_path: Path) -> None:
    """`.vercel/project.json` and `.vercel/.env.production.local`, in the build's directory.

    The CLI resolves both against the directory it was invoked from, which is why the workflow runs
    the script, the build and the deploy from the repository root.
    """
    assert script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher()) == 0
    link = json.loads((tmp_path / ".vercel" / "project.json").read_text())
    assert link["projectId"] == PROJECT_ID
    environment = _parse_dotenv((tmp_path / ".vercel" / ".env.production.local").read_text())
    assert environment == PUBLIC_ENVIRONMENT
    assert (tmp_path / ".vercel" / ".env.production.local").stat().st_mode & 0o077 == 0


def test_the_environment_comes_from_the_project_scoped_api(script: Any, tmp_path: Path) -> None:
    """Two project-scoped reads, and nothing that needs the team or the user.

    This is the whole fix: `/v9/projects/<id>` and its `/env` collection are reachable with a
    team-scoped token, and `GET /v2/teams/<id>` — the request `vercel pull` cannot avoid — is
    never made.
    """
    seen: list[str] = []
    assert script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher(seen=seen)) == 0
    assert seen[0] == f"/v9/projects/{PROJECT_ID}"
    assert any(path.startswith(f"/v9/projects/{PROJECT_ID}/env?decrypt=true") for path in seen)
    for path in seen:
        assert "/v2/teams" not in path, f"the release asks for the team it cannot read: {path}"
        assert "/v2/user" not in path, f"the release asks for the user it cannot read: {path}"


def test_it_follows_the_environment_listing_to_the_end(script: Any) -> None:
    """A truncated first page read as the whole environment is the silent partial it must not build."""
    pages = [
        {
            "envs": _records({"NEXT_PUBLIC_SUPABASE_URL": "https://weathra.supabase.co"}),
            "pagination": {"next": 1700000000000},
        },
        {
            "envs": _records(
                {
                    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon-key",
                    "NEXT_PUBLIC_API_BASE_URL": "https://weathra-backend.onrender.com",
                }
            ),
            "pagination": {"next": None},
        },
    ]
    calls: list[str] = []

    def fetch(path: str) -> Any:
        calls.append(path)
        return pages[len(calls) - 1]

    records = script.read_env_records(fetch, PROJECT_ID)
    assert len(records) == 3
    assert "until=" in calls[1]
    assert script.production_environment(records) == PUBLIC_ENVIRONMENT


def test_an_endless_listing_ends_the_release(script: Any) -> None:
    def fetch(_: str) -> Any:
        return {"envs": [], "pagination": {"next": 1}}

    with pytest.raises(script.ReleaseError, match="paginated further"):
        script.read_env_records(fetch, PROJECT_ID, pages=3)


# ------------------------------------------------------------------ ownership


def test_a_project_owned_by_another_team_is_never_built(script: Any, tmp_path: Path) -> None:
    """The assertion the old pipeline asked `vercel pull` for and never got an answer to.

    It has to fail *before* anything is written, so that a wrong project cannot leave a link on
    disk for the build to pick up.
    """
    with pytest.raises(script.ReleaseError, match="not owned by the team"):
        script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher(_project(accountId="team_other")))
    assert not (tmp_path / ".vercel").exists(), (
        "a project owned by another team left a link on disk for the build to use"
    )


def test_a_project_with_no_owner_is_never_built(script: Any) -> None:
    """An answer that cannot be checked is not an answer to build on."""
    with pytest.raises(script.ReleaseError, match="no accountId"):
        script.read_project(_fetcher(_project(accountId=None)), PROJECT_ID)


def test_the_two_ids_are_never_printed(
    script: Any, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(script.ReleaseError):
        script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher(_project(accountId="team_other")))
    captured = capsys.readouterr()
    assert "team_other" not in captured.out + captured.err
    assert ORG_ID not in captured.out + captured.err


# ------------------------------------------------------------------ failing closed


@pytest.mark.parametrize(
    ("status", "expected"),
    [(401, "refused the release token"), (403, "does not cover this project")],
)
def test_a_refused_token_ends_the_release(
    script: Any, status: int, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The two answers a credential problem arrives as, each said plainly.

    The message matters as much as the exit code here: the three runs this pipeline lost were lost
    to a CLI reporting a 403 on a team lookup as a stale `.vercel` directory.
    """

    def urlopen(*_: Any, **__: Any) -> Any:
        raise urllib.error.HTTPError(
            "https://api.vercel.com",
            status,
            "denied",
            {},  # type: ignore[arg-type]
            io.BytesIO(b'{"error":{"code":"forbidden"}}'),
        )

    monkeypatch.setattr(script.urllib.request, "urlopen", urlopen)
    with pytest.raises(script.ReleaseError, match=expected):
        script.make_fetch_json("t", attempts=1, pause=0)("/v9/projects/x")


def test_a_server_error_is_retried_then_fails(script: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[int] = []

    def urlopen(*_: Any, **__: Any) -> Any:
        attempts.append(1)
        raise urllib.error.HTTPError(
            "https://api.vercel.com",
            503,
            "unavailable",
            {},  # type: ignore[arg-type]
            None,
        )

    monkeypatch.setattr(script.urllib.request, "urlopen", urlopen)
    with pytest.raises(script.ReleaseError, match="503"):
        script.make_fetch_json("t", attempts=3, pause=0)("/v9/projects/x")
    assert len(attempts) == 3, "a transient failure was not retried"


@pytest.mark.parametrize(
    "payload",
    [
        "not an object",
        {"envs": "not a list"},
        {},
    ],
)
def test_a_malformed_environment_response_ends_the_release(script: Any, payload: Any) -> None:
    with pytest.raises(script.ReleaseError):
        script.read_env_records(lambda _: payload, PROJECT_ID)


@pytest.mark.parametrize(
    "record",
    [
        "not an object",
        {"value": "no key", "target": ["production"]},
        {"key": "NEXT_PUBLIC_API_BASE_URL", "value": 7, "target": ["production"]},
    ],
)
def test_a_malformed_record_ends_the_release(script: Any, record: Any) -> None:
    with pytest.raises(script.ReleaseError):
        script.production_environment([record])


def test_a_malformed_project_response_ends_the_release(script: Any) -> None:
    with pytest.raises(script.ReleaseError, match="did not return a project"):
        script.read_project(lambda _: {"nothing": True}, PROJECT_ID)


def test_a_body_that_is_not_json_ends_the_release(
    script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Response:
        status = 200

        def read(self) -> bytes:
            return b"<html>gateway</html>"

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_: Any) -> None:
            return None

    monkeypatch.setattr(script.urllib.request, "urlopen", lambda *_, **__: Response())
    with pytest.raises(script.ReleaseError, match="not JSON"):
        script.make_fetch_json("t", attempts=1, pause=0)("/v9/projects/x")


@pytest.mark.parametrize(
    "record",
    [
        {"key": "NEXT_PUBLIC_API_BASE_URL", "value": None, "target": ["production"]},
        {
            "key": "NEXT_PUBLIC_API_BASE_URL",
            "value": None,
            "type": "sensitive",
            "target": ["production"],
        },
    ],
)
def test_a_value_that_cannot_be_read_ends_the_release(script: Any, record: Any) -> None:
    """An unreadable Production variable is not one this script may skip.

    Skipping it would produce a bundle missing exactly one public value — which builds, deploys,
    promotes, and then fails in a browser.
    """
    with pytest.raises(script.ReleaseError, match="cannot be read"):
        script.production_environment([record])


@pytest.mark.parametrize(
    "missing",
    ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_API_BASE_URL"],
)
def test_a_missing_public_value_ends_the_release(script: Any, missing: str) -> None:
    remaining = {key: value for key, value in PUBLIC_ENVIRONMENT.items() if key != missing}
    with pytest.raises(script.ReleaseError, match="missing"):
        script.production_environment(_records(remaining))


def test_either_supabase_client_key_name_satisfies_the_requirement(script: Any) -> None:
    """The project may hold the publishable key or the anon key it replaces."""
    swapped = {
        "NEXT_PUBLIC_SUPABASE_URL": "https://weathra.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_x",
        "NEXT_PUBLIC_API_BASE_URL": "https://weathra-backend.onrender.com",
    }
    assert script.production_environment(_records(swapped)) == swapped


def test_two_values_for_one_name_end_the_release(script: Any) -> None:
    records = [
        *_records(PUBLIC_ENVIRONMENT),
        {
            "key": "NEXT_PUBLIC_API_BASE_URL",
            "value": "https://elsewhere.example",
            "target": ["production"],
        },
    ]
    with pytest.raises(script.ReleaseError, match="two different values"):
        script.production_environment(records)


# ------------------------------------------------------------------ the credential boundary


@pytest.mark.parametrize(
    "name",
    [
        "DATABASE_URL",
        "DATABASE_URL_PRIVILEGED",
        "SUPABASE_SERVICE_ROLE_KEY",
        "WEATHRA_PRIVILEGED_SERVICE_ROLE_KEY",
        "OPENROUTER_API_KEY",
        "RENDER_API_KEY",
        "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
        "PEXELS_API_KEY",
    ],
)
def test_a_backend_secret_on_the_project_ends_the_release(script: Any, name: str) -> None:
    """The frontend may hold public configuration and nothing else.

    Same policy as `frontend/scripts/secret-containment.ts`, applied one step earlier: to the
    environment the build is handed rather than to the bundle it produced. The `NEXT_PUBLIC_`
    variant is on the list because the prefix is the mechanism — it is a configuration that
    *works*, and publishes a Row-Level-Security-bypassing credential to every visitor.
    """
    poisoned = dict(PUBLIC_ENVIRONMENT) | {name: "secret"}
    with pytest.raises(script.ReleaseError, match="backend secret"):
        script.production_environment(_records(poisoned))


def test_the_release_token_never_reaches_the_build_environment(
    script: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one credential this job holds, and the one place it must never be written.

    A token in the build environment reaches the build's logs, and a `NEXT_PUBLIC_` prefix would
    reach browsers. Both halves are checked: the name is refused, and the value never appears in
    what is written.
    """
    with pytest.raises(script.ReleaseError, match="backend secret"):
        script.production_environment(_records(dict(PUBLIC_ENVIRONMENT) | {"VERCEL_TOKEN": "t"}))

    monkeypatch.setenv("VERCEL_TOKEN", "vercel-release-token-value")
    assert script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher()) == 0
    written = (tmp_path / ".vercel" / ".env.production.local").read_text()
    written += (tmp_path / ".vercel" / "project.json").read_text()
    assert "vercel-release-token-value" not in written
    assert "VERCEL_TOKEN" not in written


def test_the_branch_and_custom_environment_overrides_are_left_out(script: Any) -> None:
    """Production means production: not a branch override, and not a custom environment.

    Both carry the `production` target while applying somewhere else, so a filter that read the
    target alone would build the wrong configuration.
    """
    records = [
        *_records(PUBLIC_ENVIRONMENT),
        {
            "key": "NEXT_PUBLIC_API_BASE_URL",
            "value": "https://staging.example",
            "target": ["production"],
            "gitBranch": "staging",
        },
        {
            "key": "NEXT_PUBLIC_SUPABASE_URL",
            "value": "https://custom.example",
            "target": ["production"],
            "customEnvironmentIds": ["env_1"],
        },
        {"key": "PREVIEW_ONLY", "value": "x", "target": ["preview"]},
        {"key": "VERCEL_ANALYTICS_ID", "value": "a", "target": ["production"]},
    ]
    assert script.production_environment(records) == PUBLIC_ENVIRONMENT


def test_no_value_is_ever_printed(
    script: Any, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Names in the log, values never.

    Which variables the build will see is worth reading in a log; what they are is not, and a
    public repository's Actions log is readable by anyone.
    """
    assert script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher()) == 0
    captured = capsys.readouterr()
    printed = captured.out + captured.err
    for name, value in PUBLIC_ENVIRONMENT.items():
        assert name in printed, f"{name} is not reported, so a missing one would be invisible"
        assert value not in printed, f"the value of {name} was printed"


# ------------------------------------------------------------------ serialisation


def test_the_env_file_matches_the_cli_s_own_format(script: Any) -> None:
    """`vercel build` parses this with dotenv, so the format is not ours to choose.

    Sorted `KEY="value"` lines, newlines escaped — the serialisation `vercel env pull` writes.
    """
    text = script.serialize_env({"B_KEY": "two", "A_KEY": "one"})
    body = [line for line in text.splitlines() if not line.startswith("#")]
    assert body == ['A_KEY="one"', 'B_KEY="two"']


@pytest.mark.parametrize(
    "value",
    [
        "plain",
        "with spaces",
        "with # hash",
        "with = equals",
        "trailing space ",
        "$SHELL ${expansion} `backtick`",
        "line one\nline two",
        "carriage\rreturn",
        "unicode — ✅ 天気",
        "opaque.token-like_value-with.dots_and-dashes",
        "",
    ],
)
def test_a_value_survives_the_round_trip(script: Any, value: str) -> None:
    """Read back through dotenv's own rules, because that is what the build will do.

    Shell metacharacters are in this list deliberately: nothing interpolates these values, so a
    value containing `$(...)` is data both here and in the build.
    """
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_APP_URL": value}
    parsed = _parse_dotenv(script.serialize_env(environment))
    assert parsed["NEXT_PUBLIC_APP_URL"] == value
    assert parsed == environment


@pytest.mark.parametrize("value", ['quoted "thing"', "back\\slash"])
def test_a_value_that_cannot_be_written_faithfully_ends_the_release(
    script: Any, value: str
) -> None:
    """dotenv does not unescape `\\"` and does expand `\\n`, so neither character round-trips.

    Refusing is the honest outcome: a silently altered Supabase key is a production frontend that
    cannot sign anyone in, and it would look like a successful release.
    """
    with pytest.raises(script.ReleaseError, match=r"cannot be written|reinterpret"):
        script.serialize_env({"NEXT_PUBLIC_APP_URL": value})


def test_a_name_that_is_not_a_variable_ends_the_release(script: Any) -> None:
    with pytest.raises(script.ReleaseError, match="not a usable variable name"):
        script.production_environment(_records(dict(PUBLIC_ENVIRONMENT) | {"NOT A NAME": "x"}))


def test_a_missing_token_ends_the_release(script: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed on the credential too, rather than issuing an unauthenticated request."""
    monkeypatch.delenv("VERCEL_TOKEN", raising=False)
    assert script.main(["--project-id", PROJECT_ID, "--expect-org-id", ORG_ID]) == 1


def test_a_padded_token_is_still_usable(script: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """A secret pasted with a trailing newline is a real failure mode, and a silent one.

    It was one of the three candidates while this was being diagnosed. Stripping it here costs
    nothing and removes it as an explanation for a future failure.
    """
    monkeypatch.setenv("VERCEL_TOKEN", "  token\n")
    sent: list[str] = []

    class Response:
        status = 200

        def read(self) -> bytes:
            return json.dumps(_project()).encode()

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_: Any) -> None:
            return None

    def urlopen(request: Any, **__: Any) -> Any:
        sent.append(request.get_header("Authorization"))
        return Response()

    monkeypatch.setattr(script.urllib.request, "urlopen", urlopen)
    script.make_fetch_json(script.os.environ["VERCEL_TOKEN"].strip())("/v9/projects/x")
    assert sent == ["Bearer token"]


# ------------------------------------------------------------------ the URL shape


@pytest.mark.parametrize(
    "value",
    [
        "https://aydhqrzzlqrzdycngfbe.supabase.co",
        "https://project.supabase.co/",
        "HTTPS://project.supabase.co",
        "http://localhost:8000",
        "http://backend.internal:8000/api",
    ],
)
def test_a_usable_url_passes(script: Any, value: str) -> None:
    """https and http both, because both are legitimate here.

    `frontend/.env.example` documents `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`, and a
    self-hosted Supabase or a staging backend on a private network is http by design. The property
    being defended is that the value is a URL, not that it is encrypted in transit.
    """
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_SUPABASE_URL": value}
    assert script.production_environment(_records(environment))["NEXT_PUBLIC_SUPABASE_URL"] == value


@pytest.mark.parametrize(
    ("value", "shape"),
    [
        ("aydhqrzzlqrzdycngfbe.supabase.co", "a bare Supabase hostname"),
        ("aydhqrzzlqrzdycngfbe", "a project ref on its own"),
        ("//project.supabase.co", "a scheme-relative URL"),
        ("https//project.supabase.co", "a missing colon"),
        ("https:/project.supabase.co", "a single slash"),
        ("https://", "a scheme with no host"),
        ("postgres://project.supabase.co", "the wrong scheme"),
        ("sb-publishable-key-in-the-wrong-field", "a client key in the URL field"),
        ("https://project.supabase.co ", "a trailing space"),
        (" https://project.supabase.co", "a leading space"),
        ("https://project supabase.co", "an internal space"),
        ("https://project.supabase.co\n", "a trailing newline"),
    ],
)
def test_a_value_that_is_not_a_usable_url_ends_the_release(
    script: Any, value: str, shape: str
) -> None:
    """The failure that reached production on 2026-09-08, in every shape it could arrive in.

    Each of these is a non-empty string, which is why requiring the variable to be *present* did
    not help: the value was there the whole time. Next.js inlines it at build time, so the build
    compiled it into the Edge middleware bundle and `@supabase/supabase-js` threw
    "Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL." on every request —
    MIDDLEWARE_INVOCATION_FAILED, 500 on every route, a promotion that looked like a success.

    The whitespace cases fail rather than being trimmed on purpose. Trimming would let the release
    paper over a value that is wrong in the dashboard, where the next person to read it would still
    see it wrong, and `NEXT_PUBLIC_API_BASE_URL` with a trailing space breaks every request the
    frontend makes without Supabase's trim to save it.
    """
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_SUPABASE_URL": value}
    with pytest.raises(script.ReleaseError, match="NEXT_PUBLIC_SUPABASE_URL"):
        script.production_environment(_records(environment))


def test_the_backend_base_url_is_held_to_the_same_shape(script: Any) -> None:
    """The other URL the frontend is compiled with, and the same failure one step later.

    A scheme-less `NEXT_PUBLIC_API_BASE_URL` renders a frontend that signs a user in and then
    cannot reach the backend at all — which is a Task 23.5 acceptance criterion, so it may not be
    left to be discovered by hand.
    """
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_API_BASE_URL": "weathra.onrender.com"}
    with pytest.raises(script.ReleaseError, match="NEXT_PUBLIC_API_BASE_URL"):
        script.production_environment(_records(environment))


def test_an_empty_url_is_reported_as_missing(script: Any) -> None:
    """Empty is the one shape the required-name check already catches, and it says so plainly."""
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_SUPABASE_URL": ""}
    with pytest.raises(script.ReleaseError, match="missing NEXT_PUBLIC_SUPABASE_URL"):
        script.production_environment(_records(environment))


def test_a_rejected_url_is_never_printed(
    script: Any, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A value that turns out to be a credential in the wrong field must not reach a public log.

    Actions logs on a public repository are readable by anyone, and the most likely way this check
    ever fires is someone pasting the anon key — or worse — into the URL field.
    """
    secret_looking = "sb-publishable-key-that-is-not-a-url"
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_SUPABASE_URL": secret_looking}
    with pytest.raises(script.ReleaseError) as caught:
        script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher(records=_records(environment)))
    captured = capsys.readouterr()
    assert secret_looking not in captured.out + captured.err + str(caught.value)
    assert "NEXT_PUBLIC_SUPABASE_URL" in str(caught.value)


def test_an_unusable_url_stops_the_release_before_the_build_has_anything_to_build(
    script: Any, tmp_path: Path
) -> None:
    """Nothing is written, so there is no environment and no link for a build to pick up.

    Ordering is the whole value of this check: the same misconfiguration caught after the build is
    a promoted production frontend that answers 500, and catching it before means the previous
    deployment stays up.
    """
    environment = dict(PUBLIC_ENVIRONMENT) | {"NEXT_PUBLIC_SUPABASE_URL": "project.supabase.co"}
    with pytest.raises(script.ReleaseError):
        script.run(PROJECT_ID, ORG_ID, tmp_path, _fetcher(records=_records(environment)))
    assert not (tmp_path / ".vercel" / ".env.production.local").exists()
    assert not (tmp_path / ".vercel" / "project.json").exists()
