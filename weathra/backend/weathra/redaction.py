"""Keeping token material out of logs, error bodies, and tool results.

Lives at the package root rather than under ``auth/`` because it is a pure string utility with no
dependencies, and because everything that renders text for a caller needs it — the MCP tool
boundary included. Under ``auth/`` it would have forced ``mcp/`` to import the auth layer, which
``specs/mcp-weather-server`` forbids.

``specs/authentication`` requires that an authentication failure is recorded *with its reason* and
without the token, and that neither a log record nor a response body carries token or secret
material. Two mechanisms:

* ``redact`` rewrites anything that looks like a credential — a compact JWT, a bearer header, a
  ``key=value`` pair naming a secret — into a placeholder.
* ``RedactingFilter`` applies it to every log record, so a caller who passes a token into a message
  by accident still cannot log one.

The filter is a backstop, not the design. The design is that the token is validated and discarded,
and that ``Principal`` has no field to hold one — the failure paths raise coded errors whose
messages are written here, not built from the credential.
"""

from __future__ import annotations

import logging
import re

__all__ = ["PLACEHOLDER", "RedactingFilter", "install_redaction", "redact"]

PLACEHOLDER = "[redacted]"

# A compact JWS: three base64url segments. Matches an access token wherever it appears.
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b")

# `Authorization: Bearer <anything>`, including a value that is not a JWT.
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{4,}")

# A named secret in a `key=value` or `"key": "value"` shape. The name may carry a prefix or
# suffix — SUPABASE_SERVICE_ROLE_KEY, my_api_key — so the pattern does not anchor on a word
# boundary an underscore would swallow. A value that is already the placeholder is left alone, so
# a second pass over redacted text does not mangle it.
_NAMED_SECRET = re.compile(
    r"(?i)([\w-]*(?:"
    r"access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|"
    r"service[_-]?role[_-]?key|anon[_-]?key|password|secret|authorization"
    r")[\w-]*)"
    r"(\s*[:=]\s*)"
    r"(\"[^\"]*\"|'[^']*'|(?!\[redacted\])[^\s,;&)}\]]+)"
)

# A Postgres URL's password. Configuration errors love to print a connection string.
_DSN_PASSWORD = re.compile(r"(?i)\b(postgres(?:ql)?(?:\+\w+)?://[^:/\s]+:)([^@\s]+)(@)")


def redact(value: str) -> str:
    """Rewrite anything credential-shaped in a string."""
    if not value:
        return value
    redacted = _JWT.sub(PLACEHOLDER, value)
    # The scheme word goes with the value: leaving "Bearer" behind would make the named-secret
    # pass treat it as the secret and redact it a second time.
    redacted = _BEARER.sub(PLACEHOLDER, redacted)
    redacted = _NAMED_SECRET.sub(rf"\1\2{PLACEHOLDER}", redacted)
    redacted = _DSN_PASSWORD.sub(rf"\1{PLACEHOLDER}\3", redacted)
    return redacted


class RedactingFilter(logging.Filter):
    """A logging filter that redacts the message and every formatting argument."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)

        if isinstance(record.args, dict):
            record.args = {
                key: redact(item) if isinstance(item, str) else item
                for key, item in record.args.items()
            }
        elif isinstance(record.args, tuple):
            record.args = tuple(
                redact(item) if isinstance(item, str) else item for item in record.args
            )

        # Structured extras travel on the record itself, so they need the same treatment.
        for attribute in ("token", "authorization", "credential", "reason", "detail"):
            current = getattr(record, attribute, None)
            if isinstance(current, str):
                setattr(record, attribute, redact(current))

        return True


def install_redaction(logger: logging.Logger | None = None) -> RedactingFilter:
    """Attach the filter to a logger — the root logger by default — and return it."""
    target = logger or logging.getLogger()
    existing = next((found for found in target.filters if isinstance(found, RedactingFilter)), None)
    if existing is not None:
        return existing
    installed = RedactingFilter()
    target.addFilter(installed)
    for handler in target.handlers:
        handler.addFilter(installed)
    return installed
