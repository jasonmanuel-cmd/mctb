import http from "node:http";
import { createStore } from "./store.js";
import { createRedisStore } from "./store-redis.js";
import { createSmsClient } from "./sms.js";
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

function loadConfig(env = process.env) {
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "PUBLIC_BASE_URL"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    port: Number(env.PORT ?? 3000),
    storePath: env.STORE_PATH ?? "./data/subscribers.json",
    redisUrl: env.REDIS_REST_URL ?? "",
    redisToken: env.REDIS_REST_TOKEN ?? "",
    apiKey: env.API_KEY ?? "",
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
export function selectStore(config, logger = console) {
  if (config.redisUrl && config.redisToken) {
    logger.info?.("store: redis");
    return createRedisStore({ url: config.redisUrl, token: config.redisToken });
  }

  if (config.redisUrl || config.redisToken) {
    throw new Error(
      "REDIS_REST_URL and REDIS_REST_TOKEN must both be set; only one was provided",
    );
  }

  logger.info?.("store: file", { path: config.storePath });
  return createStore(config.storePath);
}

export function buildServer(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger(env.LOG_LEVEL);
  const store = selectStore(config, logger);
  const sms = createSmsClient({
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
  });
  const app = createApp({ store, sms, config, logger });

  const server = http.createServer((req, res) => {
    app.handle(req, res);
  });

  return { server, store, app, config, logger };
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
