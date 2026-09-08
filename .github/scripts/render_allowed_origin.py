#!/usr/bin/env python3
"""Allow one browser origin to call the deployed backend, and prove it took effect.

Task 23.5 requires the deployed frontend to reach the deployed backend with a bearer token. It
cannot: the production frontend is served from a Vercel domain that the backend's
``CORS_ALLOWED_ORIGINS`` does not list, so a browser refuses every call before the token is even
looked at. A preflight from that origin answers 400 with no ``Access-Control-Allow-Origin`` while
``http://localhost:3000`` answers 200 with it, which is the origin list and nothing else.

``render.yaml`` declares ``CORS_ALLOWED_ORIGINS`` with ``sync: false``, so its value lives in
Render rather than in this repository and no commit can change it. This is the smallest operation
that can: it runs inside GitHub Actions, where ``RENDER_API_KEY`` and ``RENDER_SERVICE_ID`` already
are, and it adds one origin to whatever is already configured.

**Why adding rather than declaring.** A reconciler that held the whole list in the repository would
be easier to review and would also delete, on its first run, every origin someone added in Render
that this file did not know about. So the operation is strictly additive: it reads what is there,
appends one origin if absent, and never removes or rewrites an existing entry.

**Why the per-key endpoint.** ``PUT /v1/services/<id>/env-vars`` replaces a service's entire
environment — an operation whose failure mode is deleting the database credentials. Render also
documents ``PUT /v1/services/<id>/env-vars/<key>``, which "updates only the specified environment
variable key", and that is what runs here: unrelated variables are untouched by construction
rather than by care. The read-back afterwards holds that to be true anyway, because a claim in a
comment is not a check.

**Why it verifies rather than reports success.** The backend reads its configuration at process
start, so a saved value that the running container has not picked up is indistinguishable from a
value that was never saved — from the API's answer, and from the frontend's point of view. So the
run ends by asking production itself, with a real preflight from the real origin, and restarts the
service once if the change has not taken effect. A restart re-reads configuration; it does not
deploy code, and what is running stays the release that was already there.

Nothing here prints the API key, the origin list, or any other variable's value.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

API = "https://api.render.com/v1"
ENV_KEY = "CORS_ALLOWED_ORIGINS"

# The Render API pages environment variables, and a truncated read would look like a service with
# fewer variables than it has — which is exactly the state that makes a full replacement dangerous.
PAGE_SIZE = 100
PAGE_LIMIT = 50

Api = Callable[..., Any]
Probe = Callable[..., tuple[int, dict[str, str]]]


class RenderError(Exception):
    """A condition that must stop the operation rather than be worked around."""


def normalize_origin(origin: str) -> str:
    """An origin reduced to what the *consumer* treats as the same origin, and no further.

    Only surrounding whitespace and a trailing slash: the backend's CORS middleware compares the
    browser's `Origin` header against this list as exact strings, and a browser sends the scheme
    and host already lower-cased. So a configured `https://WEATHRA-BICE.vercel.app` is not an
    equivalent spelling — it is an entry that will never match, and folding case here would skip
    adding the one that does, leaving production refusing the origin while reporting success.

    Nothing already configured is ever rewritten into this form either. Normalising an existing
    entry would be a change to an origin this operation was asked to preserve.
    """
    return origin.strip().rstrip("/")


def parse_origins(value: str) -> list[str]:
    """The origin list as the backend parses it.

    `weathra/backend/weathra/config.py` splits this variable on commas and strips each part, so
    that contract is followed here rather than guessed at: anything else would produce a value the
    service reads differently from the way this script counted it.
    """
    return [part.strip() for part in value.split(",") if part.strip()]


def value_with_origin(current: str, origin: str) -> str | None:
    """The value to store, or `None` when the origin is already allowed.

    Returning `None` is what makes the operation idempotent: a second run performs no write at all
    rather than writing an identical value, so it cannot restart the service for nothing.
    """
    wanted = normalize_origin(origin)
    if not wanted:
        raise RenderError("the origin to allow is empty")
    if any(normalize_origin(existing) == wanted for existing in parse_origins(current)):
        return None
    existing_value = current.strip().rstrip(",")
    return f"{existing_value},{origin}" if existing_value else origin


def make_api(token: str, *, attempts: int = 3, pause: float = 3.0) -> Api:
    """A reader and writer for the Render API that validates the status before anything else.

    The key travels in a header, so it appears in no URL, no argument list and no error message.
    """

    def api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        payload = json.dumps(body).encode() if body is not None else None
        last: RenderError | None = None
        for attempt in range(1, attempts + 1):
            request = urllib.request.Request(
                f"{API}{path}",
                method=method,
                data=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    **({"Content-Type": "application/json"} if payload else {}),
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read()
            except urllib.error.HTTPError as error:
                if error.code in (401, 403):
                    raise RenderError(
                        f"Render refused the API key for {method} {path} ({error.code}); "
                        "RENDER_API_KEY is missing, expired, or lacks access to this service"
                    ) from None
                if error.code == 404:
                    raise RenderError(
                        f"Render has no {path} ({error.code}); RENDER_SERVICE_ID may be wrong"
                    ) from None
                if error.code in (408, 429) or error.code >= 500:
                    last = RenderError(f"Render answered {error.code} for {method} {path}")
                else:
                    raise RenderError(f"Render answered {error.code} for {method} {path}") from None
            except urllib.error.URLError as error:
                last = RenderError(f"Render could not be reached for {path}: {error.reason}")
            else:
                if not raw:
                    return None
                try:
                    return json.loads(raw)
                except ValueError:
                    raise RenderError(
                        f"Render returned a body for {path} that is not JSON"
                    ) from None
            if attempt < attempts:
                time.sleep(pause)
        raise RenderError(str(last) if last else f"Render could not be read for {path}")

    return api


def read_env_vars(api: Api, service_id: str) -> dict[str, Any]:
    """Every environment variable the service holds directly, by key.

    Fails closed on anything unexpected. A half-read environment is the input that turns a
    configuration change into a deletion, so "could not read it" must never continue as "it was
    empty".
    """
    quoted = urllib.parse.quote(service_id, safe="")
    found: dict[str, Any] = {}
    cursor: str | None = None
    for _ in range(PAGE_LIMIT):
        path = f"/services/{quoted}/env-vars?limit={PAGE_SIZE}"
        if cursor:
            path += f"&cursor={urllib.parse.quote(cursor, safe='')}"
        page = api("GET", path)
        if not isinstance(page, list):
            raise RenderError("Render did not return a list of environment variables")
        for entry in page:
            if not isinstance(entry, dict):
                raise RenderError("Render returned an environment variable that is not an object")
            env_var = entry.get("envVar")
            if not isinstance(env_var, dict):
                raise RenderError("Render returned an entry with no `envVar` object")
            key = env_var.get("key")
            if not isinstance(key, str) or not key:
                raise RenderError("Render returned an environment variable with no name")
            found[key] = env_var.get("value")
        if len(page) < PAGE_SIZE:
            return found
        cursor = page[-1].get("cursor") if isinstance(page[-1], dict) else None
        if not isinstance(cursor, str) or not cursor:
            return found
    raise RenderError(
        "Render paged further through the environment than this operation will follow"
    )


def ensure_origin_allowed(api: Api, service_id: str, origin: str) -> bool:
    """Add the origin to `CORS_ALLOWED_ORIGINS` if it is missing. True when something changed.

    The read-back is the part worth keeping honest about: the per-key endpoint cannot touch another
    variable, but asserting that afterwards costs one request and turns "it should be fine" into
    evidence. Every other variable must come back byte-identical, and every origin that was
    configured before must still be configured after.
    """
    before = read_env_vars(api, service_id)
    if ENV_KEY not in before:
        raise RenderError(
            f"the service holds no {ENV_KEY} directly, so there is nothing to add to. It may live "
            "in a linked environment group, which this operation deliberately does not touch — "
            "creating the variable here would replace whatever the service resolves today"
        )
    current = before[ENV_KEY]
    if not isinstance(current, str):
        raise RenderError(f"the service's {ENV_KEY} has no readable value")

    updated = value_with_origin(current, origin)
    if updated is None:
        print(f"{ENV_KEY} already allows {origin}; no change made")
        return False

    quoted = urllib.parse.quote(service_id, safe="")
    api("PUT", f"/services/{quoted}/env-vars/{ENV_KEY}", {"value": updated})

    after = read_env_vars(api, service_id)
    untouched_before = {key: value for key, value in before.items() if key != ENV_KEY}
    untouched_after = {key: value for key, value in after.items() if key != ENV_KEY}
    if untouched_before != untouched_after:
        raise RenderError(
            "the service's other environment variables changed while adding an origin; "
            "refusing to continue"
        )
    stored = after.get(ENV_KEY)
    if not isinstance(stored, str):
        raise RenderError(f"{ENV_KEY} could not be read back after the update")
    kept = {normalize_origin(entry) for entry in parse_origins(stored)}
    missing = [entry for entry in parse_origins(current) if normalize_origin(entry) not in kept]
    if missing:
        raise RenderError(f"{len(missing)} previously allowed origin(s) are no longer configured")
    if normalize_origin(origin) not in kept:
        raise RenderError(f"{origin} is still not configured after the update")

    print(
        f"added {origin} to {ENV_KEY}: "
        f"{len(parse_origins(current))} origins before, {len(kept)} after"
    )
    return True


def health(probe: Probe, base_url: str) -> int:
    status, _ = probe("GET", f"{base_url}/api/v1/health", {})
    return status


def preflight_allows(probe: Probe, base_url: str, origin: str) -> bool:
    """A real CORS preflight from the real origin — the question a browser will ask.

    Starlette answers a disallowed origin with 400 and no `Access-Control-Allow-Origin`, so the
    header is the whole signal: its presence, and its agreement with the origin asked about.
    """
    status, headers = probe(
        "OPTIONS",
        f"{base_url}/api/v1/health",
        {
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    allowed = headers.get("access-control-allow-origin", "")
    return status == 200 and normalize_origin(allowed) == normalize_origin(origin)


def wait_for(check: Callable[[], bool], *, attempts: int, pause: float, what: str) -> bool:
    for attempt in range(1, attempts + 1):
        if check():
            return True
        if attempt < attempts:
            print(f"attempt {attempt}: {what} has not taken effect yet; waiting")
            time.sleep(pause)
    return False


def apply(
    api: Api,
    probe: Probe,
    service_id: str,
    base_url: str,
    origin: str,
    *,
    attempts: int = 10,
    pause: float = 15.0,
) -> int:
    changed = ensure_origin_allowed(api, service_id, origin)

    if not wait_for(
        lambda: preflight_allows(probe, base_url, origin),
        attempts=attempts if changed else 1,
        pause=pause,
        what="the new origin",
    ):
        # Saved but not in force. The service reads its configuration at start-up, so the running
        # container is still answering with the list it booted with. A restart re-reads it and
        # keeps serving the same release; it is not a deploy and builds nothing.
        print("the running service has not picked up the change; restarting it once")
        quoted = urllib.parse.quote(service_id, safe="")
        api("POST", f"/services/{quoted}/restart")
        if not wait_for(
            lambda: health(probe, base_url) == 200,
            attempts=attempts,
            pause=pause,
            what="the restarted service",
        ):
            raise RenderError("the service did not come back healthy after the restart")
        if not wait_for(
            lambda: preflight_allows(probe, base_url, origin),
            attempts=attempts,
            pause=pause,
            what="the new origin after the restart",
        ):
            raise RenderError(f"{origin} is configured but production still refuses it")

    status = health(probe, base_url)
    if status != 200:
        raise RenderError(f"the backend's health endpoint answered {status}, not 200")
    print("the backend is healthy and production accepts the origin")
    return 0


def make_probe() -> Probe:
    def probe(method: str, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
        request = urllib.request.Request(url, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, {
                    name.lower(): value for name, value in response.headers.items()
                }
        except urllib.error.HTTPError as error:
            return error.code, {name.lower(): value for name, value in error.headers.items()}
        except urllib.error.URLError as error:
            print(f"{url} could not be reached: {error.reason}", file=sys.stderr)
            return 0, {}

    return probe


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__ and __doc__.splitlines()[0])
    parser.add_argument("--origin", required=True, help="the browser origin to allow")
    parser.add_argument("--base-url", required=True, help="the deployed backend's base URL")
    arguments = parser.parse_args(argv)

    # Read from the environment, never from an argument: an argument list is visible in the
    # runner's process table and in any shell trace.
    token = os.environ.get("RENDER_API_KEY", "").strip()
    service_id = os.environ.get("RENDER_SERVICE_ID", "").strip()
    if not token or not service_id:
        print(
            "RENDER_API_KEY and RENDER_SERVICE_ID must be set; refusing to continue",
            file=sys.stderr,
        )
        return 1

    try:
        return apply(
            make_api(token),
            make_probe(),
            service_id,
            arguments.base_url.rstrip("/"),
            arguments.origin,
        )
    except RenderError as error:
        print(f"{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
