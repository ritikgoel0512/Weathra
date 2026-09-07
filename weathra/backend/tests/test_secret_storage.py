"""Task 23.3 — where a secret is allowed to be, and where it must never be.

The task asks for secret storage "server-side only", and for evidence that no secret is present in
the frontend environment or the repository. Storage itself lives in two dashboards this repository
cannot reach — GitHub Actions secrets and the Render service environment — so what is checkable
here is the half that *can* drift: the declarations, the boundaries in the code that make the split
meaningful, and the absence of any committed value.

Four properties, and each one is a way the split has actually failed in real projects:

1. **Nothing credential-shaped is committed.** Scanned across every tracked file, not just the
   frontend. `frontend/scripts/secret-containment.ts` is rooted at `frontend/` and inspects the
   built bundle, which is the browser's half of the question; this is the repository's half, and
   before this task nothing covered it.
2. **The two database connections cannot substitute for each other.** Not in either direction.
   A request path that silently fell back to the privileged URL would bypass every Row Level
   Security policy while looking healthy.
3. **The declarations name secrets without carrying them.** `render.yaml` and the workflow files
   are committed, so a value in either is a published value.
4. **Ordinary CI needs no production credential.** A pull-request run that required a real database
   would make every fork's CI fail and every contributor a person who needs the production
   password.

Every credential-shaped string in this file is fabricated and belongs to nobody.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

import pytest

from weathra.config import SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE, Settings
from weathra.db.urls import ConnectionRole, resolve_url

yaml = pytest.importorskip("yaml", reason="PyYAML is needed to parse the declaration files")


# The four server-side secrets of design decision 19, by name. Names, never values.
SERVER_SIDE_SECRETS = (
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
    "DATABASE_URL_PRIVILEGED",
    "OPENROUTER_API_KEY",
)

# What the frontend is allowed to hold. Everything here is public by construction: a
# `NEXT_PUBLIC_` value is inlined into the browser bundle at build time.
FRONTEND_PUBLIC_NAMES = (
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_API_BASE_URL",
)


# Shapes a real credential takes. Deliberately about the *value*, because a scan that trusted
# variable names would miss a password pasted into a connection string.
CREDENTIAL_SHAPES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("a JSON Web Token", re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}")),
    ("an OpenRouter key", re.compile(r"\bsk-or-v1-[A-Za-z0-9]{16,}")),
    ("an OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{32,}")),
    ("an AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("a private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "a database URL carrying a password",
        re.compile(r"postgres(?:ql)?(?:\+\w+)?://[^:/\s]+:([^@\s]+)@([^\s/:]+)"),
    ),
)

# Passwords that are obviously not passwords. `.env.example` has to show the *shape* of a
# connection string, and a test has to build one, so a scan that flagged every `user:password@host`
# would fail on exactly the files whose job is to be a template — and would then be edited into
# silence, which is how this kind of check dies. Real values are what matter, so a DSN is a finding
# only when neither its password nor its host reads as a stand-in.
PLACEHOLDER_PASSWORDS = frozenset(
    {"password", "pw", "pass", "passwd", "secret", "changeme", "your-password", "postgres", "x"}
)
PLACEHOLDER_HOST = re.compile(
    r"(?i)^(localhost|127\.0\.0\.1|host|db|HOST|REGION\.|.*\.example(\.com)?$|.*\.invalid$|.*\.test$)"
)


def _dsn_is_a_placeholder(password: str, host: str) -> bool:
    """Whether a matched connection string is plainly a template rather than a credential."""
    if password.lower() in PLACEHOLDER_PASSWORDS:
        return True
    if PLACEHOLDER_HOST.match(host):
        return True
    # `REGION.pooler.supabase.com`, `PROJECT_REF` — an upper-case token standing in for a value.
    return bool(re.search(r"\b[A-Z][A-Z0-9_]{3,}\b", host))


# Files whose job is to describe the thing being detected. Each is a test or a checker that must
# contain credential-shaped strings in order to assert something about them.
SCANNER_FILES = frozenset(
    {
        "weathra/backend/tests/test_secret_storage.py",
        "weathra/backend/tests/unit/test_auth_redaction.py",
        "weathra/backend/weathra/redaction.py",
        "weathra/frontend/scripts/secret-containment.ts",
        "weathra/frontend/scripts/secret-containment.test.ts",
    }
)

SCANNED_SUFFIXES = (
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".md",
    ".env",
    ".example",
    ".sh",
    ".sql",
)


@pytest.fixture(scope="module")
def tracked_files(repo_root: Path) -> list[str]:
    """Every file Git actually tracks. What is committed is what is published."""
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [name for name in listed.stdout.split("\0") if name]


@pytest.fixture(scope="module")
def render_blueprint(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "render.yaml"
    assert path.is_file(), "render.yaml is missing: the backend service is not declared"
    loaded: dict[str, Any] = yaml.safe_load(path.read_text())
    return loaded


def _backend_service(blueprint: dict[str, Any]) -> dict[str, Any]:
    services = blueprint.get("services") or []
    assert services, "render.yaml declares no services"
    service: dict[str, Any] = services[0]
    return service


def _env_vars(service: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["key"]: entry for entry in service.get("envVars", [])}


# ------------------------------------------------------------------ 1. nothing committed


def test_no_credential_value_is_committed_anywhere_in_the_repository(
    repo_root: Path, tracked_files: list[str]
) -> None:
    """The repository half of the task's verification clause.

    The frontend check inspects `frontend/` and the built bundle. This one inspects everything Git
    tracks, because "no secret is present in the repository" is a claim about the repository.
    """
    offences: list[str] = []

    for name in tracked_files:
        if name in SCANNER_FILES:
            continue
        if not name.endswith(SCANNED_SUFFIXES):
            continue
        path = repo_root / name
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue  # A binary or unreadable file holds no reviewable text.

        for what, pattern in CREDENTIAL_SHAPES:
            for found in pattern.finditer(content):
                if found.re.groups == 2 and _dsn_is_a_placeholder(found[1], found[2]):
                    continue
                line = content[: found.start()].count("\n") + 1
                # The value itself is never reported. Where it is, is enough to act on.
                offences.append(f"{name}:{line}: something shaped like {what}")
                break

    assert not offences, "credential-shaped values are committed:\n  " + "\n  ".join(offences)


def test_no_private_environment_file_is_committed(tracked_files: list[str]) -> None:
    """`.env.example` templates are committed on purpose; a real `.env` never is."""
    committed_env = [
        name
        for name in tracked_files
        if Path(name).name.startswith(".env") and not Path(name).name.endswith(".example")
    ]
    assert not committed_env, f"private environment files are committed: {committed_env}"


# ------------------------------------------------------------------ 2 & 3. the connection split


@pytest.mark.parametrize(
    ("role", "configured", "missing_variable"),
    [
        (ConnectionRole.REQUEST, "database_url_privileged", "DATABASE_URL"),
        (ConnectionRole.PRIVILEGED, "database_url", "DATABASE_URL_PRIVILEGED"),
    ],
)
def test_neither_connection_falls_back_to_the_other(
    role: ConnectionRole, configured: str, missing_variable: str
) -> None:
    """Configure only the *other* URL and the resolver must refuse, not substitute.

    Both directions are dangerous and they are dangerous differently. A privileged job silently
    running under the restricted role fails confusingly, mid-migration. A request path silently
    running under the privileged one succeeds — and serves every user's rows to whoever asked,
    because the privileged role is precisely the one Row Level Security does not constrain. The
    second is why this test exists in a file about secret storage: keeping two credentials apart is
    pointless if the code will reach for either.
    """
    settings = Settings(
        supabase_url="https://project.supabase.co",
        **{configured: "postgresql://user:pw@db.example.com:5432/postgres"},  # type: ignore[arg-type]
    )

    with pytest.raises(ValueError) as caught:
        resolve_url(settings, role)

    assert missing_variable in str(caught.value)


def test_a_request_serving_process_refuses_the_service_role_key() -> None:
    """The guard that makes "server-side only" mean something on the serving path.

    The service-role key bypasses every RLS policy. A process that answers browser requests has no
    use for it, so holding it is a configuration error rather than a risk to be managed — and the
    settings validator treats it as one, refusing to start at all.
    """
    with pytest.raises(ValueError) as caught:
        Settings(
            supabase_url="https://project.supabase.co",
            weathra_runtime_mode="request_serving",
            supabase_service_role_key="not-a-real-key",  # fabricated
        )

    assert SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE in str(caught.value)


def test_a_privileged_process_may_hold_the_service_role_key() -> None:
    """The other half of the guard: the refusal is about the *mode*, not about the key existing.

    Evaluation test-user provisioning is its one consumer, and it runs privileged, in CI. A guard
    that refused everywhere would simply make the capability unimplementable.
    """
    settings = Settings(
        supabase_url="https://project.supabase.co",
        weathra_runtime_mode="privileged",
        supabase_service_role_key="not-a-real-key",  # fabricated
    )
    assert settings.is_privileged
    assert settings.supabase_service_role_key is not None


# ------------------------------------------------------------------ 4. the Render declaration


def test_the_render_blueprint_declares_the_backend_without_carrying_a_value(
    render_blueprint: dict[str, Any],
) -> None:
    """A blueprint is committed source. Every secret in it is a name and a `sync: false`."""
    service = _backend_service(render_blueprint)
    env = _env_vars(service)

    for name in ("DATABASE_URL", "OPENROUTER_API_KEY"):
        assert name in env, f"render.yaml does not declare {name}"
        assert env[name].get("sync") is False, (
            f"{name} must be declared `sync: false` so its value is entered on the service"
        )
        assert "value" not in env[name], f"render.yaml carries a value for {name}"

    # Nothing anywhere in the file may carry a value for a secret name.
    for name in SERVER_SIDE_SECRETS:
        entry = env.get(name)
        if entry is not None:
            assert "value" not in entry, f"render.yaml carries a value for {name}"


def test_the_render_service_never_holds_the_privileged_database_url(
    render_blueprint: dict[str, Any],
) -> None:
    """Migrations run from GitHub Actions, so the serving container never holds this credential.

    The alternative was Render's pre-deploy command, which executes in the service's own
    environment: it would have bought an ordering guarantee by granting the browser-facing container
    a connection that bypasses Row Level Security, permanently, for the sake of a step that runs for
    a few seconds at release time. A CI job gives the same ordering through an explicit job
    dependency and grants nothing.

    This is asserted rather than documented because the pressure to reverse it is real and arrives
    disguised as convenience — task 23.4 has to sequence two jobs, and adding one variable here
    would look like a simplification. It is not: it would make the separation `resolve_url()`
    enforces ceremonial, since the serving process would then hold both credentials and only code
    discipline would keep them apart.
    """
    env = _env_vars(_backend_service(render_blueprint))

    assert "DATABASE_URL_PRIVILEGED" not in env, (
        "the request-serving Render service declares DATABASE_URL_PRIVILEGED; migrations run from "
        "GitHub Actions precisely so this container never holds a privileged connection"
    )
    assert "DATABASE_URL" in env, "the request path still needs its own connection"


def test_the_render_service_never_holds_the_service_role_key(
    render_blueprint: dict[str, Any],
) -> None:
    """Declaring it would not weaken a check — it would stop the service booting.

    `Settings` refuses `request_serving` with the key set, and this service declares exactly that
    mode. The two facts have to agree, so this asserts both rather than trusting the comment.
    """
    service = _backend_service(render_blueprint)
    env = _env_vars(service)

    assert env.get("WEATHRA_RUNTIME_MODE", {}).get("value") == "request_serving"
    assert "SUPABASE_SERVICE_ROLE_KEY" not in env, (
        "the request-serving service declares the service-role key; Settings would refuse to start"
    )


def test_the_render_service_does_not_idle_spin_down(render_blueprint: dict[str, Any]) -> None:
    """A spun-down service pays the heavy-import cold start on a user's first request."""
    service = _backend_service(render_blueprint)
    assert service.get("plan") != "free", "the free instance type spins down when idle"


# ------------------------------------------------------------------ 5 & 6. CI holds no credential


def test_no_workflow_carries_a_secret_value(repo_root: Path) -> None:
    """A workflow may reference `secrets.NAME`. It may never contain the value."""
    workflows = sorted((repo_root / ".github" / "workflows").glob("*.yml"))
    assert workflows, "no workflow files found"

    for path in workflows:
        content = path.read_text()
        for what, pattern in CREDENTIAL_SHAPES:
            for found in pattern.finditer(content):
                if found.re.groups == 2 and _dsn_is_a_placeholder(found[1], found[2]):
                    continue
                raise AssertionError(f"{path.name} contains something shaped like {what}")


def test_ordinary_ci_needs_no_production_credential(repo_root: Path) -> None:
    """A pull-request run reaches a disposable Postgres and nothing else.

    Asserted against the rendered YAML rather than the `env:` blocks alone, so a credential
    reintroduced through a `with:` input or an inline `run:` is caught too.
    """
    for name in ("backend.yml", "frontend.yml"):
        rendered = yaml.safe_dump(
            yaml.safe_load((repo_root / ".github" / "workflows" / name).read_text())
        )
        for secret in SERVER_SIDE_SECRETS:
            if secret == "DATABASE_URL" or secret == "DATABASE_URL_PRIVILEGED":
                # These two appear in the backend workflow pointed at the service container. That
                # is the disposable database, asserted below, not a production credential.
                continue
            assert secret not in rendered, f"{name} references {secret}"

        assert "secrets." not in rendered, (
            f"{name} reads a repository secret; the pull-request workflows hold no credential"
        )


def test_the_database_urls_in_ci_point_at_the_disposable_service(repo_root: Path) -> None:
    """Where CI does set a database URL, it is the ephemeral container on localhost."""
    content = (repo_root / ".github" / "workflows" / "backend.yml").read_text()

    for match in re.finditer(r"DATABASE_URL(?:_PRIVILEGED)?:\s*(\S+)", content):
        url = match.group(1)
        assert "localhost" in url or "127.0.0.1" in url, (
            "a CI database URL does not point at the service container"
        )


# ------------------------------------------------------------------ 7. the frontend boundary


def test_the_frontend_template_holds_only_public_configuration(repo_root: Path) -> None:
    """The browser's whole configuration surface, and none of it is a secret."""
    template = (repo_root / "weathra" / "frontend" / ".env.example").read_text()

    named = set(re.findall(r"^\s*([A-Z][A-Z0-9_]*)=", template, re.MULTILINE))
    assert named <= set(FRONTEND_PUBLIC_NAMES), (
        f"the frontend template names something outside the public set: "
        f"{sorted(named - set(FRONTEND_PUBLIC_NAMES))}"
    )

    for secret in SERVER_SIDE_SECRETS:
        assert secret not in template, f"{secret} is named in the frontend template"


def test_no_server_side_secret_is_reachable_from_the_frontend(repo_root: Path) -> None:
    """The frontend must never *read* a server-side secret, nor publish one through a prefix.

    Two things are checked, and a third is deliberately not.

    Checked: no `NEXT_PUBLIC_` prefix on any of the four — that prefix inlines the value into every
    browser bundle. And no `process.env.<SECRET>` read anywhere under `frontend/`, which is the
    frontend asking for a value it has no business holding.

    Not checked: the bare name appearing in text. `analyst.test.tsx` asserts the agent surface tells
    an operator to *set* `OPENROUTER_API_KEY` when inference is unconfigured, and that message is
    the product working — naming a variable is how you tell someone which one to set. Failing on
    that would be a check that punishes a good error message, and the reasonable response would be
    to weaken the check. The value is what must not leak, and the value is what the frontend's own
    containment scan asserts against the built bundle.
    """
    frontend = repo_root / "weathra" / "frontend"
    skip = {"node_modules", ".next", "test-results", "playwright-report", ".manual-pass"}

    offences: list[str] = []
    for path in frontend.rglob("*"):
        if not path.is_file() or not path.name.endswith(SCANNED_SUFFIXES):
            continue
        if skip & set(path.relative_to(frontend).parts):
            continue
        if str(path.relative_to(repo_root)) in SCANNER_FILES:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        where = path.relative_to(repo_root)
        for secret in SERVER_SIDE_SECRETS:
            if f"NEXT_PUBLIC_{secret}" in content:
                offences.append(f"{where}: NEXT_PUBLIC_{secret} would ship to every browser")
            if re.search(rf"process\.env\.{secret}\b", content):
                offences.append(f"{where}: reads process.env.{secret}")

    assert not offences, "the frontend reaches for a server-side secret:\n  " + "\n  ".join(
        offences
    )


# ------------------------------------------------------------------ 8. logs redact


def test_a_connection_string_does_not_survive_logging() -> None:
    """Configuration errors love to print a connection string. This one loses its password."""
    from weathra.redaction import PLACEHOLDER, redact

    rendered = redact(
        "DATABASE_URL=postgresql://weathra_api:s3cr3t-not-real@db.example.com/postgres"
    )

    assert "s3cr3t-not-real" not in rendered
    assert PLACEHOLDER in rendered


def test_a_settings_repr_does_not_reveal_a_secret() -> None:
    """`SecretStr` is what keeps a stack trace or a debug print from publishing the value."""
    settings = Settings(
        supabase_url="https://project.supabase.co",
        database_url="postgresql://weathra_api:s3cr3t-not-real@db.example.com/postgres",
        openrouter_api_key="sk-or-v1-fabricated-and-belongs-to-nobody",
    )

    rendered = repr(settings)
    assert "s3cr3t-not-real" not in rendered
    assert "fabricated-and-belongs-to-nobody" not in rendered
