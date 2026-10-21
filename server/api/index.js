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

export default async function handler(req, res) {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return json(res, 400, { error: "malformed_url" });
  }

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
