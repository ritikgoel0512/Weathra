"""Shared fixtures. Nothing here reaches the network, a database, or an inference provider."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.auth_support import TokenFactory, build_factory
from weathra.config import Settings

# The suite does not read the developer's `backend/.env`.
#
# `Settings` reads `.env` from the working directory by design, and the offline suite runs from
# `backend/`, so without this a local environment file leaks into every test that constructs
# `Settings` — and the tests it breaks are exactly the ones asserting that a credential is *not*
# required. A blank `OPENROUTER_API_KEY=` line is enough: pydantic-settings reads it as the empty
# string rather than as absent, `inference_configured` flips to true, and eight tests fail on a
# machine that is configured correctly. A real key does the same.
#
# `test_missing_project_url_is_refused` already passed `_env_file=None` for this reason; applying it
# once here makes the whole suite hermetic instead of one test. CI has no `.env` at all, so this
# changes nothing there — it makes a local run agree with CI. The application is untouched:
# `config.py` still declares `env_file=".env"`, and this mutation lives only in the test process.
Settings.model_config["env_file"] = None

# `db`-marked tests draw their database fixtures from here, and the whole-app harness from
# `api_support`. Imported as plugins so any test module can request them without repeating the
# wiring — two modules now boot the app, and a fixture copied into the second would be a
# fixture that only gets fixed in the first.
pytest_plugins = ["tests.db_support", "tests.api_support"]

BACKEND_ROOT = Path(__file__).resolve().parents[1]
# The application lives in its own top-level project directory, so the two roots are distinct:
# `weathra/` holds the applications, their docs, and the OpenSpec change, while the repository
# root above it holds only what belongs to the repository itself — the CI workflows, the README,
# the licence, and .gitignore.
PROJECT_ROOT = BACKEND_ROOT.parent
REPO_ROOT = PROJECT_ROOT.parent
PACKAGE_ROOT = BACKEND_ROOT / "weathra"


@pytest.fixture(scope="session")
def token_factory() -> TokenFactory:
    """One key pair per session — RSA generation is the slowest thing in the offline suite."""
    return build_factory()


@pytest.fixture(scope="session")
def project_root() -> Path:
    """The `weathra/` project directory — the parent of `backend/`, `frontend/`, and `docs/`."""
    return PROJECT_ROOT


@pytest.fixture(scope="session")
def repo_root() -> Path:
    """The repository root — the parent of `weathra/`, and where `.github/workflows/` lives."""
    return REPO_ROOT


@pytest.fixture(scope="session")
def backend_root() -> Path:
    return BACKEND_ROOT


@pytest.fixture(scope="session")
def package_root() -> Path:
    return PACKAGE_ROOT
