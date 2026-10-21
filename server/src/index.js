import http from "node:http";
import { createStore } from "./store.js";
import { createRedisStore } from "./store-redis.js";
import { createProvider } from "./provider.js";
import { createGoogleTokenSource } from "./google-auth.js";
import { createPlayBillingClient } from "./play-billing.js";
import { createApp } from "./routes.js";

/**
 * Missed Call Reply backend.
 *
 * Required environment:
 *   TWILIO_ACCOUNT_SID   account the Twilio numbers belong to
 *   TWILIO_AUTH_TOKEN    used both for REST auth and webhook signature checks
 *   PUBLIC_BASE_URL      absolute origin Twilio reaches this service at,
 *                        e.g. https://mctb.example.com. Signatures are computed
 *                        over the URL as Twilio called it, so guessing this
 *                        from the Host header behind a proxy will fail.
 *
 * Optional:
 *   PORT                 default 3000
 *   STORE_PATH           default ./data/subscribers.json
 *   API_KEY              enables the settings API; without it, PUT is refused
 *   LOG_LEVEL            default info
 */

/** Credentials each provider needs before it can send or verify anything. */
const PROVIDER_ENV = {
  twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  telnyx: ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"],
};

function loadConfig(env = process.env) {
  const provider = (env.PROVIDER ?? "twilio").toLowerCase();
  if (!PROVIDER_ENV[provider]) {
    throw new Error(`Unknown PROVIDER: ${provider}. Use "twilio" or "telnyx".`);
  }

  const required = ["PUBLIC_BASE_URL", ...PROVIDER_ENV[provider]];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    provider,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? "",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? "",
    telnyxApiKey: env.TELNYX_API_KEY ?? "",
    telnyxPublicKey: env.TELNYX_PUBLIC_KEY ?? "",
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    port: Number(env.PORT ?? 3000),
    storePath: env.STORE_PATH ?? "./data/subscribers.json",
    redisUrl: env.REDIS_REST_URL ?? "",
    redisToken: env.REDIS_REST_TOKEN ?? "",
    apiKey: env.API_KEY ?? "",
    // Play purchase verification. The package and product are fixed here
    // rather than taken from the request, so a client cannot claim a purchase
    // against some other app or product.
    playPackageName: env.GOOGLE_PLAY_PACKAGE_NAME ?? "",
    playProductId: env.GOOGLE_PLAY_PRODUCT_ID ?? "unlimited_replies",
    playServiceAccountJson: env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? "",
    maxBodyBytes: 64 * 1024,
  };
}

function createLogger(level = "info") {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? 20;
  const emit = (name, fn) => (msg, meta) => {
    if (levels[name] >= threshold) fn(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }));
  };
  return {
    debug: emit("debug", console.log),
    info: emit("info", console.log),
    warn: emit("warn", console.warn),
    error: emit("error", console.error),
  };
}

/**
 * Picks the storage backend.
 *
 * Redis wins if its credentials are present, because on a serverless host the
 * file store would appear to save and then lose everything on the next cold
 * invocation - a silent failure that is much worse than a loud one.
 */
/**
 * @param {boolean} [opts.ephemeralFs]  true when the filesystem does not
 *   outlive the process, as on a serverless host.
 */
export function selectStore(config, logger = console, { ephemeralFs = false } = {}) {
  if (config.redisUrl && config.redisToken) {
    logger.info?.("store: redis");
    return createRedisStore({ url: config.redisUrl, token: config.redisToken });
  }

  if (config.redisUrl || config.redisToken) {
    throw new Error(
      "REDIS_REST_URL and REDIS_REST_TOKEN must both be set; only one was provided",
    );
  }

  if (ephemeralFs) {
    // Refuse rather than start. On a serverless host the file store writes to a
    // scratch directory that is discarded between invocations and is not shared
    // between them, so subscriber settings would appear to save and then
    // vanish - a silent failure that looks like a bug in the panel. Failing at
    // startup turns that into a message naming the fix.
    throw new Error(
      "The file store cannot be used on a serverless host: its filesystem is " +
        "ephemeral and not shared between invocations, so subscriber data would " +
        "be lost. Set REDIS_REST_URL and REDIS_REST_TOKEN (a free Upstash Redis " +
        "works), or run this as a long-lived process instead.",
    );
  }

  logger.info?.("store: file", { path: config.storePath });
  return createStore(config.storePath);
}

/**
 * Builds the Play purchase verifier, or null when it is not configured.
 *
 * Absent configuration is not an error: the free tier is the whole product
 * until someone sets up a Play Console service account. What must not happen
 * is a *half*-configured verifier, so a malformed key fails loudly at startup
 * instead of turning every purchase into a 500.
 */
export function selectBilling(config, logger = console) {
  if (!config.playServiceAccountJson) return null;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.playServiceAccountJson);
  } catch (err) {
    throw new Error(`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
  }

  if (!config.playPackageName) {
    throw new Error(
      "GOOGLE_PLAY_PACKAGE_NAME is required when GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is set",
    );
  }

  const { getAccessToken } = createGoogleTokenSource({ serviceAccount });
  logger.info?.("billing: google play", {
    packageName: config.playPackageName,
    productId: config.playProductId,
  });
  return createPlayBillingClient({
    packageName: config.playPackageName,
    getAccessToken,
  });
}

/**
 * Wires the application without starting a listener.
 *
 * Split out from buildServer so the serverless adapter can reuse the exact same
 * wiring - one code path for both hosting models, so a bug fixed in one cannot
 * survive in the other.
 */
export function buildApp(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger(env.LOG_LEVEL);
  // Vercel sets VERCEL=1 in every function invocation.
  const store = selectStore(config, logger, { ephemeralFs: Boolean(env.VERCEL) });
  const provider = createProvider(config);
  logger.info("provider", { name: provider.name });
  const billing = selectBilling(config, logger);
  const app = createApp({ store, provider, config, logger, billing });
  return { app, store, provider, config, logger };
}

export function buildServer(env = process.env) {
  const { app, store, provider, config, logger } = buildApp(env);

  const server = http.createServer((req, res) => {
    app.handle(req, res);
  });

  return { server, store, app, provider, config, logger };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const { server, config, logger } = buildServer();
  server.listen(config.port, "0.0.0.0", () => {
    logger.info("listening", { port: config.port, base: config.publicBaseUrl });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logger.info("shutting down", { signal });
      server.close(() => process.exit(0));
    });
  }
}
