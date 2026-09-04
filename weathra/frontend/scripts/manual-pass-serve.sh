#!/usr/bin/env bash
#
# Serve the populated production build for task 21.8's manual accessibility pass, in Cloud Shell.
#
# One command, because the arrangement has three moving parts and getting one of them wrong produces
# a screen that looks broken for reasons that have nothing to do with accessibility.
#
#   1. The two stubs on loopback — the identity provider and the FastAPI backend — so the screens are
#      populated and deterministic without a database or a provider key.
#   2. A production build (`next build`, never the dev server) whose NEXT_PUBLIC_* values point at
#      paths on the app's *own* preview origin, plus a front proxy on the previewed port that splits
#      `/__stub/*` off to the stubs and passes everything else to Next. That address is the only one
#      the browser can use, because the browser is your laptop and the stubs are on this VM's
#      loopback. The proxy sits in *front* of Next so the application's own middleware and config are
#      exactly what ships — see scripts/manual-pass-proxy.mjs.
#   3. A patch of the built server's `fetch`, because that same inlined address is also what this
#      VM's own server-side calls use — `lib/supabase/middleware.ts` calls `getUser()` on every
#      request — and from here it resolves out to Google's preview proxy, which answers an
#      unauthenticated request with a redirect to a sign-in page. The address itself is left alone
#      and only the destination is changed, because the session cookie's name is derived from that
#      address and both sides have to agree on it. scripts/manual-pass-localize.mjs has the detail,
#      including the two approaches that looked simpler and do not work.
#
# Nothing here needs root, nothing is changed outside this directory, and nothing is left running
# after Ctrl-C. Neither test suite nor a normal `npm run build` is affected.
#
# Usage:  bash scripts/manual-pass-serve.sh              # build and serve
#         bash scripts/manual-pass-serve.sh --no-build   # reuse the existing build and serve
#
# `--no-build` is for restarting during a pass. The build is the expensive, memory-hungry part, and
# re-running it only to get the server back is a minute you do not owe anybody — and on a small VM
# it is the step most likely to be reclaimed under memory pressure. It refuses to run if there is no
# usable build to reuse.

set -euo pipefail

cd "$(dirname "$0")/.."

NO_BUILD=0
if [[ "${1:-}" == "--no-build" ]]; then
  NO_BUILD=1
fi

PROXY_PORT=3100
APP_PORT=3101
STUB_PORT=54321
API_STUB_PORT=54322
WORK_DIR=".manual-pass"

if [[ "${CLOUD_SHELL:-}" != "true" || -z "${WEB_HOST:-}" ]]; then
  cat >&2 <<'MSG'
This script is for Cloud Shell, where your browser and the app are on different machines.

On a machine where they are the same — your laptop — none of it is needed. Follow §1 of
docs/design/accessibility-manual-pass.md as written: start the two stubs, build with the
127.0.0.1 addresses, and open http://127.0.0.1:3100/sign-in.
MSG
  exit 1
fi

PREVIEW_ORIGIN="https://${PROXY_PORT}-${WEB_HOST}"
mkdir -p "${WORK_DIR}"

echo "==> Preview origin: ${PREVIEW_ORIGIN}"

cleanup() {
  echo
  echo "==> Stopping"
  for pid in "${STUB_PID:-}" "${API_PID:-}" "${NEXT_PID:-}" "${PROXY_PID:-}"; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# --- 1. the stubs -----------------------------------------------------------------------------
echo "==> Starting the identity-provider stub on ${STUB_PORT}"
node tests/e2e/supabase-stub.mjs >"${WORK_DIR}/supabase-stub.log" 2>&1 &
STUB_PID=$!

echo "==> Starting the backend stub on ${API_STUB_PORT}"
node tests/e2e/weathra-api-stub.mjs >"${WORK_DIR}/api-stub.log" 2>&1 &
API_PID=$!

sleep 2
curl -fsS "http://127.0.0.1:${STUB_PORT}/control/health" >/dev/null || {
  echo "The identity-provider stub did not come up; see ${WORK_DIR}/supabase-stub.log" >&2
  exit 1
}
curl -fsS "http://127.0.0.1:${API_STUB_PORT}/control/health" >/dev/null || {
  echo "The backend stub did not come up; see ${WORK_DIR}/api-stub.log" >&2
  exit 1
}

# --- 2. the build -----------------------------------------------------------------------------
# NEXT_PUBLIC_* is inlined at build time, so it goes on the build command.
if [[ "${NO_BUILD}" -eq 1 ]]; then
  # Reusing a build is only safe if it was built for *this* preview origin, so that is checked
  # rather than assumed — a build made for a different Cloud Shell session would serve a client
  # bundle calling an address this VM is not behind.
  if ! grep -rq --binary-files=without-match -F "${PREVIEW_ORIGIN}/__stub/supabase" .next/static 2>/dev/null; then
    echo "--no-build was given, but .next was not built for ${PREVIEW_ORIGIN}." >&2
    echo "Run without --no-build to build it." >&2
    exit 1
  fi
  echo "==> Reusing the existing build (--no-build)"
else
  echo "==> Building the production bundle (this takes a minute)"
  NEXT_PUBLIC_SUPABASE_URL="${PREVIEW_ORIGIN}/__stub/supabase" \
  NEXT_PUBLIC_SUPABASE_ANON_KEY="stub-anon-key" \
  NEXT_PUBLIC_API_BASE_URL="${PREVIEW_ORIGIN}/__stub/api" \
    npm run build >"${WORK_DIR}/build.log" 2>&1 || {
    echo "The build failed; see ${WORK_DIR}/build.log" >&2
    tail -20 "${WORK_DIR}/build.log" >&2
    exit 1
  }
fi

# --- 3. point the server's calls at the stubs, without changing the URL they name --------------
# Only the destination is changed, not the address in the bundle: `supabase-js` derives the session
# cookie's name from that address, so rewriting it would make the server look for a cookie the
# browser never wrote. See scripts/manual-pass-localize.mjs.
echo "==> Pointing the server's calls at the stubs on loopback"
node scripts/manual-pass-localize.mjs "${PREVIEW_ORIGIN}" "${STUB_PORT}" "${API_STUB_PORT}" || {
  echo "Could not localize the server bundle; refusing to serve something that will not work." >&2
  exit 1
}

# And the browser's copy must still carry the preview address, or the browser has nothing to call.
grep -rq --binary-files=without-match -F "${PREVIEW_ORIGIN}/__stub/supabase" .next/static || {
  echo "The client bundle no longer carries the preview address; refusing to serve." >&2
  exit 1
}

# --- 4. the app -------------------------------------------------------------------------------
echo "==> Starting the production server on ${APP_PORT}"
npx next start --port "${APP_PORT}" >"${WORK_DIR}/next.log" 2>&1 &
NEXT_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/sign-in" >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${APP_PORT}/sign-in" >/dev/null 2>&1 || {
  echo "The app did not come up; see ${WORK_DIR}/next.log" >&2
  tail -20 "${WORK_DIR}/next.log" >&2
  exit 1
}

# --- 5. the front proxy on the previewed port -------------------------------------------------
echo "==> Starting the front proxy on ${PROXY_PORT}"
WEATHRA_PROXY_PORT="${PROXY_PORT}" \
WEATHRA_APP_PORT="${APP_PORT}" \
WEATHRA_STUB_PORT="${STUB_PORT}" \
WEATHRA_API_STUB_PORT="${API_STUB_PORT}" \
  node scripts/manual-pass-proxy.mjs >"${WORK_DIR}/proxy.log" 2>&1 &
PROXY_PID=$!

sleep 1
# Both halves, checked rather than assumed: the app through the proxy, and a stub through the proxy
# without the middleware having answered for it.
curl -fsS "http://127.0.0.1:${PROXY_PORT}/sign-in" >/dev/null || {
  echo "The proxy is not serving the app; see ${WORK_DIR}/proxy.log" >&2
  exit 1
}
curl -fsS "http://127.0.0.1:${PROXY_PORT}/__stub/supabase/control/health" >/dev/null || {
  echo "The proxy is not reaching the identity stub; see ${WORK_DIR}/proxy.log" >&2
  exit 1
}

cat <<MSG

================================================================================
Ready.

  1. Click the Web Preview button in Cloud Shell (the eye icon, top right).
  2. Choose "Change port", enter ${PROXY_PORT}, and preview.
     That opens:  ${PREVIEW_ORIGIN}

  Sign in as:  sam@example.test  /  correct-horse-battery-staple

Logs:  ${WORK_DIR}/next.log  ${WORK_DIR}/proxy.log  ${WORK_DIR}/supabase-stub.log  ${WORK_DIR}/api-stub.log

Reset the stubs to their starting state at any point, from another tab:
  curl -X POST http://127.0.0.1:${STUB_PORT}/control/restore
  curl -X POST http://127.0.0.1:${API_STUB_PORT}/control/restore

Press Ctrl-C to stop. Nothing is left running and nothing outside frontend/ was changed.
================================================================================

MSG

wait "${PROXY_PID}"
