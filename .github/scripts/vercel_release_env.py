#!/usr/bin/env python3
"""Resolve the existing Vercel project and its Production environment, without `vercel pull`.

Task 23.5. `frontend-release.yml` builds the frontend *on the runner*, which needs two files that
`vercel pull` would normally write into `.vercel/`:

  - `project.json` — the project link and the project's settings, above all `rootDirectory`, which
    is what makes `vercel build` build `weathra/frontend` from the repository root.
  - `.env.production.local` — the Production environment variables, which Next.js inlines into the
    bundle at build time.

`vercel pull` cannot produce them under this pipeline's credential. Reading Vercel CLI 59.11.7:
`getLinkedProject` resolves `--project <id>` *before* printing its `Retrieving project…` spinner and
then, once it holds a link, unconditionally calls `getOrgById(orgId)` — `GET /v2/teams/<team_id>`.
A token scoped to a team rather than to the whole account is refused there with 403
`team_unauthorized`, and the CLI reports that refusal as *"Could not retrieve Project Settings. To
link your Project, remove the `.vercel` directory and deploy again"* — a message about a directory
that does not exist on a fresh runner. `vercel deploy` survives it, because it alone passes
`allowOwnerLookupFallback`; `pull` passes neither that nor `skipRemoteLookup` and then *uses*
`org.type`/`org.id`, so for `pull` the refusal is fatal. No flag changes that.

So this script writes those two files from the project-scoped REST API the token *can* reach, in
the exact formats the CLI reads back:

  - `GET /v9/projects/<id>` — the project, whose `accountId` is the owning team. Every field
    `writeProjectSettings` persists is copied from it, so `project.json` is what a successful
    `vercel pull` would have written.
  - `GET /v9/projects/<id>/env?decrypt=true` — the environment variables, filtered to Production
    and serialised the way `vercel env pull` serialises them (`KEY="value"`, sorted, newlines
    escaped), because `vercel build` parses that file with dotenv.

**It fails closed.** An HTTP status that is not 200, a response that is not the shape expected, a
Production variable whose value cannot be read, a missing public value the frontend needs, a name
that reads as a backend secret, or a value that cannot be represented in a dotenv file without
being silently altered — each ends the release rather than producing a partial environment for the
build to bake in. A frontend built from half an environment deploys perfectly and then fails in a
browser.

Nothing here prints a value, and the token is read from the environment so that no argument list
names it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

API = "https://api.vercel.com"

# What Next.js needs in order to produce a working bundle. `NEXT_PUBLIC_` values are inlined at
# build time, so a build that runs without them succeeds and ships a frontend that cannot reach
# Supabase or the backend — which is why their absence is a failure here rather than a warning.
# Either Supabase client-key name satisfies the second requirement; the project may hold the
# publishable key or the anon key it replaces.
REQUIRED_PUBLIC_NAMES: tuple[str, ...] = (
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_API_BASE_URL",
)
REQUIRED_PUBLIC_ALTERNATIVES: tuple[tuple[str, ...], ...] = (
    ("NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
)

# Names that name a backend secret, compared as upper-case substrings. This mirrors `SECRET_NAMES`
# in `weathra/frontend/scripts/secret-containment.ts` — the same policy applied one step earlier, to
# the environment the build is handed rather than to the bundle it produces. `DATABASE_URL` catches
# `DATABASE_URL_PRIVILEGED`, and `SERVICE_ROLE` catches every spelling of the key that bypasses Row
# Level Security.
#
# `VERCEL_TOKEN` is on the list because this process holds one: a release credential written into a
# build environment would reach the build's logs, and a `NEXT_PUBLIC_` prefix would reach browsers.
SECRET_NAME_FRAGMENTS: tuple[str, ...] = (
    "SERVICE_ROLE",
    "SERVICE_KEY",
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "INFERENCE_API_KEY",
    "JWT_SECRET",
    "POSTGRES_PASSWORD",
    "DB_PASSWORD",
    "PRIVATE_KEY",
    "PEXELS_API_KEY",
    "UNSPLASH_ACCESS_KEY",
    "RENDER_API_KEY",
    "VERCEL_TOKEN",
)

# The variables whose value has to be a URL a browser can fetch, and the reason this check exists
# at all. `frontend/lib/env.ts` reads each of these as `process.env.NEXT_PUBLIC_…`, which Next.js
# *inlines at build time* — the generated Edge middleware bundle contains the literal and no runtime
# lookup survives in it. So a value that is not a URL is not a misconfiguration the deployment can
# recover from: it is compiled into the bundle, and `@supabase/supabase-js` throws
# "Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL." on every request before any of the
# application's own code runs, which arrives as MIDDLEWARE_INVOCATION_FAILED and a 500 on every
# route. That is exactly how the 2026-09-08 release failed, and the value was present and non-empty
# the whole time — so presence is not the property worth checking. Checking the shape here costs one
# comparison and turns a promoted-and-broken production frontend into a release that never builds.
URL_VALUED_NAMES: tuple[str, ...] = (
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_API_BASE_URL",
)

# Dropped rather than written, matching the CLI's own `VARIABLES_TO_IGNORE`: Vercel injects these
# itself, and a stale copy in the env file would override the live one.
VARIABLES_TO_IGNORE: frozenset[str] = frozenset(
    {"VERCEL_ANALYTICS_ID", "VERCEL_SPEED_INSIGHTS_ID", "VERCEL_WEB_ANALYTICS_ID"}
)

# The settings `writeProjectSettings` persists, in its order. `rootDirectory` is the load-bearing
# one — `vercel build` reads it from this file to find the application inside the repository — but
# the whole set is copied so that the file is what the CLI would have written, not a subset that
# happens to be enough today.
SETTING_NAMES: tuple[str, ...] = (
    "createdAt",
    "framework",
    "devCommand",
    "installCommand",
    "buildCommand",
    "outputDirectory",
    "rootDirectory",
    "directoryListing",
    "nodeVersion",
)

ENV_FILE_HEADER = "# Written by .github/scripts/vercel_release_env.py — ephemeral runner state.\n"

# dotenv accepts a wider set of names, but a release is not the place to discover which. This is the
# shape every Vercel variable name already has.
VALID_NAME = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*\Z")

FetchJson = Callable[[str], Any]


class ReleaseError(Exception):
    """A condition that must end the release rather than be worked around."""


def _api_error_code(body: bytes) -> str:
    """The `error.code` from a Vercel error body, for the message. Never the body itself."""
    try:
        parsed = json.loads(body.decode("utf-8", "replace"))
        code = parsed.get("error", {}).get("code")
    except (ValueError, AttributeError):
        return "unknown"
    return str(code) if code else "unknown"


def make_fetch_json(token: str, *, attempts: int = 3, pause: float = 2.0) -> FetchJson:
    """A reader for the Vercel API that validates the status before anything reads the body.

    The token travels in a header rather than in a query string or an argument list, so it appears
    in neither the runner's process list nor any URL this function reports on failure.
    """

    def fetch(path: str) -> Any:
        last: ReleaseError | None = None
        for attempt in range(1, attempts + 1):
            request = urllib.request.Request(
                f"{API}{path}",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.status != 200:
                        raise ReleaseError(f"the Vercel API answered {response.status} for {path}")
                    payload = response.read()
            except urllib.error.HTTPError as error:
                try:
                    body = error.read()
                except (AttributeError, OSError, ValueError):
                    # An error with no readable body still has a status, which is the part that
                    # decides whether this is a credential problem or a transient one.
                    body = b""
                code = _api_error_code(body)
                if error.code == 401:
                    raise ReleaseError(
                        "the Vercel API refused the release token (401 "
                        f"{code}): VERCEL_TOKEN is missing, expired or malformed"
                    ) from None
                if error.code == 403:
                    raise ReleaseError(
                        "the Vercel API refused the release token access to "
                        f"{path} (403 {code}): the token's scope does not cover this project"
                    ) from None
                if error.code in (408, 429) or error.code >= 500:
                    last = ReleaseError(f"the Vercel API answered {error.code} {code} for {path}")
                else:
                    raise ReleaseError(
                        f"the Vercel API answered {error.code} {code} for {path}"
                    ) from None
            except urllib.error.URLError as error:
                last = ReleaseError(
                    f"the Vercel API could not be reached for {path}: {error.reason}"
                )
            else:
                try:
                    return json.loads(payload)
                except ValueError:
                    raise ReleaseError(
                        f"the Vercel API returned a body for {path} that is not JSON"
                    ) from None
            if attempt < attempts:
                time.sleep(pause)
        raise last or ReleaseError(f"the Vercel API could not be read for {path}")

    return fetch


def read_project(fetch: FetchJson, project_id: str) -> dict[str, Any]:
    project = fetch(f"/v9/projects/{urllib.parse.quote(project_id, safe='')}")
    if not isinstance(project, dict) or not isinstance(project.get("id"), str):
        raise ReleaseError("the Vercel API did not return a project for WEATHRA_VERCEL_PROJECT_ID")
    if not isinstance(project.get("accountId"), str) or not project["accountId"]:
        raise ReleaseError(
            "the project the Vercel API returned carries no accountId, so its owner cannot be "
            "checked; refusing to build"
        )
    if not isinstance(project.get("name"), str) or not project["name"]:
        raise ReleaseError("the project the Vercel API returned carries no name")
    return project


def assert_owner(project: dict[str, Any], expected_org_id: str) -> None:
    """Hold the project's real owner to the team this release is allowed to publish to.

    The ownership question the old pipeline asked of `vercel pull` — and never got an answer to —
    asked here instead. `accountId` is the resolved answer: an identifier handed to a lookup is an
    assumption, whereas this is the project the id actually named saying who owns it. A mismatch
    ends the run before anything is built, and neither id is printed: which two ids disagreed is
    not something a public log needs to carry.
    """
    if project["accountId"] != expected_org_id:
        raise ReleaseError(
            "the project resolved from WEATHRA_VERCEL_PROJECT_ID is not owned by the team in "
            "WEATHRA_VERCEL_ORG_ID; refusing to build or deploy. WEATHRA_VERCEL_ORG_ID must hold "
            "the team's id — the `team_…` value — and not its slug"
        )


def project_link(project: dict[str, Any]) -> dict[str, Any]:
    """`.vercel/project.json`, in the shape `writeProjectSettings` writes it.

    `orgId` is taken from the project's own `accountId` rather than from `WEATHRA_VERCEL_ORG_ID`, so
    the file records who owns the project rather than who we expected to. That is what makes the
    workflow's later check on this file a real second gate rather than a restatement of its input.

    `projectName` matters more than it looks: with it present, `vercel deploy --prebuilt` takes the
    CLI's local-link path and resolves the project without a single API request — so the deploy
    cannot be refused on a lookup either.
    """
    analytics = project.get("analytics") or {}
    analytics_id = None
    if isinstance(analytics, dict) and analytics.get("id"):
        disabled_at = analytics.get("disabledAt")
        enabled_at = analytics.get("enabledAt")
        if not disabled_at or (enabled_at and enabled_at > disabled_at):
            analytics_id = analytics["id"]

    settings: dict[str, Any] = {
        name: project[name] for name in SETTING_NAMES if project.get(name) is not None
    }
    if analytics_id is not None:
        settings["analyticsId"] = analytics_id
    return {
        "projectId": project["id"],
        "orgId": project["accountId"],
        "projectName": project["name"],
        "settings": settings,
    }


def read_env_records(fetch: FetchJson, project_id: str, *, pages: int = 20) -> list[Any]:
    """Every environment variable record the project holds, following the API's pagination.

    A truncated first page read as the whole environment is exactly the silent partial environment
    this script exists to prevent, so an unfinished listing is an error rather than what we build
    with.
    """
    quoted = urllib.parse.quote(project_id, safe="")
    path = f"/v9/projects/{quoted}/env?decrypt=true"
    records: list[Any] = []
    for _ in range(pages):
        payload = fetch(path)
        if not isinstance(payload, dict):
            raise ReleaseError(
                "the Vercel environment API returned something that is not an object"
            )
        page = payload.get("envs")
        if not isinstance(page, list):
            raise ReleaseError("the Vercel environment API returned no `envs` list")
        records.extend(page)
        pagination = payload.get("pagination") or {}
        cursor = pagination.get("next") if isinstance(pagination, dict) else None
        if cursor is None:
            return records
        path = f"/v9/projects/{quoted}/env?decrypt=true&until={urllib.parse.quote(str(cursor))}"
    raise ReleaseError("the Vercel environment API paginated further than this release will follow")


def production_environment(records: list[Any]) -> dict[str, str]:
    """The Production environment, or a refusal.

    Filtered the way `vercel pull --environment=production` filters: Production targets only, no
    branch overrides, no custom environments. Everything that survives that filter must be readable
    and representable — a Production variable this script cannot read is not one it may skip.
    """
    found: dict[str, str] = {}
    for record in records:
        if not isinstance(record, dict):
            raise ReleaseError("the Vercel environment API returned a record that is not an object")
        key = record.get("key")
        if not isinstance(key, str) or not key:
            raise ReleaseError("the Vercel environment API returned a record with no key")

        targets = record.get("target") or []
        if isinstance(targets, str):
            targets = [targets]
        if not isinstance(targets, list) or "production" not in targets:
            continue
        if record.get("gitBranch"):
            continue
        if record.get("customEnvironmentIds"):
            continue
        if key in VARIABLES_TO_IGNORE:
            continue

        upper = key.upper()
        for fragment in SECRET_NAME_FRAGMENTS:
            if fragment in upper:
                raise ReleaseError(
                    f"the Vercel project's Production environment holds {key}, whose name reads as "
                    "a backend secret; it must not reach a frontend build. Remove it from the "
                    "project rather than from this check"
                )
        if not VALID_NAME.match(key):
            raise ReleaseError(
                f"the Production environment holds {key!r}, which is not a usable variable name"
            )

        value = record.get("value")
        if record.get("type") == "sensitive" or value is None:
            raise ReleaseError(
                f"the Production value of {key} cannot be read (it is marked sensitive or was "
                "returned empty), so the build would bake in an incomplete environment"
            )
        if not isinstance(value, str):
            raise ReleaseError(f"the Production value of {key} is not a string")
        if key in found and found[key] != value:
            raise ReleaseError(
                f"the Production environment holds two different values for {key}; which one the "
                "build should use is not this script's guess to make"
            )
        found[key] = value

    missing = [name for name in REQUIRED_PUBLIC_NAMES if not found.get(name)]
    for alternatives in REQUIRED_PUBLIC_ALTERNATIVES:
        if not any(found.get(name) for name in alternatives):
            missing.append(" or ".join(alternatives))
    if missing:
        raise ReleaseError(
            "the Vercel project's Production environment is missing "
            f"{', '.join(missing)}; the bundle would be built without it"
        )
    validate_url_values(found)
    return found


def validate_url_values(records: dict[str, str]) -> None:
    """Every URL-valued variable must be a fetchable http(s) URL, or the release stops.

    Deliberately the same three questions `@supabase/supabase-js` asks, asked before the build
    instead of on every request in production: no whitespace, a scheme of exactly `http` or `https`,
    and a host. A bare `<ref>.supabase.co`, a project ref on its own, a `https//` typo, or an anon
    key pasted into the URL field each fail here — all of them are non-empty strings, which is why
    the required-name check above cannot catch them.

    `http` is accepted, not merely tolerated: `frontend/.env.example` documents
    `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`, and a self-hosted Supabase or a staging
    backend on a private network is legitimately http. The property being defended is that the
    value is a URL, not that it is encrypted in transit.

    The variable is named and the reason is given; the value never is. A value that turns out to be
    a credential someone pasted into the wrong field must not be echoed into a public build log.
    """
    for name in URL_VALUED_NAMES:
        value = records.get(name)
        if value is None:
            continue
        if any(character.isspace() for character in value):
            raise ReleaseError(
                f"the Production value of {name} contains whitespace, so it is not a usable URL. "
                "Set it to the bare origin with no spaces, tabs or newlines around or inside it"
            )
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in ("http", "https"):
            raise ReleaseError(
                f"the Production value of {name} does not begin with `http://` or `https://`, so "
                "it is not a usable URL. Next.js inlines this value at build time, so a build "
                "would compile it into the bundle and every request would fail in production. Set "
                "it to the full origin — for Supabase that is `https://<project-ref>.supabase.co`"
            )
        if not parsed.hostname:
            raise ReleaseError(
                f"the Production value of {name} names no host, so it is not a usable URL"
            )


def serialize_env(records: dict[str, str]) -> str:
    """`.vercel/.env.production.local`, in the format `vercel build` parses with dotenv.

    Sorted `KEY="value"` lines with newlines and carriage returns escaped — byte-for-byte the
    CLI's own `env pull` serialisation, so the build reads exactly what it read before. The quotes
    are what make spaces, `#`, `=` and every other punctuation character safe.

    Two characters have no faithful representation: dotenv expands `\\n` and `\\r` inside a quoted
    value and does not unescape `\\"`, so a value containing a backslash or a double quote would
    reach the build altered. This refuses those rather than corrupting the value quietly — a
    silently mangled Supabase key is a production frontend that cannot sign anyone in.
    """
    lines = [ENV_FILE_HEADER]
    for key in sorted(records):
        value = records[key]
        if '"' in value:
            raise ReleaseError(
                f"the Production value of {key} contains a double quote, which cannot be "
                "written to a dotenv file without the build reading back something different"
            )
        if "\\" in value:
            raise ReleaseError(
                f"the Production value of {key} contains a backslash, which dotenv would "
                "reinterpret as an escape when the build read it back"
            )
        escaped = value.replace("\n", "\\n").replace("\r", "\\r")
        lines.append(f'{key}="{escaped}"\n')
    return "".join(lines)


def write_files(directory: Path, link: dict[str, Any], env_text: str) -> tuple[Path, Path]:
    vercel_dir = directory / ".vercel"
    vercel_dir.mkdir(parents=True, exist_ok=True)
    link_path = vercel_dir / "project.json"
    env_path = vercel_dir / ".env.production.local"
    link_path.write_text(json.dumps(link, indent=2) + "\n", encoding="utf-8")
    env_path.write_text(env_text, encoding="utf-8")
    env_path.chmod(0o600)
    return link_path, env_path


def run(project_id: str, expected_org_id: str, directory: Path, fetch: FetchJson) -> int:
    project = read_project(fetch, project_id)
    assert_owner(project, expected_org_id)
    print("the project named by WEATHRA_VERCEL_PROJECT_ID is owned by the expected team")

    link = project_link(project)
    environment = production_environment(read_env_records(fetch, project_id))
    link_path, env_path = write_files(directory, link, serialize_env(environment))

    print(f"wrote {link_path.name} for project {link['projectName']}")
    # Names, never values: which variables the build will see is the thing worth reading in a log,
    # and a count alone would not show a missing one.
    print(
        f"wrote {env_path.name} with {len(environment)} Production variables: "
        f"{', '.join(sorted(environment))}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__ and __doc__.splitlines()[0])
    parser.add_argument("--project-id", required=True, help="the existing project's id")
    parser.add_argument(
        "--expect-org-id", required=True, help="the team the project must belong to"
    )
    parser.add_argument(
        "--directory",
        default=".",
        type=Path,
        help="where to write `.vercel/` (the directory the build runs from)",
    )
    arguments = parser.parse_args(argv)

    # Read from the environment, never from an argument: an argument list is visible in the
    # runner's process table and in any shell trace.
    token = os.environ.get("VERCEL_TOKEN", "").strip()
    if not token:
        print("VERCEL_TOKEN is not set; refusing to continue", file=sys.stderr)
        return 1

    try:
        return run(
            arguments.project_id.strip(),
            arguments.expect_org_id.strip(),
            arguments.directory,
            make_fetch_json(token),
        )
    except ReleaseError as error:
        print(f"{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
