import crypto from "node:crypto";
import { digitsOf } from "./policy.js";
import { defaults, mergeSubscriber } from "./store.js";

/**
 * Redis-backed subscriber store.
 *
 * This is the backend to use on a serverless host, where the filesystem is
 * ephemeral and not shared between invocations. It talks to the Redis REST API
 * (Upstash and compatible) over fetch, so it keeps the zero-dependency
 * property - no client library, nothing to install.
 *
 * Same read-modify-write caveat as the file store: no cross-process lock, so
 * two simultaneous missed calls for one subscriber can race on replyCount. The
 * consequence is a reply counted twice, not a lost message, which is the right
 * way round for this product.
 *
 * `fetchImpl` is injectable so the whole command surface is testable without a
 * Redis instance.
 */

const KEY_PREFIX = "mctb:sub:";
const INDEX_KEY = "mctb:index";

export function createRedisStore({ url, token, fetchImpl = fetch }) {
  if (!url || !token) {
    throw new Error("Redis store requires both REDIS_REST_URL and REDIS_REST_TOKEN");
  }

  /** Runs one Redis command against the REST API. */
  async function command(...args) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    const payload = await res.json().catch(() => ({}));

    if (!res.ok || payload.error) {
      const err = new Error(`Redis returned ${res.status}: ${payload.error ?? "unknown error"}`);
      err.status = res.status;
      throw err;
    }
    return payload.result;
  }

  async function byTwilioNumber(twilioNumber) {
    const key = digitsOf(twilioNumber);
    if (!key) return null;

    const raw = await command("GET", `${KEY_PREFIX}${key}`);
    return raw ? JSON.parse(raw) : null;
  }

  async function upsert(twilioNumber, patch) {
    const key = digitsOf(twilioNumber);
    if (!key) throw new Error("twilioNumber must contain digits");

    const existing = await byTwilioNumber(twilioNumber);
    const next = mergeSubscriber(existing, twilioNumber, patch);

    await command("SET", `${KEY_PREFIX}${key}`, JSON.stringify(next));
    // Keep an index so `all()` is not a KEYS scan - KEYS blocks the server.
    await command("SADD", INDEX_KEY, key);
    return next;
  }

  async function recordReply(twilioNumber, callerNumber, nowMs) {
    const key = digitsOf(twilioNumber);
    const sub = await byTwilioNumber(twilioNumber);
    if (!sub) return null;

    if (!sub.unlimited) sub.replyCount = (sub.replyCount ?? 0) + 1;
    sub.lastReply = { ...(sub.lastReply ?? {}), [digitsOf(callerNumber)]: nowMs };

    const cooldown = Number(sub.debounceMs ?? 30 * 60 * 1000);
    for (const [num, at] of Object.entries(sub.lastReply)) {
      if (nowMs - at > cooldown) delete sub.lastReply[num];
    }

    await command("SET", `${KEY_PREFIX}${key}`, JSON.stringify(sub));
    return sub;
  }

  async function lastReplyAt(twilioNumber, callerNumber) {
    const sub = await byTwilioNumber(twilioNumber);
    const at = sub?.lastReply?.[digitsOf(callerNumber)];
    return typeof at === "number" ? at : null;
  }

  async function all() {
    const keys = (await command("SMEMBERS", INDEX_KEY)) ?? [];
    if (!keys.length) return [];

    const values = (await command("MGET", ...keys.map((k) => `${KEY_PREFIX}${k}`))) ?? [];
    return values.filter(Boolean).map((raw) => JSON.parse(raw));
  }

  return { kind: "redis", byTwilioNumber, upsert, recordReply, lastReplyAt, all };
}

/** Exposed so a deployment can generate one rather than pick a weak string. */
export function generateApiKey() {
  return crypto.randomBytes(32).toString("base64url");
}

export { defaults };
