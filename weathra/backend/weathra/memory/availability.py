"""One place that decides what counts as "the memory store is unavailable".

``specs/memory`` asks for two things and it is easy to conflate them: stateless capabilities must
keep serving through a memory outage, and a follow-up must *say* context is unavailable rather than
answering as though it had context. Both need "outage" to mean something narrower than "an exception
came out of the database" — and, as it turns out, something wider than "a SQLAlchemy error".

**What counts.** Four families, because the memory layer reaches Postgres through two different
drivers and a failure to *connect* does not always arrive wrapped:

* ``sqlalchemy.exc.OperationalError`` — the ordinary lost-connection case on the ORM path;
* a ``DBAPIError`` whose connection was invalidated — the same thing, seen mid-statement;
* ``psycopg``'s own ``OperationalError`` and ``PoolTimeout`` — the checkpointer's driver, which
  does not go through SQLAlchemy at all;
* ``OSError`` — and this one is the reason the list is written out rather than guessed at.
  SQLAlchemy's asyncpg dialect does **not** wrap a socket-level connect failure: a refused
  connection, an unresolvable host, or a network timeout escapes as a bare
  ``ConnectionRefusedError`` or ``socket.gaierror``. Those are exactly what a real outage looks
  like, so leaving them out would mean the one failure this module exists for reached the API as
  an unhandled error.

**What does not count.** A constraint violation, a serialization failure, a validation error, or a
programming mistake keeps its own exception. Reporting a bug as an outage hides it behind a message
that invites a retry which will fail identically forever.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import psycopg
import psycopg_pool
from sqlalchemy.exc import DBAPIError, OperationalError

from weathra.domain.errors import MemoryUnavailable

__all__ = ["reporting_unavailable"]

logger = logging.getLogger("weathra.memory")

# The failures that mean "cannot reach the store", as opposed to "the store said no".
_TRANSPORT_FAILURES = (
    OperationalError,
    psycopg.OperationalError,
    psycopg_pool.PoolTimeout,
    OSError,
)


@asynccontextmanager
async def reporting_unavailable(store: str) -> AsyncIterator[None]:
    """Turn a failure to reach the store into ``MemoryUnavailable``, naming which store it was."""
    try:
        yield
    except DBAPIError as exc:
        # Checked before the tuple below, because OperationalError is itself a DBAPIError: a
        # statement that failed on a live connection is the store answering, not an outage.
        if not (exc.connection_invalidated or isinstance(exc, OperationalError)):
            raise
        raise _unavailable(store, exc) from exc
    except _TRANSPORT_FAILURES as exc:
        raise _unavailable(store, exc) from exc


def _unavailable(store: str, cause: BaseException) -> MemoryUnavailable:
    logger.warning("memory store %s unreachable: %s", store, type(cause).__name__)
    return MemoryUnavailable(
        # Deliberately says nothing about the host, the port, or the driver: a connection string
        # is a credential, and an error body is not the place for one.
        "The memory store could not be reached.",
        details={"store": store},
    )
