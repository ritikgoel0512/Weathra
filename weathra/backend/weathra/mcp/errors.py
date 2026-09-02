"""Structured tool errors.

``specs/mcp-weather-server`` asks for two things that pull against each other: an error must be
*structured* and machine-distinguishable, and it must be unmistakably an error rather than a
success carrying zeros. The MCP protocol gives both if you use it deliberately — a
``CallToolResult`` with ``is_error=True`` *and* structured content — so that is what every failing
tool returns.

The six classes the spec requires to be tellable apart are named in ``ToolErrorClass``. The mapping
from Weathra's own error hierarchy is one table, so a new provider error cannot quietly become
"unknown".

Nothing here forwards an upstream payload or a credential. The message is Weathra's own wording,
the details are Weathra's own fields, and ``sanitize`` is the belt to that braces.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from mcp import types
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from weathra.domain.errors import (
    AnalyticsNotPossible,
    LocationNotFound,
    NoDataForRange,
    ProviderNotFound,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    RangeOutsideCoverage,
    ToolNotFound,
    UnsupportedCriterion,
    UnsupportedHorizon,
    UnsupportedMeasure,
    ValidationFailed,
    WeathraError,
)
from weathra.redaction import redact

__all__ = [
    "ToolError",
    "ToolErrorClass",
    "error_result",
    "tool_error_for",
    "unexpected_error",
    "validation_error",
]


class ToolErrorClass(StrEnum):
    """The classes a caller must be able to tell apart (``specs/mcp-weather-server``)."""

    INVALID_INPUT = "invalid_input"
    LOCATION_NOT_RESOLVABLE = "location_not_resolvable"
    NO_DATA = "no_data"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    PROVIDER_TIMEOUT = "provider_timeout"
    PROVIDER_RATE_LIMITED = "provider_rate_limited"
    TOOL_NOT_FOUND = "tool_not_found"
    INTERNAL = "internal"


# One table, so a new error class cannot slip through as "internal" unnoticed. Order matters:
# the first match wins, and subclasses are listed before their bases.
_CLASSES: tuple[tuple[type[WeathraError], ToolErrorClass], ...] = (
    (LocationNotFound, ToolErrorClass.LOCATION_NOT_RESOLVABLE),
    (NoDataForRange, ToolErrorClass.NO_DATA),
    (AnalyticsNotPossible, ToolErrorClass.NO_DATA),
    (ProviderTimeout, ToolErrorClass.PROVIDER_TIMEOUT),
    (ProviderRateLimited, ToolErrorClass.PROVIDER_RATE_LIMITED),
    (ProviderUnavailable, ToolErrorClass.PROVIDER_UNAVAILABLE),
    (ToolNotFound, ToolErrorClass.TOOL_NOT_FOUND),
    (UnsupportedHorizon, ToolErrorClass.INVALID_INPUT),
    (RangeOutsideCoverage, ToolErrorClass.INVALID_INPUT),
    (UnsupportedMeasure, ToolErrorClass.INVALID_INPUT),
    (UnsupportedCriterion, ToolErrorClass.INVALID_INPUT),
    (ProviderNotFound, ToolErrorClass.INVALID_INPUT),
    (ValidationFailed, ToolErrorClass.INVALID_INPUT),
)


class ToolError(BaseModel):
    """A tool failure, as structured content a caller can branch on."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    ok: bool = False
    error_class: ToolErrorClass = Field(
        description="The class of failure, for a caller deciding whether to retry or ask again."
    )
    code: str = Field(min_length=1, description="Weathra's own stable error code.")
    message: str = Field(min_length=1, description="Weathra's wording. Never an upstream body.")
    details: dict[str, Any] = Field(
        default_factory=dict, description="Field-level detail. Never credential material."
    )
    retryable: bool = Field(
        description="Whether trying the same call again could plausibly succeed."
    )


_RETRYABLE = {
    ToolErrorClass.PROVIDER_TIMEOUT,
    ToolErrorClass.PROVIDER_UNAVAILABLE,
    ToolErrorClass.PROVIDER_RATE_LIMITED,
}


def classify(failure: WeathraError) -> ToolErrorClass:
    for error_type, error_class in _CLASSES:
        if isinstance(failure, error_type):
            return error_class
    return ToolErrorClass.INTERNAL


def sanitize(value: Any) -> Any:
    """Strip anything credential-shaped from a detail value, however it got there."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [sanitize(item) for item in value]
    return value


def tool_error_for(failure: WeathraError) -> ToolError:
    """A structured error from one of Weathra's own failures."""
    error_class = classify(failure)
    return ToolError(
        error_class=error_class,
        code=failure.code,
        message=redact(failure.message),
        details={key: sanitize(item) for key, item in failure.details.items()},
        retryable=error_class in _RETRYABLE,
    )


def unexpected_error(failure: BaseException) -> ToolError:
    """A failure that is not one of ours.

    Deliberately opaque: an unexpected exception's message may carry internals, so the class name
    goes in the details and nothing else escapes. The full detail belongs in the logs.
    """
    return ToolError(
        error_class=ToolErrorClass.INTERNAL,
        code="internal_error",
        message="The tool failed unexpectedly. The failure has been logged.",
        details={"exception": type(failure).__name__},
        retryable=False,
    )


def validation_error(failure: ValidationError) -> ToolError:
    """A pydantic failure as an invalid-input tool error, naming each offending argument.

    The SDK validates each field against the declared schema before the handler runs; this covers
    the *cross-field* rules the hand-written models add — "supply a name or coordinates, not
    both", "a historical comparison needs both bounds" — which cannot be expressed in a per-field
    schema and would otherwise surface as an opaque internal failure.
    """
    fields: list[dict[str, Any]] = []
    for error in failure.errors():
        location = ".".join(str(part) for part in error["loc"]) or "(request)"
        fields.append({"field": location, "problem": error["msg"]})

    summary = "; ".join(f"{item['field']}: {item['problem']}" for item in fields)
    return ToolError(
        error_class=ToolErrorClass.INVALID_INPUT,
        code="validation_failed",
        message=f"The call's arguments are not valid — {summary}.",
        details={"fields": fields},
        retryable=False,
    )


def error_result(error: ToolError) -> types.CallToolResult:
    """A tool error as an MCP result: structured *and* flagged as an error.

    Both halves matter. The structured content is what lets a caller branch on the class; the
    ``is_error`` flag is what stops the failure being mistaken for a success — which is the exact
    thing ``specs/mcp-weather-server`` forbids.
    """
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=f"{error.code}: {error.message}")],
        structured_content=error.model_dump(mode="json"),
        is_error=True,
    )
