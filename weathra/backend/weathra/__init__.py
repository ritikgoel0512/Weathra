"""Weathra backend: agentic weather intelligence, forecast analysis, and analytics."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _installed_version

__all__ = ["__version__"]

try:
    __version__ = _installed_version("weathra")
except PackageNotFoundError:  # pragma: no cover - only when running from an unbuilt tree
    # Read from the installed distribution rather than duplicated here, so the version in
    # ``pyproject.toml`` is the only place it is written down.
    __version__ = "0.0.0+unknown"
