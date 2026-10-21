import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRedisStore } from "../src/store-redis.js";
import { selectStore } from "../src/index.js";
import { minuteOfDay } from "../src/policy.js";

const TWILIO_NUMBER = "+15559000001";
const CALLER = "+15550101234";

/**
 * A tiny in-memory Redis that speaks the REST wire protocol.
 *
 * Only the five commands the store uses. It exists so the store's command
 * surface - key layout, serialisation, index maintenance - is genuinely
 * exercised rather than assumed.
 */
function fakeRedis() {
  const kv = new Map();
  const sets = new Map();
  const calls = [];

  async function fetchImpl(url, init) {
    const cmd = JSON.parse(init.body);
    calls.push(cmd);
    const [op, ...args] = cmd;

    let result;
    switch (op) {
      case "GET":
        result = kv.has(args[0]) ? kv.get(args[0]) : null;
        break;
      case "SET":
        kv.set(args[0], args[1]);
        result = "OK";
        break;
      case "SADD": {
        const s = sets.get(args[0]) ?? new Set();
        args.slice(1).forEach((m) => s.add(m));
        sets.set(args[0], s);
        result = args.length - 1;
        break;
      }
      case "SMEMBERS":
        result = [...(sets.get(args[0]) ?? [])];
        break;
      case "MGET":
        result = args.map((k) => (kv.has(k) ? kv.get(k) : null));
        break;
      default:
        return { ok: false, status: 400, json: async () => ({ error: `unsupported ${op}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  }

  return { fetchImpl, calls, kv, sets };
}

function makeStore(overrides = {}) {
  const fake = fakeRedis();
  const store = createRedisStore({
    url: "https://redis.example.com",
    token: "tok",
    fetchImpl: overrides.fetchImpl ?? fake.fetchImpl,
  });
  return { store, fake };
}

test("upsert writes the subscriber and indexes it", async () => {
  const { store, fake } = makeStore();
  await store.upsert(TWILIO_NUMBER, {
    enabled: true,
    forwardTo: "+15558000002",
    message: "On a job.",
  });

  assert.equal(fake.kv.has("mctb:sub:15559000001"), true);
  assert.deepEqual([...fake.sets.get("mctb:index")], ["15559000001"]);

  const back = await store.byTwilioNumber(TWILIO_NUMBER);
  assert.equal(back.forwardTo, "+15558000002");
  assert.equal(back.enabled, true);
});

test("lookup normalises formatting so +1 (555) matches 1555", async () => {
  const { store } = makeStore();
  await store.upsert(TWILIO_NUMBER, { forwardTo: "+15558000002" });
  assert.equal((await store.byTwilioNumber("+1 (555) 900-0001")).forwardTo, "+15558000002");
});

test("an unknown number returns null rather than throwing", async () => {
  const { store } = makeStore();
  assert.equal(await store.byTwilioNumber("+15550000000"), null);
});

test("upsert merges instead of clobbering", async () => {
  const { store } = makeStore();
  await store.upsert(TWILIO_NUMBER, { enabled: true, forwardTo: "+15558000002", message: "First." });
  await store.upsert(TWILIO_NUMBER, { message: "Second." });

  const back = await store.byTwilioNumber(TWILIO_NUMBER);
  assert.equal(back.message, "Second.");
  // The forwarding number must survive a message-only edit.
  assert.equal(back.forwardTo, "+15558000002");
  assert.equal(back.enabled, true);
});

test("upsert rejects an out-of-range active-hours value", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.upsert(TWILIO_NUMBER, { activeHours: { startMinuteOfDay: 5000 } }),
    /startMinuteOfDay must be an integer/,
  );
});

test("upsert rejects an unknown time zone", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.upsert(TWILIO_NUMBER, { timeZone: "Mars/Olympus_Mons" }),
    /unknown timeZone/,
  );
});

test("recordReply bumps quota and stamps the cooldown", async () => {
  const { store } = makeStore();
  await store.upsert(TWILIO_NUMBER, { enabled: true });

  const now = 1_800_000_000_000;
  await store.recordReply(TWILIO_NUMBER, CALLER, now);

  assert.equal(await store.lastReplyAt(TWILIO_NUMBER, CALLER), now);
  assert.equal((await store.byTwilioNumber(TWILIO_NUMBER)).replyCount, 1);
});

test("recordReply on an unknown number is a no-op", async () => {
  const { store } = makeStore();
  assert.equal(await store.recordReply("+15550000000", CALLER, 123), null);
});

test("recordReply prunes expired cooldown entries", async () => {
  const { store } = makeStore();
  await store.upsert(TWILIO_NUMBER, { enabled: true, debounceMs: 1000 });

  await store.recordReply(TWILIO_NUMBER, CALLER, 10_000);
  // Far enough later that the first entry is expired.
  const later = 10_000 + 60_000;
  await store.recordReply(TWILIO_NUMBER, "+15550109999", later);

  const sub = await store.byTwilioNumber(TWILIO_NUMBER);
  assert.deepEqual(Object.keys(sub.lastReply), ["15550109999"]);
});

test("all() returns every subscriber via the index, not a KEYS scan", async () => {
  const { store, fake } = makeStore();
  await store.upsert("+15559000001", { forwardTo: "+15558000001" });
  await store.upsert("+15559000002", { forwardTo: "+15558000002" });

  const all = await store.all();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((s) => s.twilioNumber).sort(), ["+15559000001", "+15559000002"]);

  // KEYS blocks a Redis server; the store must never issue one.
  assert.equal(fake.calls.some((c) => c[0] === "KEYS"), false);
});

test("all() on an empty store returns an empty list", async () => {
  const { store } = makeStore();
  assert.deepEqual(await store.all(), []);
});

test("the REST client sends bearer auth", async () => {
  let seen = null;
  const { store } = makeStore({
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.Authorization };
      return { ok: true, status: 200, json: async () => ({ result: null }) };
    },
  });
  await store.byTwilioNumber(TWILIO_NUMBER);
  assert.equal(seen.url, "https://redis.example.com");
  assert.equal(seen.auth, "Bearer tok");
});

test("a Redis error surfaces rather than reading as an empty store", async () => {
  const { store } = makeStore({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
  });
  await assert.rejects(() => store.byTwilioNumber(TWILIO_NUMBER), /Redis returned 500: boom/);
});

test("the store refuses to build without both credentials", () => {
  assert.throws(() => createRedisStore({ url: "https://x", token: "" }), /requires both/);
  assert.throws(() => createRedisStore({ url: "", token: "t" }), /requires both/);
});

test("selectStore picks Redis when its credentials are present", () => {
  const store = selectStore({ redisUrl: "https://x", redisToken: "t", storePath: "/tmp/nope.json" });
  assert.equal(store.kind, "redis");
});

test("selectStore falls back to the file store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-select-"));
  const store = selectStore({ redisUrl: "", redisToken: "", storePath: path.join(dir, "s.json") });
  assert.equal(store.kind, "file");
});

test("selectStore refuses a half-configured Redis", () => {
  // Silently falling back to the file store on serverless would lose data.
  assert.throws(
    () => selectStore({ redisUrl: "https://x", redisToken: "", storePath: "/tmp/nope.json" }),
    /must both be set/,
  );
});
