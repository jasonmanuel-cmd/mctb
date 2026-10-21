import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/routes.js";
import { createStore, mergeSubscriber, newApiToken } from "../src/store.js";

/**
 * Per-subscriber credentials.
 *
 * The operator API_KEY configures every number, so it can never be handed to a
 * customer. These cover the scoped alternative: a subscriber authenticating as
 * itself, and the boundary between what it may and may not change.
 */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

function buildHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-token-"));
  const store = createStore(path.join(dir, "s.json"));
  const config = {
    provider: "twilio",
    twilioAccountSid: "ACtest",
    twilioAuthToken: "tok",
    publicBaseUrl: "https://mctb.example.com",
    apiKey: "operator-key",
    playProductId: "unlimited_replies",
    maxBodyBytes: 64 * 1024,
  };
  const provider = {
    name: "twilio",
    maxDialTimeout: 600,
    verifyWebhook: () => true,
    sendSms: async () => ({ ok: true }),
  };
  return { app: createApp({ store, provider, config, logger: SILENT }), store, dir };
}

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    payload: null,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(p) {
      this.payload = p;
    },
  };
}

async function call(harness, { method, url, auth, body }) {
  const res = mockRes();
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  await harness.app.handle(
    { method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    res,
  );
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null };
}

test("every subscriber gets a distinct, non-empty token", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const a = await h.store.upsert("+15559000001", { enabled: true });
  const b = await h.store.upsert("+15559000002", { enabled: true });

  assert.ok(a.apiToken && a.apiToken.length >= 24);
  assert.notEqual(a.apiToken, b.apiToken);
  assert.equal(newApiToken() === newApiToken(), false, "tokens must not repeat");
});

test("a subscriber can read its own settings with its own token", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true, message: "On a job." });

  const r = await call(h, { method: "GET", url: "/me", auth: sub.apiToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.twilioNumber, "+15559000001");
  assert.equal(r.body.message, "On a job.");
});

test("an unknown token is refused", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  await h.store.upsert("+15559000001", { enabled: true });

  const r = await call(h, { method: "GET", url: "/me", auth: "not-a-real-token" });
  assert.equal(r.status, 401);
});

test("the operator key is rejected on /me because it is not scoped", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const r = await call(h, { method: "GET", url: "/me", auth: "operator-key" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "operator_key_not_scoped");
});

test("a subscriber can change its message but not its own tier", async (t) => {
  // The point of the narrow whitelist: `unlimited` is accepted by the
  // operator's sanitize(), so if /me reused it a customer could grant
  // themselves the upgrade they are supposed to buy.
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true });

  const r = await call(h, {
    method: "PATCH",
    url: "/me",
    auth: sub.apiToken,
    body: { message: "Tied up until 4.", unlimited: true, limit: 9999, apiToken: "hijacked" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, "Tied up until 4.", "an allowed field must still apply");

  const stored = await h.store.byTwilioNumber("+15559000001");
  assert.equal(stored.unlimited, false, "self-service must not lift the tier");
  assert.equal(stored.limit, 5, "self-service must not lift the quota");
  assert.equal(stored.apiToken, sub.apiToken, "self-service must not rotate the credential");
});

test("credentials never appear in a response body", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true });
  await h.store.upsert("+15559000001", { unlimited: true, purchaseToken: "play-receipt" });

  const me = await call(h, { method: "GET", url: "/me", auth: sub.apiToken });
  assert.equal(me.body.apiToken, undefined);
  assert.equal(me.body.purchaseToken, undefined);

  const list = await call(h, { method: "GET", url: "/subscribers", auth: "operator-key" });
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes(sub.apiToken), "the operator list must not leak tokens");
  assert.ok(!raw.includes("play-receipt"), "the operator list must not leak receipts");
});

test("a subscriber token cannot be used on the operator endpoints", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true });
  await h.store.upsert("+15559000002", { enabled: true });

  // Scoped to itself, so another subscriber's record is out of reach.
  const other = await call(h, {
    method: "GET",
    url: "/subscribers/%2B15559000002",
    auth: sub.apiToken,
  });
  assert.equal(other.status, 401);

  const list = await call(h, { method: "GET", url: "/subscribers", auth: sub.apiToken });
  assert.equal(list.status, 401);
});

test("a pre-token record acquires a token on its next merge", () => {
  // Backfill path: a record written before tokens existed has no apiToken.
  // Testing mergeSubscriber directly is the only way to get one in front of
  // the merge, since upsert() would otherwise read the cached record that
  // already has a token.
  const legacy = {
    twilioNumber: "+15559000001",
    forwardTo: "+15558000002",
    enabled: true,
    message: "On a job.",
    timeZone: "UTC",
    activeHours: { startMinuteOfDay: 480, endMinuteOfDay: 1080, alwaysOn: false },
    replyCount: 0,
    unlimited: false,
    limit: 5,
    debounceMs: 1800000,
    ringSeconds: 25,
    lastReply: {},
  };
  assert.equal(legacy.apiToken, undefined, "precondition: the legacy record has no token");

  const merged = mergeSubscriber(legacy, "+15559000001", { message: "Still on a job." });
  assert.ok(merged.apiToken, "a token should have been backfilled");
  assert.equal(merged.message, "Still on a job.", "the write must still apply");
});

test("the operator can retrieve a subscriber's token, and only the operator", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true });

  const r = await call(h, {
    method: "GET",
    url: "/subscribers/%2B15559000001/token",
    auth: "operator-key",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.apiToken, sub.apiToken);

  // A subscriber must not be able to read another customer's credential.
  const other = await h.store.upsert("+15559000002", { enabled: true });
  const stolen = await call(h, {
    method: "GET",
    url: "/subscribers/%2B15559000001/token",
    auth: other.apiToken,
  });
  assert.equal(stolen.status, 401);
});

test("the token endpoint does not ride along on ordinary reads", async (t) => {
  const h = buildHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await h.store.upsert("+15559000001", { enabled: true });

  const single = await call(h, {
    method: "GET",
    url: "/subscribers/%2B15559000001",
    auth: "operator-key",
  });
  assert.equal(single.status, 200);
  assert.equal(single.body.apiToken, undefined, "the credential stays off ordinary reads");
});
