#!/usr/bin/env python3
"""Cross-check the model catalog against what the gateway currently publishes.

Group 27 turns the catalog into something the resolver reads, which makes a question that did not
matter before matter now: *are the entries we are allowed to resolve actually still there?* A row
seeded from a published listing is a claim about a moment, and gateways withdraw models.

Three states, deliberately kept apart, because conflating them is how a stale allowlist survives:

    CATALOG_ENTRY_EXISTS      the row is in `model_catalog`, whatever its status
    MODEL_PROVIDER_AVAILABLE  the gateway still publishes that provider-and-model pair
    MODEL_CURRENTLY_ELIGIBLE  the row exists, is enabled, and some policy names it as a candidate

An entry can be eligible and unavailable, which is the dangerous combination and the one this
script exists to surface. It can also be available and ineligible, which is fine — a disabled model
is a decision somebody made.

**It reports; it does not act.** Disabling a model is an administrative write with an audit row and
a cross-role refusal (`entitlements/catalog.py`), and it should be a person's decision made against
this output rather than a script's decision made at three in the morning. The command it suggests
is the one to run.

**It needs no credential.** The gateway's model listing is public, so this is the safest available
mechanism: it makes no inference call, spends nothing, and cannot leak a key it never reads. That
also bounds what it can prove — a published model can still fail at call time, and the failover of
`specs/model-policy` is what handles that. This answers "has it been withdrawn", not "will it work".

    python scripts/check_catalog_availability.py
    python scripts/check_catalog_availability.py --json

Exit status is 1 when an *eligible* entry is unavailable, so CI or a scheduled job can gate on it,
and 0 when everything eligible is published.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from sqlalchemy import text

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.providers.http import build_http_client, request_json
from weathra.redaction import redact

MODELS_URL = "https://openrouter.ai/api/v1/models"


async def published_gateway_models(settings: Settings) -> set[str]:
    """Every model identifier the gateway currently lists, read without a credential.

    Through the project's own HTTP path rather than a bare `httpx` call, so a timeout or a rate
    limit here fails the way it fails everywhere else and reports no response body.
    """
    async with build_http_client(settings) as client:
        payload = await request_json(
            client, MODELS_URL, params={}, provider="openrouter", settings=settings
        )
    return {entry["id"] for entry in payload.get("data", []) if isinstance(entry, dict)}


async def catalog_state(settings: Settings) -> list[dict[str, Any]]:
    """Each catalog entry with its status and whether any policy names it.

    Read privileged because this is an operational check rather than a request, and read in one
    query so a concurrent administrative write cannot make the eligibility and the status disagree.
    """
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            rows = await session.execute(
                text(
                    "SELECT entry.catalog_key, entry.gateway_provider, entry.gateway_model, "
                    "       entry.status, "
                    "       EXISTS (SELECT 1 FROM model_policies "
                    "                WHERE entry.catalog_key = ANY(candidate_catalog_keys)) "
                    "  FROM model_catalog AS entry ORDER BY entry.catalog_key"
                )
            )
            return [
                {
                    "catalog_key": row[0],
                    "gateway_provider": row[1],
                    "gateway_model": row[2],
                    "status": row[3],
                    "named_by_a_policy": row[4],
                }
                for row in rows
            ]
    finally:
        await engines.dispose()


def classify(entries: list[dict[str, Any]], published: set[str]) -> list[dict[str, Any]]:
    for entry in entries:
        entry["provider_available"] = entry["gateway_model"] in published
        entry["currently_eligible"] = entry["status"] == "enabled" and entry["named_by_a_policy"]
    return entries


def report(entries: list[dict[str, Any]]) -> int:
    """Print a human-readable table and return the exit status."""
    width = max((len(entry["catalog_key"]) for entry in entries), default=12)
    header = "catalog key".ljust(width)
    print(f"{header}  {'status':9}  {'eligible':8}  {'published':9}  gateway model")
    stranded: list[dict[str, Any]] = []
    for entry in entries:
        if entry["currently_eligible"] and not entry["provider_available"]:
            stranded.append(entry)
        print(
            f"{entry['catalog_key'].ljust(width)}  "
            f"{entry['status']:9}  "
            f"{('yes' if entry['currently_eligible'] else 'no'):8}  "
            f"{('yes' if entry['provider_available'] else 'NO'):9}  "
            f"{entry['gateway_provider']}/{entry['gateway_model']}"
        )

    if not stranded:
        print("\nEvery eligible catalog entry is published by the gateway.")
        return 0

    print(
        f"\n{len(stranded)} eligible entr{'y is' if len(stranded) == 1 else 'ies are'} no longer "
        "published by the gateway. A policy can still resolve them, and the call will fail."
    )
    for entry in stranded:
        print(
            f"  {entry['catalog_key']}: disable it, or point it at a published model.\n"
            f"    CatalogStore(session).disable({entry['catalog_key']!r}, acting_principal=...)"
        )
    print(
        "\nDisabling is the sanctioned response: it takes the entry out of resolution while its "
        "recorded usage and evaluation results stay attributed to it."
    )
    return 1


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    arguments = parser.parse_args()

    settings = Settings()  # type: ignore[call-arg]
    entries = classify(await catalog_state(settings), await published_gateway_models(settings))

    if arguments.json:
        print(json.dumps(entries, indent=2, sort_keys=True))
        return (
            1
            if any(e["currently_eligible"] and not e["provider_available"] for e in entries)
            else 0
        )
    return report(entries)


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as failure:
        print(redact(f"catalog availability check failed: {failure}"), file=sys.stderr)
        sys.exit(2)
