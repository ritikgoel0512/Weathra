#!/usr/bin/env python3
"""List the gateway models available to the configured OpenRouter account.

`LLM_MODEL` is configuration, not architecture (design.md decision 3): no model id appears in the
backend outside its `Settings` default, and changing the configured model needs no code change. The
question that follows is a practical one — *which* id to put there — and answering it by reading a
web page is how a stale choice ends up committed. This script answers it from the account that will
actually serve the requests:

    python scripts/list_openrouter_models.py                 # everything, widest context first
    python scripts/list_openrouter_models.py --free          # zero-cost models only
    python scripts/list_openrouter_models.py --free --tools   # ... that also expose tool calling
    python scripts/list_openrouter_models.py --search instruct
    python scripts/list_openrouter_models.py --json          # for a script to consume

**It never prints the credential.** `OPENROUTER_API_KEY` is read through `Settings` as a
`SecretStr` and used for exactly one thing — the `Authorization` header on the outbound request.
The header line says only *whether* a credential was sent. Every message this script prints goes
through `redact()` first, so a gateway error that echoed something credential-shaped back at us
still cannot reach the terminal or a shell log.

**It uses the project's own HTTP path**, not a vendor SDK and not a bare `httpx` call: the same
`build_http_client` factory and the same `request_json` retry-and-translate loop the weather
providers use, so a timeout or a rate limit here fails the way it fails everywhere else and reports
no response body. `pyproject.toml` gains no dependency.

**Reading the output.** Weathra's graph executes tools and the model proposes (design.md decision
2), so a tool-calling capability is *informative rather than required* — what the routing path
actually depends on is a model that reliably emits a JSON object matching a supplied schema, within
`LLM_JSON_MAX_ATTEMPTS` tries. Context length matters more than parameter count: a comparison over
several locations carries a lot of normalized series into the prompt. The eval suite is what
settles the choice — `weathra-evaluate` against a candidate id is the real test, and this script
only narrows the field.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

from weathra.config import Settings
from weathra.domain.errors import WeathraError
from weathra.providers.http import build_http_client, request_json
from weathra.redaction import redact

PROVIDER = "openrouter"

# What a "supported_parameters" entry has to say for the gateway to be claiming tool calling.
TOOL_PARAMETERS = frozenset({"tools", "tool_choice", "functions"})

# Per-million-token pricing is what people compare; the gateway quotes per token.
PER_MILLION = 1_000_000


# Variables an environment can carry as the empty string — a `NAME=` line in a `.env`, or an export
# from a shell that sourced one. pydantic-settings reads `NAME=` as the empty string rather than as
# "unset", and an environment variable outranks the `.env` file, so an empty export silently shadows
# a real value further down. None of the three means anything to this script when empty: an empty
# project URL fails URL validation, an empty service-role key trips the request-serving guard while
# carrying no credential at all, and an empty gateway key would be sent as `Bearer ` and reported as
# authenticated. Dropping them leaves the `.env` — and then the documented defaults — to answer.
EMPTY_MEANS_ABSENT = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY")


def settings() -> Settings:
    """Configuration, read the one way the backend reads it.

    `SUPABASE_URL` is required to construct `Settings` and irrelevant to this script, so a
    placeholder stands in when the environment has none — the same accommodation
    `scripts/dump_openapi.py` makes, and for the same reason.
    """
    for name in EMPTY_MEANS_ABSENT:
        if os.environ.get(name, "").strip() == "":
            os.environ.pop(name, None)

    os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
    # This script reads a public catalogue and touches no database, so it builds the configuration
    # without the privileged credential whatever the environment or the `.env` says — an init
    # argument outranks both, and the request-serving guard is then left with nothing to refuse.
    return Settings(supabase_service_role_key=None)


def credential(configured: Settings) -> str | None:
    """The gateway key, or None when the account is unauthenticated.

    A `.env` line reading `OPENROUTER_API_KEY=` parses as the empty string, which is not `None` and
    is not a credential either. Treating it as absent is what keeps `Bearer ` off the request and
    the header line in the output honest.
    """
    secret = configured.openrouter_api_key
    if secret is None:
        return None
    value = secret.get_secret_value().strip()
    return value or None


async def fetch_models(configured: Settings) -> list[dict[str, Any]]:
    """The gateway's model catalogue, over the shared client and the shared retry policy."""
    client = build_http_client(configured)
    key = credential(configured)
    if key is not None:
        # The one use of the value. It goes onto the request and is never rendered.
        client.headers["Authorization"] = f"Bearer {key}"

    url = f"{configured.openrouter_base_url.rstrip('/')}/models"
    try:
        payload = await request_json(client, url, params={}, provider=PROVIDER, settings=configured)
    finally:
        await client.aclose()

    entries = payload.get("data")
    if not isinstance(entries, list):
        raise SystemExit(f"{PROVIDER} returned no model list; the response shape was unexpected.")
    return [entry for entry in entries if isinstance(entry, dict)]


# ---------------------------------------------------------------- reading one entry


def _price(model: dict[str, Any], field: str) -> float | None:
    """A per-token price as a float, or None when the gateway does not quote one."""
    pricing = model.get("pricing")
    if not isinstance(pricing, dict):
        return None
    try:
        return float(pricing[field])
    except (KeyError, TypeError, ValueError):
        return None


def is_free(model: dict[str, Any]) -> bool:
    """Free means the gateway quotes zero for both directions — not merely a suffix on the id."""
    prompt, completion = _price(model, "prompt"), _price(model, "completion")
    if prompt is None or completion is None:
        return str(model.get("id", "")).endswith(":free")
    return prompt == 0.0 and completion == 0.0


def tool_support(model: dict[str, Any]) -> bool | None:
    """True, False, or None where the gateway exposes nothing about it.

    The three-way answer is the honest one: "this model does not support tools" and "the catalogue
    does not say" are different facts, and collapsing them would invent the first.
    """
    parameters = model.get("supported_parameters")
    if not isinstance(parameters, list):
        return None
    return any(str(parameter) in TOOL_PARAMETERS for parameter in parameters)


def context_length(model: dict[str, Any]) -> int | None:
    """The usable context, preferring the serving provider's figure over the nominal one."""
    top = model.get("top_provider")
    if isinstance(top, dict):
        value = top.get("context_length")
        if isinstance(value, int):
            return value
    value = model.get("context_length")
    return value if isinstance(value, int) else None


# ---------------------------------------------------------------- selecting and rendering


def select(
    models: list[dict[str, Any]],
    *,
    free_only: bool,
    tools_only: bool,
    search: str | None,
) -> list[dict[str, Any]]:
    """Filter, then order free-first and widest-context-first within each group."""
    chosen = models
    if free_only:
        chosen = [model for model in chosen if is_free(model)]
    if tools_only:
        chosen = [model for model in chosen if tool_support(model) is True]
    if search:
        needle = search.lower()
        chosen = [
            model
            for model in chosen
            if needle in str(model.get("id", "")).lower()
            or needle in str(model.get("name", "")).lower()
        ]
    return sorted(
        chosen,
        key=lambda model: (not is_free(model), -(context_length(model) or 0), str(model.get("id"))),
    )


def _tokens(value: int | None) -> str:
    if value is None:
        return "—"
    if value >= 1_000:
        return f"{value // 1_000}k"
    return str(value)


def _cost(model: dict[str, Any]) -> str:
    """Per-million-token prompt/completion cost, or `free`, or `—` when unquoted."""
    if is_free(model):
        return "free"
    prompt, completion = _price(model, "prompt"), _price(model, "completion")
    if prompt is None or completion is None:
        return "—"
    return f"${prompt * PER_MILLION:.2f}/${completion * PER_MILLION:.2f}"


def _tools(model: dict[str, Any]) -> str:
    return {True: "yes", False: "no", None: "—"}[tool_support(model)]


def render(models: list[dict[str, Any]], *, total: int, authenticated: bool) -> str:
    """A fixed-width table. Sorted free-first, so the useful rows are the first ones read."""
    if not models:
        return "No model matched. Widen the filters, or drop --free."

    rows = [
        (
            str(model.get("id", "?")),
            _tokens(context_length(model)),
            _tools(model),
            _cost(model),
            str(model.get("name", "")),
        )
        for model in models
    ]
    headers = ("MODEL ID", "CONTEXT", "TOOLS", "$/M IN,OUT", "NAME")
    widths = [
        max(len(header), *(len(row[index]) for row in rows)) for index, header in enumerate(headers)
    ]

    def line(cells: tuple[str, ...]) -> str:
        return "  ".join(cell.ljust(widths[index]) for index, cell in enumerate(cells)).rstrip()

    body = [
        line(headers),
        line(tuple("-" * width for width in widths)),
        *(line(row) for row in rows),
    ]
    credential = "with a credential" if authenticated else "anonymously"
    free = sum(1 for model in models if is_free(model))
    tooled = sum(1 for model in models if tool_support(model) is True)

    return "\n".join(
        [
            f"{len(models)} of {total} models shown ({free} free, {tooled} exposing tool calling).",
            f"Catalogue fetched {credential}; the key itself is never printed.",
            "",
            *body,
            "",
            "TOOLS is informative, not a requirement: Weathra's graph executes tools and the model",
            "proposes (design.md decision 2). What the routing path needs is reliable JSON-object",
            "output against a supplied schema. Set a candidate as LLM_MODEL in backend/.env",
            "and let `weathra-evaluate` decide — no code change is involved either way.",
        ]
    )


# ---------------------------------------------------------------- entry point


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="list_openrouter_models.py",
        description=(
            "List the gateway models available to the configured OpenRouter account. "
            "Never prints OPENROUTER_API_KEY."
        ),
    )
    parser.add_argument("--free", action="store_true", help="only models quoted at zero cost")
    parser.add_argument(
        "--tools", action="store_true", help="only models exposing tool/function calling"
    )
    parser.add_argument("--search", metavar="TEXT", help="substring match on the id or the name")
    parser.add_argument(
        "--limit", type=int, default=40, metavar="N", help="rows to show (0 for all; default 40)"
    )
    parser.add_argument("--json", action="store_true", help="emit the filtered entries as JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = parse(argv)
    configured = settings()

    try:
        models = asyncio.run(fetch_models(configured))
    except WeathraError as error:
        # `providers/http.py` forwards no response body, and redact() is the belt to that braces.
        print(f"{PROVIDER}: {redact(str(error))}", file=sys.stderr)
        return 1

    chosen = select(
        models, free_only=arguments.free, tools_only=arguments.tools, search=arguments.search
    )
    limited = chosen if arguments.limit <= 0 else chosen[: arguments.limit]

    if arguments.json:
        print(json.dumps(limited, indent=2, sort_keys=True))
    else:
        print(
            render(
                limited,
                total=len(models),
                authenticated=credential(configured) is not None,
            )
        )
        if len(chosen) > len(limited):
            # Flushed first, so the note lands after the table when both are redirected together.
            sys.stdout.flush()
            print(
                f"\n{len(chosen) - len(limited)} more matched; pass --limit 0 to see them all.",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
