import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/routes.js";
import { createStore } from "../src/store.js";
import { createGoogleTokenSource, decodeJwtParts } from "../src/google-auth.js";
import { createPlayBillingClient, PURCHASE_STATE } from "../src/play-billing.js";

/**
 * Play purchase verification.
 *
 * Driven through app.handle with mock req/res rather than a socket: nothing
 * here needs a real listener, and a leaked server would hang the whole suite.
 */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    provider: "twilio",
    twilioAccountSid: "ACtest",
    twilioAuthToken: "tok",
    publicBaseUrl: "https://mctb.example.com",
    apiKey: "sekret",
    playProductId: "unlimited_replies",
    maxBodyBytes: 64 * 1024,
    ...overrides,
  };
}

function buildHarness({ billing = null, config: cfg } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-billing-"));
  const store = createStore(path.join(dir, "s.json"));
  const config = cfg ?? baseConfig();
  const provider = {
    name: "twilio",
    maxDialTimeout: 600,
    verifyWebhook: () => true,
    sendSms: async () => ({ ok: true }),
  };
  const app = createApp({ store, provider, config, logger: SILENT, billing });
  return { app, store, dir };
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

async function verify(harness, body, auth = null) {
  const res = mockRes();
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  await harness.app.handle(
    {
      method: "POST",
      url: "/billing/verify",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    res,
  );
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null };
}

/** A Play API double that records what it was asked and returns a canned reply. */
function fakePlay(reply, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    };
  };
  return { calls, fetchImpl };
}

async function seedSubscriber(store, twilioNumber) {
  return store.upsert(twilioNumber, {
    enabled: true,
    forwardTo: "+15558000002",
    message: "On a job.",
  });
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test("an unconfigured server refuses billing rather than pretending", async (t) => {
  const h = buildHarness({ billing: null });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  await seedSubscriber(h.store, "+15559000001");

  const r = await verify(h, { twilioNumber: "+15559000001", purchaseToken: "tok" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "billing_not_configured");
});

test("a purchase Google confirms lifts the free tier", async (t) => {
  const play = fakePlay({
    purchaseState: PURCHASE_STATE.PURCHASED,
    acknowledgementState: 1,
    orderId: "GPA.1234-5678",
  });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await seedSubscriber(h.store, "+15559000001");

  const r = await verify(h, { purchaseToken: "real-token" }, sub.apiToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.unlocked, true);
  assert.equal(r.body.orderId, "GPA.1234-5678");

  const after = await h.store.byTwilioNumber("+15559000001");
  assert.equal(after.unlimited, true);
  assert.equal(after.purchaseToken, "real-token");

  // The product id and package must come from config, not the request.
  assert.match(play.calls[0].url, /com\.mctb\.autoreply/);
  assert.match(play.calls[0].url, /unlimited_replies/);
  assert.equal(play.calls[0].init.headers.Authorization, "Bearer ya29.fake");
});

test("a token Google has never heard of is rejected", async (t) => {
  const play = fakePlay({}, { status: 404 });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await seedSubscriber(h.store, "+15559000001");

  const r = await verify(h, { purchaseToken: "forged" }, sub.apiToken);
  assert.equal(r.status, 402);
  assert.equal(r.body.reason, "token_not_found");

  const after = await h.store.byTwilioNumber("+15559000001");
  assert.equal(after.unlimited, false, "a rejected purchase must not unlock anything");
});

test("a cancelled or refunded purchase is rejected", async (t) => {
  const play = fakePlay({ purchaseState: PURCHASE_STATE.CANCELED });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await seedSubscriber(h.store, "+15559000001");

  const r = await verify(h, { purchaseToken: "refunded" }, sub.apiToken);
  assert.equal(r.status, 402);
  assert.equal(r.body.reason, "not_purchased");
  assert.equal((await h.store.byTwilioNumber("+15559000001")).unlimited, false);
});

test("one purchase cannot unlock a second number", async (t) => {
  // The replay attack this exists to stop: lift a valid token off one device
  // and post it against every number on the account.
  const play = fakePlay({ purchaseState: PURCHASE_STATE.PURCHASED, orderId: "GPA.1" });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const one = await seedSubscriber(h.store, "+15559000001");
  const two = await seedSubscriber(h.store, "+15559000002");

  const first = await verify(h, { purchaseToken: "shared-token" }, one.apiToken);
  assert.equal(first.status, 200);

  const second = await verify(h, { purchaseToken: "shared-token" }, two.apiToken);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "purchase_already_redeemed");
  assert.equal((await h.store.byTwilioNumber("+15559000002")).unlimited, false);

  // And it must not have burned an API call to find that out.
  assert.equal(play.calls.length, 1);
});

test("re-verifying the same purchase is idempotent", async (t) => {
  const play = fakePlay({ purchaseState: PURCHASE_STATE.PURCHASED, orderId: "GPA.1" });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const sub = await seedSubscriber(h.store, "+15559000001");

  await verify(h, { purchaseToken: "tok" }, sub.apiToken);
  // A dropped response makes the app retry; that must not fail.
  const retry = await verify(h, { purchaseToken: "tok" }, sub.apiToken);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyVerified, true);
});

test("an unknown subscriber is refused before any API call", async (t) => {
  const play = fakePlay({ purchaseState: PURCHASE_STATE.PURCHASED });
  const billing = createPlayBillingClient({
    packageName: "com.mctb.autoreply",
    getAccessToken: async () => "ya29.fake",
    fetchImpl: play.fetchImpl,
  });

  const h = buildHarness({ billing });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const r = await verify(h, { twilioNumber: "+15559000099", purchaseToken: "tok" }, "sekret");
  assert.equal(r.status, 404);
  assert.equal(play.calls.length, 0);
});

test("a malformed body is a 400, not a 500", async (t) => {
  const h = buildHarness({
    billing: { verifyPurchase: async () => ({ valid: true, reason: "ok" }) },
  });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const r = await verify(h, "{not json");
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_json");
});

// ---------------------------------------------------------------------------
// The service account JWT
// ---------------------------------------------------------------------------

test("the service account assertion is a correctly signed RS256 JWT", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let captured = null;

  const source = createGoogleTokenSource({
    serviceAccount: {
      client_email: "billing@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    },
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ access_token: "ya29.real", expires_in: 3600 }) };
    },
  });

  const token = await source.getAccessToken();
  assert.equal(token, "ya29.real");
  assert.equal(captured.url, "https://oauth2.googleapis.com/token");

  const assertion = new URLSearchParams(captured.init.body).get("assertion");
  const parts = decodeJwtParts(assertion);

  // The signature must actually verify against the public key. This is the
  // part Google rejects outright if the key material or algorithm is wrong.
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(parts.signingInput)
    .verify(publicKey, parts.signatureBytes);
  assert.equal(ok, true, "JWT signature did not verify");

  assert.equal(parts.header.alg, "RS256");
  assert.equal(parts.claims.iss, "billing@proj.iam.gserviceaccount.com");
  assert.equal(parts.claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(parts.claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert.equal(parts.claims.iat, 1_700_000_000);
  assert.equal(parts.claims.exp, 1_700_003_600);
});

test("the access token is cached until it is near expiry", async () => {
  let nowMs = 1_700_000_000_000;
  let calls = 0;

  const source = createGoogleTokenSource({
    serviceAccount: {
      client_email: "billing@proj.iam.gserviceaccount.com",
      private_key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    },
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) };
    },
  });

  assert.equal(await source.getAccessToken(), "tok-1");
  assert.equal(await source.getAccessToken(), "tok-1");
  assert.equal(calls, 1, "a valid token must not be re-minted");

  nowMs += 3_550_000; // within the 60s skew of expiry
  assert.equal(await source.getAccessToken(), "tok-2");
  assert.equal(calls, 2);
});

test("a failed token exchange surfaces the status, not a silent null", async () => {
  // A real key, so signing succeeds and the failure under test is genuinely
  // the token endpoint's response rather than a crypto error thrown first.
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const source = createGoogleTokenSource({
    serviceAccount: {
      client_email: "a@b.iam",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "invalid_grant" }),
  });

  await assert.rejects(() => source.getAccessToken(), /401/);
});

test("an unusable private key fails loudly rather than sending a bad assertion", async () => {
  const source = createGoogleTokenSource({
    serviceAccount: { client_email: "a@b.iam", private_key: "not-a-key" },
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });

  await assert.rejects(() => source.getAccessToken());
});

test("an incomplete service account is rejected at construction", () => {
  assert.throws(() => createGoogleTokenSource({ serviceAccount: { client_email: "a@b" } }),
    /client_email and private_key/);
});
