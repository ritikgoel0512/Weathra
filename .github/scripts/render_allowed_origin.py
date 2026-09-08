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

**Why saving is not enough, and why a restart is not either.** The backend reads its configuration
once, when ``build_app`` constructs the application at process start, so a new value reaches it
only in a new process. Render says the same of its own "Save only" option — "your service will not
use the new variables until its next deploy" — and documents its restart as deliberately not doing
that: "the new instance always uses the exact same Git commit **and configuration** as the running
instance at the time of the restart. This means that if you've recently updated your service's
environment variables but haven't redeployed since then, restarting does not incorporate those
changes."

That is exactly how the first run of this operation failed. It saved the origin, restarted, and
then waited for a change a restart is defined never to apply.

So a saved-but-inactive value is activated by a **redeploy of the commit that is already live**,
with ``deployMode: "deploy_only"`` — the API equivalent of the dashboard's "Save and deploy:
redeploys the existing build with the new variables". The commit is read from the service's current
live deploy and pinned, which is what stops this from becoming a release: an unpinned deploy takes
the branch tip, and that may be a commit whose migrations have not run — the ordering
``release.yml`` exists to guarantee. ``release.yml`` stays the authority on *what* is deployed;
this asks only for the commit already running to be started again with the configuration it has.

**Why it verifies rather than reports success.** A saved value the running container has not picked
up is indistinguishable from a correctly applied one in the API's answer — and in the frontend's
experience, which is the one that matters. So the run ends by asking production itself, with a real
preflight from the real origin.

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
    """A condition that must stop the operation rather than be worked around.

    Carries the HTTP status when one is known, so a caller can tell a rejected request field —
    which it may be able to do without — from a refusal it must not work around.
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def normalize_origin(origin: str) -> str:
    """An origin reduced to what the *consumer* treats as the same origin, and no further.

    Surrounding whitespace only, because that is the only difference anything downstream forgives:
    `weathra/backend/weathra/config.py` strips each comma-separated part, and Starlette's CORS
    middleware then compares the browser's `Origin` header against the result as exact strings.

    So neither case nor a trailing slash may be folded in here. A browser sends the scheme and host
    lower-cased and sends no trailing slash, which makes `https://WEATHRA-BICE.vercel.app` and
    `https://weathra-bice.vercel.app/` entries that never match anything — not equivalent
    spellings. Treating either as "already allowed" would skip adding the spelling that works and
    leave production refusing the origin, while every check short of a real preflight reported
    success. Both were caught by tests, in that order.

    Nothing already configured is ever rewritten into this form either. Normalising an existing
    entry would be a change to an origin this operation was asked to preserve.
    """
    return origin.strip()


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
                    raise RenderError(
                        f"Render answered {error.code} for {method} {path}", status=error.code
                    ) from None
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


# What a deploy's status can be. `live` is the only success; `deactivated` means another deploy
# superseded ours, which is a failure to wait on rather than a state that resolves.
DEPLOY_LIVE = "live"
DEPLOY_FAILED = frozenset(
    {"build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"}
)


def read_deploys(api: Api, service_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """The service's most recent deploys, newest first, unwrapped from the API's envelope.

    Only the list endpoint is used, deliberately: it is the one whose response shape is documented,
    and polling it by id costs the same as polling a single deploy would.
    """
    quoted = urllib.parse.quote(service_id, safe="")
    page = api("GET", f"/services/{quoted}/deploys?limit={limit}")
    if not isinstance(page, list):
        raise RenderError("Render did not return a list of deploys")
    deploys: list[dict[str, Any]] = []
    for entry in page:
        if not isinstance(entry, dict):
            raise RenderError("Render returned a deploy entry that is not an object")
        deploy = entry.get("deploy")
        if not isinstance(deploy, dict) or not isinstance(deploy.get("id"), str):
            raise RenderError("Render returned a deploy entry with no deploy object")
        deploys.append(deploy)
    return deploys


def live_commit(deploys: list[dict[str, Any]]) -> str:
    """The commit the service is serving right now.

    Pinning to it is what keeps this operation from becoming a release. An unpinned deploy takes
    the branch tip, which may be a commit whose migrations have not run — the ordering `release.yml`
    exists to guarantee — so a service with no identifiable live commit is a refusal, not a
    fall-back to "latest".
    """
    for deploy in deploys:
        if deploy.get("status") != DEPLOY_LIVE:
            continue
        commit = deploy.get("commit")
        if isinstance(commit, dict) and isinstance(commit.get("id"), str) and commit["id"]:
            pinned: str = commit["id"]
            return pinned
        raise RenderError(
            "the live deploy names no commit, so a redeploy could not be pinned to it; refusing "
            "to deploy an unpinned commit"
        )
    raise RenderError("the service has no live deploy to redeploy")


def unfinished_deploy(deploys: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A deploy that is already on its way, if there is one.

    Asking for a second deploy while one is in flight would queue a duplicate — and the one in
    flight may already carry the new configuration, in which case no deploy of ours is needed at
    all.
    """
    for deploy in deploys:
        status = deploy.get("status")
        if status != DEPLOY_LIVE and status not in DEPLOY_FAILED:
            return deploy
    return None


def start_redeploy(api: Api, service_id: str, commit_id: str) -> str:
    """Redeploy the live commit so the new configuration is read by a new process.

    `deployMode: "deploy_only"` skips the rebuild — the same code, started again with the current
    environment. It is a documented field, but a field this operation does not need to insist on:
    if the API rejects it the deploy is retried without it, which rebuilds the same commit and ends
    in the same place more slowly.
    """
    quoted = urllib.parse.quote(service_id, safe="")
    body: dict[str, Any] = {
        "commitId": commit_id,
        "clearCache": "do_not_clear",
        "deployMode": "deploy_only",
    }
    try:
        created = api("POST", f"/services/{quoted}/deploys", body)
    except RenderError as rejected:
        if rejected.status != 400:
            raise
        print("Render rejected `deployMode`; redeploying the same commit with a rebuild instead")
        del body["deployMode"]
        created = api("POST", f"/services/{quoted}/deploys", body)
    if not isinstance(created, dict) or not isinstance(created.get("id"), str):
        raise RenderError("Render did not return the deploy it created")
    started: str = created["id"]
    return started


def await_deploy(api: Api, service_id: str, deploy_id: str, *, attempts: int, pause: float) -> None:
    """Wait for one specific deploy to be live, and fail closed on anything else.

    Waiting on *this* deploy rather than on a sleep is the difference between knowing the new
    configuration is running and hoping enough time has passed.
    """
    for attempt in range(1, attempts + 1):
        for deploy in read_deploys(api, service_id):
            if deploy.get("id") != deploy_id:
                continue
            status = deploy.get("status")
            if status == DEPLOY_LIVE:
                print("the redeploy is live")
                return
            if status in DEPLOY_FAILED:
                raise RenderError(f"the redeploy ended as {status}")
            print(f"attempt {attempt}: the redeploy is {status}; waiting")
            break
        else:
            raise RenderError("the deploy that was started is no longer listed")
        if attempt < attempts:
            time.sleep(pause)
    raise RenderError("the redeploy did not become live in time")


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
    attempts: int = 8,
    pause: float = 15.0,
    deploy_attempts: int = 60,
) -> int:
    """Make the origin allowed, activate it if it is not, and prove production accepts it.

    The order matters and the shortcuts matter. Production is asked *first* whether it already
    accepts the origin, because when it does there is nothing to do and a run that deployed anyway
    would restart production for no reason. When it does not, the configuration is activated with a
    redeploy of the running commit — whether or not this run was the one that saved it, since the
    first run of this operation left the value saved and inactive, which is a state a later run has
    to be able to finish rather than re-save.
    """
    ensure_origin_allowed(api, service_id, origin)

    if preflight_allows(probe, base_url, origin):
        print("production already accepts the origin; no deploy needed")
    else:
        # Saved but not in force. Render's own documentation is explicit that this is the only way
        # out: a service "will not use the new variables until its next deploy", and a restart is
        # defined to reuse "the exact same Git commit and configuration as the running instance".
        deploys = read_deploys(api, service_id)
        pending = unfinished_deploy(deploys)
        if pending is not None:
            print(f"a deploy is already in flight ({pending.get('status')}); waiting for it")
            await_deploy(api, service_id, str(pending["id"]), attempts=deploy_attempts, pause=pause)
        else:
            print("the configuration is saved but not in force; redeploying the running commit")
            deploy_id = start_redeploy(api, service_id, live_commit(deploys))
            await_deploy(api, service_id, deploy_id, attempts=deploy_attempts, pause=pause)

        if not wait_for(
            lambda: health(probe, base_url) == 200,
            attempts=attempts,
            pause=pause,
            what="the redeployed service",
        ):
            raise RenderError("the service did not come back healthy after the redeploy")
        if not wait_for(
            lambda: preflight_allows(probe, base_url, origin),
            attempts=attempts,
            pause=pause,
            what="the new origin",
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
