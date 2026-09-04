/**
 * Front proxy for the manual-pass harness — the single origin the browser talks to.
 *
 * Cloud Shell's Web Preview maps one https origin to one port on this VM. Everything the browser
 * needs has to arrive through that one port: the application, and the two stubs standing in for the
 * identity provider and the backend. So this sits on the previewed port and splits the traffic:
 *
 *   /__stub/supabase/*  →  the identity-provider stub   (prefix stripped)
 *   /__stub/api/*       →  the backend stub             (prefix stripped)
 *   everything else     →  `next start`
 *
 * In front of Next rather than inside it, which is the point. Next's middleware is
 * protected-by-default and its matcher deliberately excludes only paths that cannot be a screen —
 * "a page excluded here is a page with no gate at all". Routing the stubs through Next would mean
 * either the middleware answering the browser's Supabase calls with a redirect to `/sign-in` (which
 * is exactly what it did when this was tried as a `next.config.ts` rewrite) or punching a permanent
 * hole in that matcher for the sake of a test harness. A proxy in front touches neither: the
 * application's own configuration and middleware are exactly what ships.
 *
 * The server side of the same problem is handled separately by `manual-pass-server-fetch.cjs` —
 * see its header. Between them, one inlined URL works for the browser and for this VM.
 *
 * Loaded only by `scripts/manual-pass-serve.sh`, for
 * `docs/design/accessibility-manual-pass.md`. Nothing in the application references it.
 */

import http from "node:http";

const LISTEN_PORT = Number(process.env.WEATHRA_PROXY_PORT || 3100);
const APP_PORT = Number(process.env.WEATHRA_APP_PORT || 3101);
const STUB_PORT = Number(process.env.WEATHRA_STUB_PORT || 54321);
const API_STUB_PORT = Number(process.env.WEATHRA_API_STUB_PORT || 54322);

const ROUTES = [
  { prefix: "/__stub/supabase", port: STUB_PORT },
  { prefix: "/__stub/api", port: API_STUB_PORT },
];

function target(url) {
  for (const route of ROUTES) {
    if (url === route.prefix || url.startsWith(`${route.prefix}/`) || url.startsWith(`${route.prefix}?`)) {
      return { port: route.port, path: url.slice(route.prefix.length) || "/" };
    }
  }
  return { port: APP_PORT, path: url };
}

/**
 * Request logging, on by default.
 *
 * The harness has one failure mode that is invisible from inside the VM: Cloud Shell's preview proxy
 * sits in front of this port and answers an uncookied request with a redirect to a Google login, so
 * a browser fetch that omits credentials never arrives here at all. Logging what *does* arrive is
 * the only way to tell "the request failed on the way in" from "the request was answered badly",
 * and the two have completely different fixes.
 */
function logLine(request, port, path, status) {
  const cookie = request.headers.cookie ? "cookie" : "NO-cookie";
  const forwarded = request.headers["x-forwarded-for"] ? "via-proxy" : "direct";
  process.stdout.write(
    `${new Date().toISOString()} ${request.method} ${path} -> :${port} ${status} [${cookie}, ${forwarded}]\n`,
  );
}

const server = http.createServer((request, response) => {
  const { port, path } = target(request.url || "/");

  const proxied = http.request(
    {
      host: "127.0.0.1",
      port,
      path,
      method: request.method,
      // The Host header is rewritten so the upstream sees itself, not the preview hostname.
      headers: { ...request.headers, host: `127.0.0.1:${port}` },
    },
    (upstream) => {
      // Everything except the static build output, which is noise.
      if (!path.startsWith("/_next/static")) {
        logLine(request, port, path, upstream.statusCode || 502);
      }
      response.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(response);
    },
  );

  proxied.on("error", (error) => {
    logLine(request, port, path, `ERR ${error.code ?? error.message}`);
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`manual-pass proxy: ${port} is not answering (${error.message})`);
  });

  request.pipe(proxied);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  process.stdout.write(`manual-pass proxy listening on ${LISTEN_PORT} (app ${APP_PORT})\n`);
});
