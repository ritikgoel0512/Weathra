/**
 * Point the built server's Supabase and API calls at the loopback stubs, without changing the URL
 * they think they are calling.
 *
 * The distinction is the whole trick, and it took two wrong turns to find.
 *
 * The manual-pass harness has to satisfy two callers of one build-time constant: the browser (on
 * somebody's laptop, which can only reach the app's own Cloud Shell preview origin) and this VM's
 * own server-side calls (`lib/supabase/middleware.ts` calls `getUser()` on every request, and from
 * here that origin resolves out to Google's preview proxy, which redirects an unauthenticated
 * request to a sign-in page).
 *
 *   Wrong turn 1 — a `--require` fetch shim. It cannot reach `middleware.ts`, which Next runs in the
 *   Edge runtime: a sandbox with its own globals, so nothing preloaded into the Node process is
 *   visible to it.
 *
 *   Wrong turn 2 — rewriting the inlined URL in `.next/server` to `http://127.0.0.1:54321`. The
 *   server then agreed with itself and disagreed with the browser, because `supabase-js` derives the
 *   session cookie's *name* from the URL: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`. The
 *   browser wrote `sb-3100-cs-…-auth-token` and the server looked for `sb-127-auth-token`, found no
 *   session, and bounced every sign-in straight back to `/sign-in`.
 *
 * So the URL string stays exactly as built — which keeps the cookie name agreed across both sides —
 * and only the *destination* is changed, by wrapping `fetch` inside each bundle that needs it. The
 * Edge bundle gets the wrapper prepended into the file itself, which is how it ends up inside the
 * sandbox rather than outside it.
 *
 * Idempotent: a marker stops a second run from wrapping twice.
 *
 * Loaded only by `scripts/manual-pass-serve.sh`, for
 * `docs/design/accessibility-manual-pass.md`. Nothing in the application references it.
 */

import fs from "node:fs";
import path from "node:path";

const [previewOrigin, stubPort, apiStubPort] = process.argv.slice(2);
if (!previewOrigin || !stubPort || !apiStubPort) {
  console.error("usage: node manual-pass-localize.mjs <previewOrigin> <stubPort> <apiStubPort>");
  process.exit(2);
}

const MARKER = "/*weathra-manual-pass-localized*/";
const SERVER_DIR = path.join(process.cwd(), ".next", "server");

/**
 * The wrapper, as source, so it can be prepended into an Edge bundle.
 *
 * Deliberately ES5-ish and dependency-free: it is evaluated inside Next's Edge sandbox, which is not
 * Node and does not have `require`.
 */
const prologue = `${MARKER}(function(){
  var original = globalThis.fetch;
  if (!original) return;
  var routes = [
    [${JSON.stringify(`${previewOrigin}/__stub/supabase`)}, ${JSON.stringify(`http://127.0.0.1:${stubPort}`)}],
    [${JSON.stringify(`${previewOrigin}/__stub/api`)}, ${JSON.stringify(`http://127.0.0.1:${apiStubPort}`)}]
  ];
  function loopback(url) {
    if (typeof url !== "string") return null;
    for (var i = 0; i < routes.length; i++) {
      if (url.indexOf(routes[i][0]) === 0) return routes[i][1] + url.slice(routes[i][0].length);
    }
    return null;
  }
  globalThis.fetch = function (resource, init) {
    if (typeof resource === "string" || (typeof URL !== "undefined" && resource instanceof URL)) {
      return original(loopback(String(resource)) || resource, init);
    }
    if (resource && typeof resource.url === "string") {
      var rewritten = loopback(resource.url);
      if (rewritten) return original(new Request(rewritten, resource), init);
    }
    return original(resource, init);
  };
})();
`;

/** Every emitted server file that carries the inlined address, plus the Edge middleware bundle. */
function filesToWrap() {
  const needle = `${previewOrigin}/__stub/`;
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        let contents;
        try {
          contents = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (contents.includes(needle)) found.add(full);
      }
    }
  };
  walk(SERVER_DIR);
  return [...found];
}

const targets = filesToWrap();
if (targets.length === 0) {
  console.error(
    "Found no server file carrying the inlined address. The build's shape has changed and this " +
      "harness needs revisiting.",
  );
  process.exit(1);
}

let wrapped = 0;
for (const file of targets) {
  const contents = fs.readFileSync(file, "utf8");
  if (contents.startsWith(MARKER)) continue;
  fs.writeFileSync(file, prologue + contents);
  wrapped += 1;
}

console.log(`wrapped fetch in ${wrapped} server file(s) of ${targets.length} carrying the address`);
