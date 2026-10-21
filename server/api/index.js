import { buildApp } from "../src/index.js";

/**
 * Vercel serverless entry point.
 *
 * The rest of the codebase is a long-running node:http server. This is the thin
 * adapter that makes the same app callable as a serverless function, reusing
 * `app.handle(req, res)` unchanged rather than duplicating any routing.
 *
 * Two deliberate choices:
 *
 * 1. The app is built lazily and cached. Cold invocations pay for it once;
 *    warm invocations reuse it. Building at module scope instead would turn a
 *    missing environment variable into an opaque init failure.
 *
 * 2. /healthz answers even when configuration is broken. That is precisely
 *    when a health check is useful - it separates "the deployment is dead"
 *    from "the deployment is up but misconfigured", which otherwise look
 *    identical from the outside.
 *
 * Note that the response must be fully written before the handler returns:
 * Vercel freezes the invocation once the response is sent, so no work may be
 * queued after it. routes.js already does the SMS send before responding for
 * exactly this reason.
 */

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = Promise.resolve().then(() => buildApp(process.env).app);
  }
  return appPromise;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/**
 * Work out which path the client actually asked for.
 *
 * vercel.json forwards the original path as `?__path=`. That is deliberate:
 * whether a rewrite preserves `req.url` depends on the runtime and function
 * type. Vercel's routing docs say the destination "only selects which route
 * runs, not the path your code sees", but a rewrite to a function can deliver
 * the destination path instead - there are filed cases of every `/api/*`
 * request arriving as `/api/index.js` and 404ing. Relying on either behaviour
 * would be a coin flip, so the forwarded copy is authoritative when present
 * and simply absent when running under node directly.
 *
 * `req.url` is rewritten in place rather than merely read here, because
 * routes.js builds the webhook signature URL as `publicBaseUrl + req.url`.
 * Leaving `?__path=` attached would make every Twilio webhook fail
 * verification, since Twilio signs the URL it requested and not the rewritten
 * one.
 *
 * The forwarded value is parsed rather than trusted. Worth being precise about
 * what that buys, because it is less than it looks: `__path` is
 * attacker-controllable (the `/api` function is publicly reachable, so a client
 * can send it directly rather than via the rewrite), but routes.js re-parses
 * `req.url` with `new URL()` anyway, so dot segments and host-bearing values
 * are normalised downstream regardless. This parse is not a privilege boundary
 * and does not need to be - it keeps the adapter's own routing comparisons
 * consistent with what routes.js will see.
 */
function resolvePath(url, req) {
  const forwarded = url.searchParams.get("__path");
  if (!forwarded) return url.pathname;

  const { pathname } = new URL(forwarded, "http://localhost");
  url.searchParams.delete("__path");
  const search = url.searchParams.toString();
  req.url = `${pathname}${search ? `?${search}` : ""}`;
  return pathname;
}

export default async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return json(res, 400, { error: "malformed_url" });
  }

  const pathname = resolvePath(url, req);

  if (req.method === "GET" && (pathname === "/healthz" || pathname === "/")) {
    return json(res, 200, { ok: true, runtime: "serverless" });
  }

  let app;
  try {
    app = await getApp();
  } catch (err) {
    // Configuration problems get a distinct error so a bad env var is not
    // mistaken for a bug in the request handling.
    return json(res, 500, { error: "configuration_error", detail: err.message });
  }

  return app.handle(req, res);
}

/** Exposed for tests: reset the cached app between cases. */
export function __resetApp() {
  appPromise = null;
}
