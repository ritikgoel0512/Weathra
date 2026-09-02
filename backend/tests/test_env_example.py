"""Task 1.6 — both .env.example files document every variable the code reads, and the
public/secret split of design.md decision 19 holds.

This is the convention half of decision 19's boundary. The CI secret-exposure check (task 23.1 /
18.11) is the other half: it asserts the same secrets are absent from the frontend environment and
the built bundle.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from weathra.config import Settings

# Backend variables that carry a secret. None may ever appear in the frontend environment.
BACKEND_SECRETS = frozenset(
    {
        "SUPABASE_SERVICE_ROLE_KEY",
        "DATABASE_URL",
        "DATABASE_URL_PRIVILEGED",
        "OPENROUTER_API_KEY",
    }
)

# The only configuration the browser may see.
FRONTEND_PUBLIC_VARIABLES = frozenset(
    {
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_API_BASE_URL",
    }
)

ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", re.MULTILINE)


def _declared(path: Path) -> set[str]:
    return set(ASSIGNMENT.findall(path.read_text()))


def _settings_variables() -> set[str]:
    names = set()
    for name, field in Settings.model_fields.items():
        alias = field.validation_alias or name
        names.add(str(alias).upper())
    return names


@pytest.fixture(scope="module")
def backend_env(backend_root: Path) -> Path:
    return backend_root / ".env.example"


@pytest.fixture(scope="module")
def frontend_env(repo_root: Path) -> Path:
    return repo_root / "frontend" / ".env.example"


def test_both_files_exist(backend_env: Path, frontend_env: Path) -> None:
    assert backend_env.is_file()
    assert frontend_env.is_file()


def test_backend_example_documents_every_variable_the_code_reads(backend_env: Path) -> None:
    documented = _declared(backend_env)
    missing = _settings_variables() - documented
    assert not missing, f"backend/.env.example is missing: {sorted(missing)}"


def test_backend_example_documents_nothing_the_code_does_not_read(backend_env: Path) -> None:
    stray = _declared(backend_env) - _settings_variables()
    assert not stray, f"backend/.env.example documents unread variables: {sorted(stray)}"


def test_frontend_example_carries_only_public_configuration(frontend_env: Path) -> None:
    assert _declared(frontend_env) == set(FRONTEND_PUBLIC_VARIABLES)


def test_every_frontend_variable_is_public_prefixed(frontend_env: Path) -> None:
    for name in _declared(frontend_env):
        assert name.startswith("NEXT_PUBLIC_"), f"{name} is not declared public"


def test_no_secret_carries_a_public_prefix(backend_env: Path, frontend_env: Path) -> None:
    for path in (backend_env, frontend_env):
        for name in _declared(path):
            bare = name.removeprefix("NEXT_PUBLIC_")
            if name.startswith("NEXT_PUBLIC_"):
                assert bare not in BACKEND_SECRETS, f"{name} exposes a secret to the browser"


@pytest.mark.parametrize("secret", sorted(BACKEND_SECRETS))
def test_backend_secrets_are_absent_from_the_frontend_example(
    frontend_env: Path, secret: str
) -> None:
    body = frontend_env.read_text()
    assert secret not in body, f"{secret} appears in the frontend environment"
    assert f"NEXT_PUBLIC_{secret}" not in body


def test_backend_secrets_are_declared_but_left_empty_in_the_example(backend_env: Path) -> None:
    """A copied example must not carry a working privileged credential."""
    body = backend_env.read_text()
    for line in body.splitlines():
        match = ASSIGNMENT.match(line)
        if match and match.group(1) == "SUPABASE_SERVICE_ROLE_KEY":
            assert line.split("=", 1)[1].strip() == ""


def test_secret_variables_are_marked_secret_in_the_backend_example(backend_env: Path) -> None:
    body = backend_env.read_text()
    for secret in BACKEND_SECRETS:
        index = body.index(f"\n{secret}=")
        preamble = body[max(0, index - 400) : index]
        assert "[secret]" in preamble, f"{secret} is not marked [secret] in its comment"


def test_required_variable_is_marked_required(backend_env: Path) -> None:
    body = backend_env.read_text()
    index = body.index("\nSUPABASE_URL=")
    assert "[required]" in body[max(0, index - 300) : index]
