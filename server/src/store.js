import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MESSAGE, FREE_TIER_LIMIT, DEFAULT_DEBOUNCE_MS, MINUTES_IN_DAY, digitsOf } from "./policy.js";

/**
 * File-backed subscriber store.
 *
 * Every method is async even though this implementation is synchronous, because
 * the store interface has to work for a networked backend too. Callers await
 * uniformly and swapping the backend changes nothing above this line.
 *
 * IMPORTANT: this backend needs a persistent disk. It is correct on a VM or
 * container with a volume, and WRONG on serverless, where the filesystem is
 * ephemeral and not shared between invocations. Use the Redis-backed store
 * (store-redis.js) there.
 *
 * Limits, stated plainly: atomic against a torn write and against a crash, but
 * NOT against concurrent writes from multiple processes - there is no lock
 * across read-modify-write.
 */

const SCHEMA_VERSION = 1;

export function createStore(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let cache = read();

  function read() {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== SCHEMA_VERSION) return empty();
      return parsed;
    } catch (err) {
      if (err.code === "ENOENT") return empty();
      // Corrupt file: refuse to start rather than silently discarding every
      // subscriber's configuration.
      throw new Error(`Refusing to start: cannot read store at ${filePath}: ${err.message}`);
    }
  }

  function empty() {
    return { version: SCHEMA_VERSION, subscribers: {} };
  }

  function persist() {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  }

  async function byTwilioNumber(twilioNumber) {
    const key = digitsOf(twilioNumber);
    return key ? cache.subscribers[key] ?? null : null;
  }

  async function upsert(twilioNumber, patch) {
    const key = digitsOf(twilioNumber);
    if (!key) throw new Error("twilioNumber must contain digits");

    const existing = cache.subscribers[key] ?? defaults(twilioNumber);
    const next = {
      ...existing,
      ...patch,
      twilioNumber: existing.twilioNumber,
      activeHours: { ...existing.activeHours, ...(patch.activeHours ?? {}) },
    };
    validate(next);
    cache.subscribers[key] = next;
    persist();
    return next;
  }

  /** Records a sent reply: bumps quota and stamps the per-caller cooldown. */
  async function recordReply(twilioNumber, callerNumber, nowMs) {
    const key = digitsOf(twilioNumber);
    const sub = cache.subscribers[key];
    if (!sub) return null;

    if (!sub.unlimited) sub.replyCount = (sub.replyCount ?? 0) + 1;

    sub.lastReply = { ...(sub.lastReply ?? {}), [digitsOf(callerNumber)]: nowMs };

    // Prune expired cooldown entries so this map cannot grow without bound -
    // the first Android implementation minted a preference key per number and
    // never removed one.
    const cooldown = Number(sub.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    for (const [num, at] of Object.entries(sub.lastReply)) {
      if (nowMs - at > cooldown) delete sub.lastReply[num];
    }

    persist();
    return sub;
  }

  async function lastReplyAt(twilioNumber, callerNumber) {
    const sub = await byTwilioNumber(twilioNumber);
    const at = sub?.lastReply?.[digitsOf(callerNumber)];
    return typeof at === "number" ? at : null;
  }

  async function all() {
    return Object.values(cache.subscribers);
  }

  return {
    kind: "file",
    byTwilioNumber,
    upsert,
    recordReply,
    lastReplyAt,
    all,
    filePath,
  };
}

/** Shared by every backend, so validation cannot drift between them. */
export function defaults(twilioNumber) {
  return {
    twilioNumber,
    forwardTo: "",
    enabled: false,
    message: DEFAULT_MESSAGE,
    timeZone: "UTC",
    activeHours: { startMinuteOfDay: 8 * 60, endMinuteOfDay: 18 * 60, alwaysOn: false },
    replyCount: 0,
    unlimited: false,
    limit: FREE_TIER_LIMIT,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    ringSeconds: 25,
    lastReply: {},
  };
}

/** Shared merge + validation, so backends cannot disagree about what is legal. */
export function mergeSubscriber(existing, twilioNumber, patch) {
  const base = existing ?? defaults(twilioNumber);
  const next = {
    ...base,
    ...patch,
    twilioNumber: base.twilioNumber,
    activeHours: { ...base.activeHours, ...(patch.activeHours ?? {}) },
  };
  validate(next);
  return next;
}

export function validate(sub) {
  const { startMinuteOfDay, endMinuteOfDay } = sub.activeHours;
  for (const [name, value] of [["startMinuteOfDay", startMinuteOfDay], ["endMinuteOfDay", endMinuteOfDay]]) {
    if (!Number.isInteger(value) || value < 0 || value >= MINUTES_IN_DAY) {
      throw new Error(`${name} must be an integer in [0, ${MINUTES_IN_DAY}) but was ${value}`);
    }
  }
  if (String(sub.message ?? "").length > 160) {
    throw new Error("message exceeds 160 characters");
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: sub.timeZone || "UTC" });
  } catch {
    throw new Error(`unknown timeZone: ${sub.timeZone}`);
  }
}
