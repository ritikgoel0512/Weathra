"""Connection URL handling for the two deliberately separated connections (design.md decision 5).

* **Request-serving** (``DATABASE_URL``) — used by every request. Runs under the restricted role so
  Row Level Security policies apply to backend queries, which is what makes a forgotten ownership
  predicate return nothing instead of another user's row.
* **Privileged** (``DATABASE_URL_PRIVILEGED``) — used *only* by migrations, the retention routine,
  and evaluation test-user provisioning. Never on a path serving a browser.

Both arrive as one URL string that may name any driver. The helpers here normalize the driver
rather than requiring an operator to know which one each caller wants: the async engine needs
``postgresql+asyncpg``, Alembic runs synchronously and needs ``postgresql+psycopg``, and LangGraph's
checkpointer talks to libpq directly and needs a driverless ``postgresql://`` conninfo.
"""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy.engine import URL, make_url

from weathra.config import Settings

__all__ = ["ConnectionRole", "async_url", "libpq_url", "resolve_url", "sync_url"]

ASYNC_DRIVER = "postgresql+asyncpg"
SYNC_DRIVER = "postgresql+psycopg"


class ConnectionRole(StrEnum):
    """Which of the two connections a caller wants. Named so the choice is never implicit."""

    REQUEST = "request"
    PRIVILEGED = "privileged"


def _rewrite_driver(raw: str, driver: str) -> URL:
    url = make_url(raw)
    if url.get_backend_name() != "postgresql":
        raise ValueError(
            f"Weathra requires PostgreSQL; the configured URL names {url.get_backend_name()!r}."
        )
    return url.set(drivername=driver)


def async_url(raw: str) -> URL:
    """The URL as the async engine needs it, whatever driver was configured."""
    return _rewrite_driver(raw, ASYNC_DRIVER)


def sync_url(raw: str) -> URL:
    """The URL as Alembic and other synchronous tooling need it."""
    return _rewrite_driver(raw, SYNC_DRIVER)


def libpq_url(raw: str) -> str:
    """The URL as a plain libpq conninfo string, for a caller that is not using SQLAlchemy.

    LangGraph's Postgres checkpointer owns its own psycopg connections (design.md decision 11), so
    it needs the URL without a SQLAlchemy driver suffix — ``postgresql+asyncpg://`` is not
    something libpq can parse. The password is rendered, because this string *is* the credential
    being handed to the driver; it must never be logged.
    """
    url = _rewrite_driver(raw, "postgresql")
    return url.render_as_string(hide_password=False)


def resolve_url(settings: Settings, role: ConnectionRole) -> str:
    """The raw configured URL for one connection role, or a clear error naming what is missing.

    The privileged URL deliberately does *not* fall back to the request-serving one: a migration
    silently running under the restricted role would fail in a confusing way, and — worse — the
    reverse fallback would hand a request path privileged access.
    """
    if role is ConnectionRole.REQUEST:
        configured = settings.database_url
        variable = "DATABASE_URL"
    else:
        configured = settings.database_url_privileged
        variable = "DATABASE_URL_PRIVILEGED"

    if configured is None:
        raise ValueError(
            f"{variable} is not configured, so the {role.value} database connection cannot be "
            "opened. See backend/.env.example."
        )
    return configured.get_secret_value()
