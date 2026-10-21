import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../src/index.js";
import { computeTwilioSignature } from "../src/signature.js";
import { minuteOfDay } from "../src/policy.js";
import { createApp } from "../src/routes.js";
import { createStore } from "../src/store.js";

const AUTH_TOKEN = "test_auth_token_0000000000000000";
const ACCOUNT_SID = "AC0000000000000000000000000000aa";
const BASE = "https://mctb.example.com";
const TWILIO_NUMBER = "+15559000001";
const SUBSCRIBER_PHONE = "+15558000002";

/** Boots the real server on an ephemeral port with a fake SMS transport. */
function startServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-"));
  const sent = [];
  const order = [];
  const sms = {
    send: async (msg) => {
      if (overrides.failSms) throw Object.assign(new Error("boom"), { code: 21612 });
      order.push("sms");
      sent.push(msg);
      return { sid: `SM${sent.length}`, status: "queued" };
    },
  };

  const config = {
    twilioAccountSid: ACCOUNT_SID,
    twilioAuthToken: AUTH_TOKEN,
    publicBaseUrl: BASE,
    port: 0,
    storePath: path.join(dir, "subscribers.json"),
    apiKey: overrides.apiKey ?? "",
    maxBodyBytes: 64 * 1024,
  };

  const store = createStore(config.storePath);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = createApp({ store, sms, config, logger });
  const server = http.createServer((req, res) => {
    // Record when the response is written so tests can assert the SMS went out
    // first. On serverless, anything after res.end() may never run.
    const end = res.end.bind(res);
    res.end = (...args) => {
      order.push("response");
      return end(...args);
    };
    app.handle(req, res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        sent,
        order,
        store,
        // close() alone waits for keep-alive sockets that fetch leaves open,
        // so force them closed - otherwise a single failure hangs the runner.
        close: () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Sends a webhook the way Twilio does, with a correct signature. */
async function postTwilio(base, urlPath, fields, { tamper = false } = {}) {
  const body = new URLSearchParams(fields).toString();
  const signature = computeTwilioSignature({
    url: `${BASE}${urlPath}`,
    params: Object.fromEntries(new URLSearchParams(body)),
    authToken: AUTH_TOKEN,
  });
  return fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": tamper ? `${signature}x` : signature,
    },
    body,
  });
}

async function seedSubscriber(store, patch = {}) {
  await store.upsert(TWILIO_NUMBER, {
    enabled: true,
    forwardTo: SUBSCRIBER_PHONE,
    message: "On a job - will call you back shortly.",
    timeZone: "UTC",
    activeHours: { startMinuteOfDay: minuteOfDay(0, 0), endMinuteOfDay: minuteOfDay(23, 59), alwaysOn: true },
    ...patch,
  });
}

const inbound = { From: "+15550101234", To: TWILIO_NUMBER, CallSid: "CA1" };

test("healthz is open and needs no signature", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await fetch(`${s.base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("an unsigned webhook is rejected", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  const res = await fetch(`${s.base}/voice`, { method: "POST", body: new URLSearchParams(inbound).toString() });
  assert.equal(res.status, 403);
  assert.equal(s.sent.length, 0);
});

test("a tampered signature is rejected", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  const res = await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" }, { tamper: true });
  assert.equal(res.status, 403);
  assert.equal(s.sent.length, 0);
});

test("an inbound call to a configured subscriber forwards and sets the callback", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  const res = await postTwilio(s.base, "/voice", inbound);
  assert.equal(res.status, 200);
  const twiml = await res.text();
  assert.match(twiml, /<Dial action="https:\/\/mctb\.example\.com\/voice\/completed"/);
  assert.match(twiml, /<Number>\+15558000002<\/Number>/);
  // Twilio is told which number to present; using anything else fails.
  assert.match(twiml, /callerId="\+15559000001"/);
});

test("an inbound call to an unconfigured number hangs up rather than erroring", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await postTwilio(s.base, "/voice", { ...inbound, To: "+15550000000" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Hangup\/>/);
});

test("a missed call sends the text - the whole point of the app", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  const res = await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal(res.status, 200);

  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], {
    from: TWILIO_NUMBER,
    to: "+15550101234",
    body: "On a job - will call you back shortly.",
  });
});

test("an answered call sends nothing", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "completed" });
  assert.equal(s.sent.length, 0);
});

test("two missed calls from the same caller within the window send one text", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal(s.sent.length, 1);
});

test("different callers are debounced independently", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  await postTwilio(s.base, "/voice/completed", { ...inbound, From: "+15550109999", DialCallStatus: "no-answer" });
  assert.equal(s.sent.length, 2);
});

test("quota stops at the free tier limit", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store, { limit: 2 });
  for (let i = 0; i < 5; i += 1) {
    await postTwilio(s.base, "/voice/completed", {
      ...inbound,
      From: `+1555010${String(i).padStart(4, "0")}`,
      DialCallStatus: "no-answer",
    });
  }
  assert.equal(s.sent.length, 2);
});

test("a disabled subscriber gets no text even on a miss", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store, { enabled: false });
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal(s.sent.length, 0);
});

test("a withheld caller gets no text", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  await postTwilio(s.base, "/voice/completed", { ...inbound, From: "UNKNOWN", DialCallStatus: "no-answer" });
  assert.equal(s.sent.length, 0);
});

test("a failed SMS does not consume quota", async (t) => {
  const s = await startServer({ failSms: true });
  t.after(() => s.close());
  await seedSubscriber(s.store, { limit: 1 });
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal((await s.store.byTwilioNumber(TWILIO_NUMBER)).replyCount, 0);
});

test("a sent SMS does consume quota", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);
  await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal((await s.store.byTwilioNumber(TWILIO_NUMBER)).replyCount, 1);
});

test("the settings API is disabled without an API key", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await fetch(`${s.base}/subscribers/${TWILIO_NUMBER}`, { method: "PUT", body: "{}" });
  assert.equal(res.status, 503);
});

test("the settings API rejects a wrong key", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  t.after(() => s.close());
  const res = await fetch(`${s.base}/subscribers/${TWILIO_NUMBER}`, {
    method: "PUT",
    headers: { Authorization: "Bearer wrong" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("the settings API creates a subscriber and rejects invalid values", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  t.after(() => s.close());
  const headers = { Authorization: "Bearer sekret", "Content-Type": "application/json" };

  const ok = await fetch(`${s.base}/subscribers/${TWILIO_NUMBER}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: true,
      forwardTo: SUBSCRIBER_PHONE,
      message: "In a meeting.",
      activeHours: { startMinuteOfDay: 540, endMinuteOfDay: 1080 },
    }),
  });
  assert.equal(ok.status, 200);
  const created = await ok.json();
  assert.equal(created.forwardTo, SUBSCRIBER_PHONE);
  assert.equal(created.replyCount, 0);

  const bad = await fetch(`${s.base}/subscribers/${TWILIO_NUMBER}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ activeHours: { startMinuteOfDay: 5000 } }),
  });
  assert.equal(bad.status, 422);
});

test("subscribers survive a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-persist-"));
  const storePath = path.join(dir, "subscribers.json");

  const first = createStore(storePath);
  await first.upsert(TWILIO_NUMBER, { enabled: true, forwardTo: SUBSCRIBER_PHONE, message: "hi" });

  const second = createStore(storePath);
  assert.equal((await second.byTwilioNumber(TWILIO_NUMBER)).forwardTo, SUBSCRIBER_PHONE);
});

test("buildServer refuses to start without its Twilio credentials", async (t) => {
  assert.throws(() => buildServer({}), /Missing required environment variable\(s\): TWILIO_ACCOUNT_SID/);
});

test("unknown paths 404 rather than leaking a stack", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await fetch(`${s.base}/nope`);
  assert.equal(res.status, 404);
});

test("the control panel is served as HTML", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  const res = await fetch(`${s.base}/panel`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /Missed Call Reply/);
  assert.match(html, /id="form"/);
});

test("the control panel loads with no key baked in", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  const html = await (await fetch(`${s.base}/panel`)).text();
  // A key committed into the page would be readable by anyone who fetches it.
  assert.ok(!html.includes("sekret"), "API key leaked into the served HTML");
});

test("the subscriber list requires auth", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  const anon = await fetch(`${s.base}/subscribers`);
  assert.equal(anon.status, 401);
  const authed = await fetch(`${s.base}/subscribers`, {
    headers: { Authorization: "Bearer sekret" },
  });
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), { subscribers: [] });
});

test("the subscriber list reports what the panel needs", async (t) => {
  const s = await startServer({ apiKey: "sekret" });
  t.after(() => s.close());
  await seedSubscriber(s.store);
  const res = await fetch(`${s.base}/subscribers`, {
    headers: { Authorization: "Bearer sekret" },
  });
  const { subscribers } = await res.json();
  assert.equal(subscribers.length, 1);
  assert.equal(subscribers[0].twilioNumber, TWILIO_NUMBER);
  assert.equal(subscribers[0].forwardTo, SUBSCRIBER_PHONE);
  // lastReply holds per-caller numbers; it must not leave the server.
  assert.equal(subscribers[0].lastReply, undefined);
});

test("the reply is sent BEFORE the response is written", async (t) => {
  // On a serverless host the invocation is frozen the moment the response is
  // sent, so work queued after res.end() may never run. If this ordering ever
  // regresses, the text silently stops going out while the HTTP 200 and the
  // logs both say it worked.
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);

  const res = await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "no-answer" });
  assert.equal(res.status, 200);

  assert.deepEqual(s.order, ["sms", "response"]);
});

test("an answered call still writes exactly one response", async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await seedSubscriber(s.store);

  const res = await postTwilio(s.base, "/voice/completed", { ...inbound, DialCallStatus: "completed" });
  assert.equal(res.status, 200);
  assert.deepEqual(s.order, ["response"]);
});

// --- serverless body handling -------------------------------------------------
// These drive the handler directly with a pre-buffered body, the way a
// serverless platform delivers it, rather than over a socket.

function buildAppDirect() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-app-"));
  const sent = [];
  const sms = {
    send: async (m) => {
      sent.push(m);
      return { sid: `SM${sent.length}`, status: "queued" };
    },
  };
  const config = {
    twilioAccountSid: ACCOUNT_SID,
    twilioAuthToken: AUTH_TOKEN,
    publicBaseUrl: BASE,
    storePath: path.join(dir, "s.json"),
    apiKey: "",
    redisUrl: "",
    redisToken: "",
    maxBodyBytes: 64 * 1024,
  };
  const store = createStore(config.storePath);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return { app: createApp({ store, sms, config, logger }), store, sent };
}

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead(code, h) {
      this.statusCode = code;
      this.headers = h;
    },
    end(p) {
      this.payload = p;
    },
  };
}

function signedFields(extra = {}) {
  return { From: "+15550101234", To: "+15559000001", CallSid: "CA1", ...extra };
}

function signatureFor(fields) {
  return computeTwilioSignature({
    url: `${BASE}/voice/completed`,
    params: fields,
    authToken: AUTH_TOKEN,
  });
}

test("a pre-buffered string body is accepted", async () => {
  const { app, store, sent } = buildAppDirect();
  await store.upsert("+15559000001", {
    enabled: true,
    forwardTo: "+15558000002",
    message: "On a job.",
    activeHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439, alwaysOn: true },
  });

  const fields = signedFields({ DialCallStatus: "no-answer" });
  const req = {
    method: "POST",
    url: "/voice/completed",
    headers: { "x-twilio-signature": signatureFor(fields) },
    body: new URLSearchParams(fields).toString(),
  };
  const res = mockRes();
  await app.handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
});

test("a pre-buffered Buffer body is accepted", async () => {
  const { app, store, sent } = buildAppDirect();
  await store.upsert("+15559000001", {
    enabled: true,
    forwardTo: "+15558000002",
    message: "On a job.",
    activeHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439, alwaysOn: true },
  });

  const fields = signedFields({ DialCallStatus: "no-answer" });
  const req = {
    method: "POST",
    url: "/voice/completed",
    headers: { "x-twilio-signature": signatureFor(fields) },
    body: Buffer.from(new URLSearchParams(fields).toString(), "utf8"),
  };
  const res = mockRes();
  await app.handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
});

test("a platform-parsed body fails loudly instead of 403ing every call", async () => {
  const { app } = buildAppDirect();
  // A platform that parsed the body has also consumed the stream, so re-reading
  // it yields nothing. Without the explicit guard the handler would verify a
  // signature over an empty body and 403 every single webhook - which looks
  // exactly like a wrong auth token and sends you debugging the wrong thing.
  const req = {
    method: "POST",
    url: "/voice/completed",
    headers: {},
    body: { To: "+15559000001", From: "+15550101234" },
    [Symbol.asyncIterator]: async function* () {},
  };
  const res = mockRes();
  await app.handle(req, res);

  assert.equal(res.statusCode, 500);
  assert.match(String(res.payload), /internal_error/);
});

test("an oversized pre-buffered body is rejected", async () => {
  const { app } = buildAppDirect();
  const req = {
    method: "POST",
    url: "/voice/completed",
    headers: {},
    body: "x".repeat(64 * 1024 + 1),
  };
  const res = mockRes();
  await app.handle(req, res);
  assert.equal(res.statusCode, 413);
});
