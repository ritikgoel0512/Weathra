"""Request correlation and structured request logging.

**One id, everywhere.** A request gets an identifier — the client's own if it supplied one, a fresh
one otherwise — and that id appears in the response header, in the error body, and in every log
record the request produces, including ones emitted deep in the provider layer. The mechanism is a
``contextvar`` that a logging filter reads (design.md decision 16), which is what makes the last
part true without threading a parameter through every function between the route and the HTTP call.

**Why accept a client-supplied id.** Because the client is usually the frontend, and a person
reporting "it said something odd at 14:32" is far easier to help when the browser's network tab and
the server's logs share an identifier. An id a client supplies is untrusted *content*, so it is
length-limited and stripped of anything but safe characters — it goes in a log line and a header,
and a newline in a log line is how a log gets forged.

**What the access log records, and what it must not.** Endpoint, outcome, duration, the weather
provider, cache status, the acting user's *subject*, and whether an agent ran. Not the token, not
the email, not a query string that might carry either. The subject is an opaque uuid: it is what
makes "which user hit this" answerable without putting a person's contact details in a log
aggregator.

**Why the duration is measured here.** It is the only place that sees the whole request, including
the time spent in dependency resolution and serialization. A timer inside a handler would report a
number smaller than the one the person waited.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

__all__ = [
    "REQUEST_ID_HEADER",
    "RequestContextMiddleware",
    "RequestIdFilter",
    "current_request_id",
    "new_request_id",
    "request_id_var",
]

logger = logging.getLogger("weathra.api.access")

REQUEST_ID_HEADER = "X-Request-Id"

# What a client-supplied id may contain. Deliberately narrow: this value reaches a log line and a
# response header, and a newline in either is a forged log record or a split response.
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.:-]")
_MAX_ID_LENGTH = 64

request_id_var: ContextVar[str] = ContextVar("weathra_request_id", default="-")
"""The current request's id, readable from anywhere without being passed in."""


def new_request_id() -> str:
    """A fresh identifier. Short enough to read aloud, unique enough not to collide."""
    return f"req_{uuid.uuid4().hex[:16]}"


def current_request_id() -> str:
    return request_id_var.get()


def _sanitize(supplied: str) -> str | None:
    """A client's id, made safe to log — or ``None`` if nothing usable is left of it."""
    cleaned = _SAFE_ID.sub("", supplied.strip())[:_MAX_ID_LENGTH]
    return cleaned or None


class RequestIdFilter(logging.Filter):
    """Puts the current request id on every record, so a format string can include it.

    A filter rather than an adapter or a wrapped logger, because it applies to records from modules
    that know nothing about requests — ``weathra.providers.http`` logging a retry ends up with the
    id of the request that caused it, which is the whole point.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = current_request_id()
        return True


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Binds the request id, records the access log line, and propagates the id to the response."""

    def __init__(self, app: ASGIApp, *, header: str = REQUEST_ID_HEADER) -> None:
        super().__init__(app)
        self._header = header

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        supplied = request.headers.get(self._header)
        request_id = (_sanitize(supplied) if supplied else None) or new_request_id()

        token = request_id_var.set(request_id)
        # On ``request.state`` as well as in the contextvar: the error handlers read it from there,
        # and an exception handler runs in a context where the var may already have been reset.
        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except BaseException:
            # Logged here so a failed request still produces an access line with its duration.
            # The exception itself is logged by the handler that turns it into a response.
            self._log(
                request,
                status_code=500,
                duration_ms=(time.perf_counter() - started) * 1000.0,
                request_id=request_id,
            )
            raise
        finally:
            request_id_var.reset(token)

        response.headers[self._header] = request_id
        self._log(
            request,
            status_code=response.status_code,
            duration_ms=(time.perf_counter() - started) * 1000.0,
            request_id=request_id,
            response=response,
        )
        return response

    def _log(
        self,
        request: Request,
        *,
        status_code: int,
        duration_ms: float,
        request_id: str,
        response: Response | None = None,
    ) -> None:
        """One structured line per request.

        The path without its query string: a query string can carry a location, a date, and — if
        someone builds a client badly — a token. The route *template* is what an operator wants
        anyway, since it aggregates.
        """
        route = request.scope.get("route")
        endpoint = getattr(route, "path", None) or request.url.path

        # Handlers annotate the request with what they did, so this line can report it without
        # the middleware knowing anything about weather.
        state = request.state
        logger.info(
            "%s %s -> %s in %.1fms",
            request.method,
            endpoint,
            status_code,
            duration_ms,
            extra={
                "request_id": request_id,
                "method": request.method,
                "endpoint": endpoint,
                "status_code": status_code,
                "outcome": "ok" if status_code < 400 else "error",
                "duration_ms": round(duration_ms, 2),
                # The subject only. Never the email, never a claim, never the token.
                "user_id": getattr(state, "acting_user_id", None),
                "weather_provider": getattr(state, "weather_provider", None),
                "cache": getattr(state, "cache_status", None),
                "agent_ran": getattr(state, "agent_ran", False),
                "llm_provider": getattr(state, "llm_provider", None),
                "llm_model": getattr(state, "llm_model", None),
                "partial": getattr(state, "partial", None),
                "response_bytes": (
                    response.headers.get("content-length") if response is not None else None
                ),
            },
        )


def annotate(request: Request, **values: object) -> None:
    """Record what a handler did, for the access line.

    Handlers call this rather than logging themselves, so there is exactly one access record per
    request and its fields are the same on every route.
    """
    for name, value in values.items():
        setattr(request.state, name, value)
