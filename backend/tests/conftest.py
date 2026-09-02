"""Shared fixtures. Nothing here reaches the network, a database, or an inference provider."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.auth_support import TokenFactory, build_factory

# `db`-marked tests draw their database fixtures from here. Imported as plugins so any test module
# can request them without repeating the wiring.
pytest_plugins = ["tests.db_support"]

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
PACKAGE_ROOT = BACKEND_ROOT / "weathra"


@pytest.fixture(scope="session")
def token_factory() -> TokenFactory:
    """One key pair per session — RSA generation is the slowest thing in the offline suite."""
    return build_factory()


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def backend_root() -> Path:
    return BACKEND_ROOT


@pytest.fixture(scope="session")
def package_root() -> Path:
    return PACKAGE_ROOT
