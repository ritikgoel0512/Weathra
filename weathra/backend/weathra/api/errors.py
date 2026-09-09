"""One error envelope, one status mapping, applied exactly once (design.md decision 16).

Nothing below ``api/`` knows about HTTP. A provider raises ``ProviderTimeout`` because that is what
it observed; a service raises ``AnalyticsNotPossible`` because there were too few points. Deciding
that the first is a 504 and the second a 400 is this module's whole job, and doing it in one place
is what keeps two endpoints from disagreeing about what a rate limit means.

**One shape, including for FastAPI's own errors.** FastAPI answers a bad request body with a 422
and its own error format. Left alone, a client would face two error shapes and have to know which
endpoints produce which. So the validation handler translates it into the same envelope at 400 —
the status the rest of the validation family uses.

**The envelope.** ``{"error": {code, message, details, request_id}}``. The code is stable and
machine-readable; the message is for a person; ``details`` carries field-level specifics; the
request id ties the response to the log lines that explain it.

**What never appears in a body.** No stack trace, no token, no credential, no raw upstream payload.
The first is a deliberate omission in the 500 handler — internals are logged and nothing about them
is returned. The rest is a property of the errors themselves: a ``WeathraError``'s message is one a
Weathra developer wrote, provider adapters build theirs from the status and the provider name, and
``redaction.RedactingFilter`` is the backstop on the logging side.

**Why the mapping is a table and not a chain of ``isinstance``.** A dict keyed by class, walked by
method resolution order, means a new error subclass inherits its parent's status automatically and
the completeness test can enumerate the hierarchy and assert every class maps somewhere. A chain
would put a new error in whichever branch happened to match first.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException

from weathra.domain.errors import (
    AgentBudgetExceeded,
    AgentNotConfigured,
    AnalyticsNotPossible,
    AuthenticationFailed,
    AuthorizationFailed,
    McpUnavailable,
    MemoryUnavailable,
    ModelNotAllowlisted,
    NoDataForRange,
    NoEligibleModel,
    NotFound,
    PolicyUnavailable,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    QuotaExceeded,
    SigningKeysUnavailable,
    ValidationFailed,
    VectorIndexMismatch,
    WeathraError,
    all_error_classes,
)

__all__ = [
    "ErrorBody",
    "ErrorEnvelope",
    "error_response",
    "install_error_handlers",
    "status_for",
]

logger = logging.getLogger("weathra.api.errors")


class ErrorBody(BaseModel):
    """The error itself: a stable code, a readable message, and what a client needs to act."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    code: str = Field(description="Stable machine-readable identifier. Safe to branch on.")
    message: str = Field(description="Human-readable. Never carries a credential or a stack trace.")
    details: dict[str, Any] | None = Field(
        default=None, description="Field-level specifics, where the condition has any."
    )
    request_id: str | None = Field(
        default=None, description="Ties this response to the log lines that explain it."
    )


class ErrorEnvelope(BaseModel):
    """The one error shape every failing endpoint returns."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    error: ErrorBody


# The mapping, keyed by class and resolved through the MRO so a subclass inherits its parent's
# status. Ordered from the specific to the general; ``status_for`` walks a class's own MRO, so the
# order here is for reading rather than for matching.
_STATUS_BY_ERROR: dict[type[WeathraError], int] = {
    # ---------------------------------------------------------------- 400: the caller's request
    ValidationFailed: status.HTTP_400_BAD_REQUEST,
    AnalyticsNotPossible: status.HTTP_400_BAD_REQUEST,
    ModelNotAllowlisted: status.HTTP_400_BAD_REQUEST,
    # ---------------------------------------------------------------- 401 / 403: identity
    AuthenticationFailed: status.HTTP_401_UNAUTHORIZED,
    AuthorizationFailed: status.HTTP_403_FORBIDDEN,
    # ---------------------------------------------------------------- 404: not here, or not yours
    NotFound: status.HTTP_404_NOT_FOUND,
    NoDataForRange: status.HTTP_404_NOT_FOUND,
    # -------------------------------------------------- 429: slow down — for two different reasons
    # The gateway's limit and the subscription's are both 429 and must stay distinguishable by
    # code: one clears on its own and the other does not until the window turns over.
    ProviderRateLimited: status.HTTP_429_TOO_MANY_REQUESTS,
    QuotaExceeded: status.HTTP_429_TOO_MANY_REQUESTS,
    # ---------------------------------------------------------------- 502 / 504: upstream failed
    ProviderUnavailable: status.HTTP_502_BAD_GATEWAY,
    McpUnavailable: status.HTTP_502_BAD_GATEWAY,
    ProviderTimeout: status.HTTP_504_GATEWAY_TIMEOUT,
    # ---------------------------------------------------------------- 503: a dependency is not up
    AgentNotConfigured: status.HTTP_503_SERVICE_UNAVAILABLE,
    MemoryUnavailable: status.HTTP_503_SERVICE_UNAVAILABLE,
    VectorIndexMismatch: status.HTTP_503_SERVICE_UNAVAILABLE,
    SigningKeysUnavailable: status.HTTP_503_SERVICE_UNAVAILABLE,
    AgentBudgetExceeded: status.HTTP_503_SERVICE_UNAVAILABLE,
    NoEligibleModel: status.HTTP_503_SERVICE_UNAVAILABLE,
    PolicyUnavailable: status.HTTP_503_SERVICE_UNAVAILABLE,
    # ---------------------------------------------------------------- the base, if nothing else
    WeathraError: status.HTTP_500_INTERNAL_SERVER_ERROR,
}

INTERNAL_MESSAGE = (
    "Weathra hit an unexpected internal error. The failure has been logged with this request's "
    "identifier; nothing about it is included here."
)


def status_for(error: WeathraError | type[WeathraError]) -> int:
    """The HTTP status one Weathra error maps to.

    Resolved through the class's own method resolution order, so ``TokenExpired`` inherits 401 from
    ``AuthenticationFailed`` without needing its own entry — and a new subclass cannot land on the
    generic 500 by being forgotten.
    """
    error_class = error if isinstance(error, type) else type(error)
    for candidate in error_class.__mro__:
        if candidate in _STATUS_BY_ERROR:
            return _STATUS_BY_ERROR[candidate]
    return status.HTTP_500_INTERNAL_SERVER_ERROR  # pragma: no cover - WeathraError is in the table


def error_response(
    *,
    code: str,
    message: str,
    http_status: int,
    details: dict[str, Any] | None = None,
    request_id: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """The envelope, as a response."""
    envelope = ErrorEnvelope(
        error=ErrorBody(code=code, message=message, details=details, request_id=request_id)
    )
    return JSONResponse(
        status_code=http_status,
        content=jsonable_encoder(envelope, exclude_none=False),
        headers=headers,
    )


def _request_id(request: Request) -> str | None:
    """The correlation id the middleware bound, if the middleware ran."""
    return getattr(request.state, "request_id", None)


def _authenticate_header(error: WeathraError) -> dict[str, str] | None:
    """``WWW-Authenticate`` on a 401, which is what tells a client to re-authenticate.

    The reason goes in the body, not the header: a header is a poor place for a sentence, and the
    error code is what a client branches on anyway.
    """
    if isinstance(error, AuthenticationFailed):
        return {"WWW-Authenticate": 'Bearer realm="weathra"'}
    return None


def install_error_handlers(app: FastAPI) -> None:
    """Register every handler. Called once, by ``api/app.py``."""

    @app.exception_handler(WeathraError)
    async def _weathra_error(request: Request, exc: Exception) -> JSONResponse:
        error = exc if isinstance(exc, WeathraError) else WeathraError(str(exc))
        http_status = status_for(error)

        # A 5xx from a named condition is worth a stack trace in the log; a 4xx is the caller's
        # request being wrong, which is not an event worth a traceback.
        if http_status >= status.HTTP_500_INTERNAL_SERVER_ERROR:
            logger.error(
                "%s on %s: %s", error.code, request.url.path, error.message, exc_info=error
            )
        else:
            logger.info("%s on %s: %s", error.code, request.url.path, error.message)

        return error_response(
            code=error.code,
            message=error.message,
            http_status=http_status,
            details=error.details or None,
            request_id=_request_id(request),
            headers=_authenticate_header(error),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
        """FastAPI's 422, translated into the one envelope at 400.

        The field-level detail is kept — it is what makes a validation error actionable — but the
        *input* is dropped: a caller's malformed body may carry anything, and echoing it back into
        a response is how a credential someone pasted into the wrong field gets reflected.
        """
        errors = exc.errors() if isinstance(exc, RequestValidationError) else []
        fields = [
            {
                "field": ".".join(str(part) for part in detail.get("loc", ()) if part != "body"),
                "problem": detail.get("msg", "invalid"),
            }
            for detail in errors
        ]
        summary = "; ".join(
            f"{field['field'] or 'request'}: {field['problem']}" for field in fields
        )

        logger.info("request validation failed on %s: %s", request.url.path, summary)
        return error_response(
            code="validation_failed",
            message=f"The request is not valid. {summary}"
            if summary
            else "The request is not valid.",
            http_status=status.HTTP_400_BAD_REQUEST,
            details={"fields": fields} if fields else None,
            request_id=_request_id(request),
        )

    @app.exception_handler(HTTPException)
    async def _http_exception(request: Request, exc: Exception) -> JSONResponse:
        """Starlette's own errors — a 404 for an unrouted path, a 405 — in the same envelope."""
        error = exc if isinstance(exc, HTTPException) else HTTPException(500, "unexpected")
        code = {
            status.HTTP_404_NOT_FOUND: "route_not_found",
            status.HTTP_405_METHOD_NOT_ALLOWED: "method_not_allowed",
            status.HTTP_401_UNAUTHORIZED: "unauthenticated",
            status.HTTP_403_FORBIDDEN: "forbidden",
        }.get(error.status_code, "request_failed")

        return error_response(
            code=code,
            message=str(error.detail),
            http_status=error.status_code,
            request_id=_request_id(request),
            headers=getattr(error, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        """The backstop. Logs everything, returns nothing about it.

        ``exc_info`` puts the traceback in the log where an operator can find it by request id.
        The body says only that something failed, because an internal error message is written for
        developers and reveals library versions, table names, and file paths.
        """
        logger.exception("unhandled error on %s", request.url.path, exc_info=exc)
        return error_response(
            code="internal_error",
            message=INTERNAL_MESSAGE,
            http_status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            request_id=_request_id(request),
        )


def mapped_error_classes() -> dict[type[WeathraError], int]:
    """Every concrete error class and the status it resolves to.

    For the completeness test: it enumerates the hierarchy and asserts each class maps to a status
    that is not the generic 500 by accident.
    """
    return {error_class: status_for(error_class) for error_class in all_error_classes()}
