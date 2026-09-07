"""Task 23.4 — the production image, and the blueprint that runs it.

Render builds `weathra/backend/Dockerfile` and runs the result; nothing else serves production
traffic. That makes the Dockerfile a deployment artefact rather than a convenience, and these
tests cover the properties that are cheap to break and expensive to discover:

* **No credential can reach the image.** Two independent reasons — the build context excludes every
  private environment file, and the runtime stage copies no source tree at all.
* **The container starts the way Render will start it.** Binding `0.0.0.0` on `$PORT` is what makes
  a service reachable; binding `127.0.0.1`, or a fixed port, produces a container that passes every
  local check and is unreachable in production.
* **The blueprint and the Dockerfile agree.** A `dockerfilePath` pointing at a file that does not
  exist fails at Render's build, minutes after a migration has already been applied.
* **Auto-deploy stays off.** This is the whole of the ordering guarantee; see
  `test_release_workflow.py`.

Nothing here builds an image: a test suite that took ten minutes would be run rarely and would then
stop being a gate. The image is built and smoke-tested by the `image` job of
`.github/workflows/release.yml`, before anything is migrated.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML is needed to parse the blueprint")

# The secrets that must never be baked in. Names, never values.
SERVER_SIDE_SECRETS = (
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
    "DATABASE_URL_PRIVILEGED",
    "OPENROUTER_API_KEY",
)


@pytest.fixture(scope="module")
def dockerfile(repo_root: Path) -> str:
    path = repo_root / "weathra" / "backend" / "Dockerfile"
    assert path.is_file(), "the backend is not containerized: weathra/backend/Dockerfile is missing"
    return path.read_text()


@pytest.fixture(scope="module")
def dockerignore(repo_root: Path) -> str:
    path = repo_root / "weathra" / "backend" / ".dockerignore"
    assert path.is_file(), "weathra/backend/.dockerignore is missing"
    return path.read_text()


@pytest.fixture(scope="module")
def blueprint(repo_root: Path) -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load((repo_root / "render.yaml").read_text())
    return loaded


@pytest.fixture(scope="module")
def service(blueprint: dict[str, Any]) -> dict[str, Any]:
    services = blueprint.get("services") or []
    assert services, "render.yaml declares no services"
    first: dict[str, Any] = services[0]
    return first


def _instructions(dockerfile: str) -> list[tuple[str, str]]:
    """Every instruction as ``(verb, argument)``, with line continuations folded."""
    folded = re.sub(r"\\\s*\n\s*", " ", dockerfile)
    found: list[tuple[str, str]] = []
    for line in folded.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        verb, _, argument = stripped.partition(" ")
        found.append((verb.upper(), argument.strip()))
    return found


def _runtime_stage(dockerfile: str) -> list[tuple[str, str]]:
    """The instructions belonging to the final stage — the one that becomes the image."""
    instructions = _instructions(dockerfile)
    starts = [index for index, (verb, _) in enumerate(instructions) if verb == "FROM"]
    assert starts, "the Dockerfile declares no FROM"
    return instructions[starts[-1] :]


# ------------------------------------------------------------------ 1. no credential in the image


def test_the_build_context_excludes_every_private_environment_file(dockerignore: str) -> None:
    """`backend/.env` holds a developer's real credentials, and `docker build` can see it.

    `.gitignore` keeps that file out of the repository, which is why the secret-storage tests pass
    — but a local `docker build` runs against the working tree, not against Git. Without these
    patterns, building the image on any machine that has ever run the backend would copy real
    credentials into a layer, where they stay: deleting a file in a later layer does not remove it
    from the published image.
    """
    patterns = {
        line.strip()
        for line in dockerignore.splitlines()
        if line.strip() and not line.startswith("#")
    }

    assert ".env" in patterns, ".dockerignore does not exclude .env"
    assert ".env.*" in patterns, ".dockerignore does not exclude .env.* variants"

    # A negation would re-admit whatever it names. `.gitignore` needs one for `.env.example`; the
    # image needs no environment file at all, so any negation here is a mistake.
    reinstated = [pattern for pattern in patterns if pattern.startswith("!") and "env" in pattern]
    assert not reinstated, f".dockerignore re-admits an environment file: {reinstated}"


def test_the_dockerfile_bakes_in_no_secret(dockerfile: str) -> None:
    """No `ENV` or `ARG` may carry a server-side secret, by name or by value.

    An `ARG` is worse than it looks: its value is recorded in the image's build history, so
    `docker history` recovers it from anyone who can pull the image.
    """
    offences: list[str] = []
    for verb, argument in _instructions(dockerfile):
        if verb not in {"ENV", "ARG"}:
            continue
        for secret in SERVER_SIDE_SECRETS:
            if re.search(rf"\b{secret}\b", argument):
                offences.append(f"{verb} {secret}")

    assert not offences, f"the Dockerfile declares a server-side secret: {offences}"


def test_the_runtime_stage_copies_no_source_tree(dockerfile: str) -> None:
    """The second reason no credential can arrive: there is nowhere for one to land.

    The runtime stage copies the virtualenv the build stage produced. It does not copy the working
    directory, so even a `.dockerignore` that had been edited into uselessness could not put a
    `.env` into the shipped image — the final stage never reads the build context.
    """
    for verb, argument in _runtime_stage(dockerfile):
        if verb != "COPY":
            continue
        assert "--from=" in argument, (
            f"the runtime stage copies from the build context, not from a previous stage: {argument!r}"
        )


# ------------------------------------------------------------------ 2. it starts the way Render does


def test_the_container_binds_every_interface_on_the_assigned_port(dockerfile: str) -> None:
    """Render assigns the port and routes to the container's own network interface.

    Binding `127.0.0.1` produces a container that answers a local `docker exec` and is unreachable
    from Render's proxy; hard-coding a port produces one that ignores the assignment. Both fail
    only in production.
    """
    command = [argument for verb, argument in _runtime_stage(dockerfile) if verb == "CMD"]
    assert command, "the runtime stage declares no CMD"
    rendered = command[-1]

    assert "--host 0.0.0.0" in rendered, "the server does not bind every interface"
    assert "$PORT" in rendered, "the server does not use Render's assigned $PORT"
    assert "127.0.0.1" not in rendered and "localhost" not in rendered


def test_the_container_serves_the_application_factory(dockerfile: str) -> None:
    """`create_app` is a factory, so uvicorn needs `--factory`; without it the app never builds."""
    rendered = [argument for verb, argument in _runtime_stage(dockerfile) if verb == "CMD"][-1]

    assert "weathra.api.app:create_app" in rendered
    assert "--factory" in rendered


def test_the_container_does_not_run_as_root(dockerfile: str) -> None:
    """A write primitive found in a dependency should not also be root on the filesystem."""
    users = [argument for verb, argument in _runtime_stage(dockerfile) if verb == "USER"]
    assert users, "the runtime stage never drops out of root"
    assert users[-1] not in {"root", "0"}, f"the container runs as {users[-1]!r}"


def test_the_container_never_migrates(dockerfile: str) -> None:
    """Migrations belong to CI, under the privileged connection, before this image is released.

    A `CMD` or `ENTRYPOINT` that ran `alembic upgrade` would need `DATABASE_URL_PRIVILEGED` in the
    request-serving environment — the exact grant `render.yaml` and `test_secret_storage.py` exist
    to prevent — and would run once per container rather than once per release.
    """
    for verb, argument in _runtime_stage(dockerfile):
        if verb in {"CMD", "ENTRYPOINT", "RUN"}:
            assert "alembic" not in argument, f"the image runs Alembic in its {verb}: {argument!r}"


# ------------------------------------------------------------------ 3. reproducible installs


def test_dependencies_are_installed_against_the_pinned_set(dockerfile: str) -> None:
    """`pyproject.toml` declares floors; the image must install one exact resolved set."""
    installs = [
        argument
        for verb, argument in _instructions(dockerfile)
        if verb == "RUN" and "pip install" in argument and "constraints.txt" in argument
    ]
    assert installs, "the image does not install against constraints.txt"


def test_the_constraints_file_is_a_complete_pinned_set(repo_root: Path) -> None:
    """Every line an exact `==` pin, and nothing naming the project itself.

    `pip freeze` renders a locally-installed project as `weathra @ file:///...`, which pip rejects
    outright in a constraints file — a direct reference is not a constraint. That is a real failure
    mode rather than a hypothetical one, so it is asserted rather than remembered.
    """
    path = repo_root / "weathra" / "backend" / "constraints.txt"
    assert path.is_file(), "weathra/backend/constraints.txt is missing"

    pins = [
        line.strip()
        for line in path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert pins, "constraints.txt pins nothing"

    unpinned = [pin for pin in pins if "==" not in pin]
    assert not unpinned, f"constraints.txt holds entries that are not exact pins: {unpinned}"

    named_self = [pin for pin in pins if pin.lower().startswith("weathra")]
    assert not named_self, f"constraints.txt constrains the project itself: {named_self}"


# ------------------------------------------------------------------ 4. the blueprint agrees


def test_the_blueprint_runs_the_container(service: dict[str, Any], repo_root: Path) -> None:
    """Docker runtime, and both paths resolve to files that exist."""
    assert service.get("runtime") == "docker", (
        f"render.yaml runs {service.get('runtime')!r}, so the container is not what serves traffic"
    )

    dockerfile_path = service.get("dockerfilePath")
    context = service.get("dockerContext")
    assert dockerfile_path, "render.yaml does not name a dockerfilePath"
    assert context, "render.yaml does not name a dockerContext"

    assert (repo_root / dockerfile_path.lstrip("./")).is_file(), (
        f"dockerfilePath points at a file that does not exist: {dockerfile_path}"
    )
    assert (repo_root / context.lstrip("./")).is_dir(), (
        f"dockerContext points at a directory that does not exist: {context}"
    )


def test_the_blueprint_carries_no_native_runtime_leftovers(service: dict[str, Any]) -> None:
    """A `buildCommand` beside a Docker runtime is dead configuration that reads as live.

    It is the kind of leftover a reader trusts — someone editing the build later would edit the
    command that Render ignores, and would be puzzled for a while.
    """
    for stale in ("buildCommand", "startCommand"):
        assert stale not in service, f"render.yaml still declares {stale} beside runtime: docker"


def test_the_service_does_not_idle_spin_down(service: dict[str, Any]) -> None:
    """Task 23.4 names this explicitly: the free instance type spins down when idle.

    LangGraph, SQLAlchemy and the ONNX embedding runtime are all slow to import, so a spun-down
    service pays that whole cost on a user's first request.
    """
    assert service.get("plan") != "free", "the free instance type spins down when idle"
    assert service.get("plan"), "render.yaml declares no plan"


def test_the_health_check_path_is_the_liveness_endpoint(service: dict[str, Any]) -> None:
    """Render restarts a container that fails this path, so it must not depend on the database."""
    assert service.get("healthCheckPath") == "/api/v1/health"
