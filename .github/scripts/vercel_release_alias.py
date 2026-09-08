#!/usr/bin/env python3
"""Resolve the public production domain of the deployment this run just promoted.

Task 23.5. `vercel deploy` prints the deployment's *own* URL — `weathra-<hash>-weathra.vercel.app` —
and that is not the URL production is served on. Vercel's Standard Deployment Protection answers
every generated deployment URL with `302` to `vercel.com/sso-api`, so a release that verified the
printed URL could never see a 200 no matter how healthy the deployment was. Worse, it could not see
a *500* either: the 2026-09-08 release promoted a frontend that returned 500 on every route, and the
verification could not tell the difference between that and Vercel's login redirect.

The URL production is actually served on is the project's production domain, which the deployment
object lists in `alias` — the same field, and the same first entry, that the CLI itself prints as
`▲ Aliased` (`commands/deploy/index.js`, its `alias-assigned` handler). So this asks the API for the
deployment the deploy step just created and reads it from there.

Resolving it rather than hard-coding it is what keeps the check honest: a hard-coded hostname stays
green while pointing at whatever was promoted last, including a deployment from a different commit,
and it would silently outlive a domain change. Reading it from *this* deployment means the thing
verified and the thing promoted cannot come apart.

**What it proves before printing anything.** The deployment is fetched by the hostname the deploy
step printed, and then held to four conditions: it belongs to this project, its target is
`production`, it is `READY`, and its aliases have been assigned. Those together are Vercel's own
definition of "this deployment is what production now serves" — so a green verification cannot mean
"some other deployment answered".

Only project- and deployment-scoped reads, because that is what this pipeline's team-scoped token
can do — see `vercel_release_env.py` for why `vercel pull` cannot be used here at all.
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.parse
from collections.abc import Callable
from typing import Any

from vercel_release_env import ReleaseError, make_fetch_json

FetchJson = Callable[[str], Any]


def deployment_host(url: str) -> str:
    """The bare hostname of the URL `vercel deploy` printed.

    The deployments API takes a hostname where an id is expected — `getDeployment` in the CLI does
    the same conversion — so the deploy step's stdout can be handed straight through.
    """
    trimmed = url.strip()
    if not trimmed:
        raise ReleaseError("the deploy step produced no URL to verify")
    if "//" in trimmed:
        parsed = urllib.parse.urlsplit(trimmed)
        host = parsed.netloc or parsed.path
    else:
        host = trimmed
    host = host.split("/")[0]
    if not host:
        raise ReleaseError(f"the deploy step produced no hostname to verify: {trimmed!r}")
    return host


def read_deployment(fetch: FetchJson, host: str) -> dict[str, Any]:
    deployment = fetch(f"/v13/deployments/{urllib.parse.quote(host, safe='')}")
    if not isinstance(deployment, dict) or not isinstance(deployment.get("id"), str):
        raise ReleaseError(f"the Vercel API returned no deployment for {host}")
    return deployment


def production_alias(deployment: dict[str, Any], host: str, project_id: str) -> list[str]:
    """The production domains this deployment is served on, most canonical first.

    Each refusal below is a way a verification could pass while proving nothing, so none of them is
    a formality:

    - a different project's deployment would mean the ownership check was bypassed entirely;
    - a `preview` target would mean the promotion did not happen and production is untouched;
    - a deployment that is not `READY`, or whose aliases are not assigned, would mean production is
      still serving the *previous* build — so a 200 would be the old frontend answering for the new
      one, which is the failure this whole step exists to make impossible.

    A custom domain is preferred over a `.vercel.app` one when both are present: it is the address
    the product is actually used at, and it is the one Standard Protection never covers.
    """
    if deployment.get("url") != host:
        raise ReleaseError(
            f"the Vercel API returned a different deployment than the one just promoted ({host})"
        )
    if deployment.get("projectId") != project_id:
        raise ReleaseError(
            "the promoted deployment does not belong to the project in WEATHRA_VERCEL_PROJECT_ID"
        )
    if deployment.get("target") != "production":
        raise ReleaseError(
            f"the promoted deployment's target is {deployment.get('target')!r}, not 'production', "
            "so production is not what this run deployed"
        )
    if deployment.get("readyState") != "READY":
        raise ReleaseError(
            f"the promoted deployment is {deployment.get('readyState')!r}, not READY, so "
            "production is still serving the previous build"
        )
    if not deployment.get("aliasAssigned"):
        raise ReleaseError(
            "the promoted deployment's aliases are not assigned yet, so production is still "
            "serving the previous build"
        )
    if deployment.get("aliasError"):
        raise ReleaseError("Vercel reported an alias error while promoting this deployment")

    aliases = deployment.get("alias")
    if not isinstance(aliases, list) or not aliases:
        raise ReleaseError(
            "the promoted deployment carries no production alias, so there is no public URL to "
            "verify; production is reachable only on the SSO-protected deployment URL"
        )
    hostnames = [alias for alias in aliases if isinstance(alias, str) and alias]
    if not hostnames:
        raise ReleaseError("the promoted deployment's alias list holds no hostname")
    custom = [name for name in hostnames if not name.endswith(".vercel.app")]
    return custom + [name for name in hostnames if name.endswith(".vercel.app")]


def run(project_id: str, deployment_url: str, fetch: FetchJson) -> int:
    host = deployment_host(deployment_url)
    hostnames = production_alias(read_deployment(fetch, host), host, project_id)
    # Hostnames are public, and the log is where a wrong one gets noticed; stderr so that stdout
    # carries the answer alone and the workflow can capture it.
    print(
        f"the promoted deployment is production and serves: {', '.join(hostnames)}", file=sys.stderr
    )
    print(hostnames[0])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__ and __doc__.splitlines()[0])
    parser.add_argument("--project-id", required=True, help="the existing project's id")
    parser.add_argument(
        "--deployment-url", required=True, help="the URL `vercel deploy` printed for this run"
    )
    arguments = parser.parse_args(argv)

    token = os.environ.get("VERCEL_TOKEN", "").strip()
    if not token:
        print("VERCEL_TOKEN is not set; refusing to continue", file=sys.stderr)
        return 1

    try:
        return run(arguments.project_id.strip(), arguments.deployment_url, make_fetch_json(token))
    except ReleaseError as error:
        print(f"{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
