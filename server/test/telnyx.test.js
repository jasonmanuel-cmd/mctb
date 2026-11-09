import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyTelnyxSignature, createTelnyxSmsClient, REPLAY_WINDOW_MS } from "../src/telnyx.js";
import { createProvider } from "../src/provider.js";
import { createApp } from "../src/routes.js";
import { createStore } from "../src/store.js";
import { minuteOfDay } from "../src/policy.js";

const BASE = "https://mctb.example.com";
const TWILIO_NUMBER = "+15559000001";
const SUBSCRIBER_PHONE = "+15558000002";

/**
 * A real Ed25519 keypair, generated here rather than hardcoded, so the tests
 * exercise the actual signature path instead of a stub that always returns true.
 */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_KEY_B64 = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function sign(rawBody, timestamp) {
  const signed = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  return crypto.sign(null, signed, privateKey).toString("base64");
}

const NOW = Date.now();
const TS = String(Math.floor(NOW / 1000));

test("a correctly signed webhook verifies", () => {
  const body = "From=%2B15550101234&To=%2B15559000001&DialCallStatus=no-answer";
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: sign(body, TS),
      timestamp: TS,
      publicKey: PUBLIC_KEY_B64,
      nowMs: NOW,
    }),
    true,
  );
});

test("a tampered body fails verification", () => {
  const body = "From=%2B15550101234&To=%2B15559000001";
  const sig = sign(body, TS);
  assert.equal(
    verifyTelnyxSignature({
      rawBody: `${body}&DialCallStatus=no-answer`,
      signature: sig,
      timestamp: TS,
      publicKey: PUBLIC_KEY_B64,
      nowMs: NOW,
    }),
    false,
  );
});

test("a signature from a different key fails", () => {
  const other = crypto.generateKeyPairSync("ed25519");
  const otherPub = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const body = "From=%2B15550101234";
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: sign(body, TS),
      timestamp: TS,
      publicKey: otherPub,
      nowMs: NOW,
    }),
    false,
  );
});

test("a replayed webhook outside the window is rejected", () => {
  const body = "From=%2B15550101234";
  const oldTs = String(Math.floor((NOW - REPLAY_WINDOW_MS - 10_000) / 1000));
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: sign(body, oldTs),
      timestamp: oldTs,
      publicKey: PUBLIC_KEY_B64,
      nowMs: NOW,
    }),
    false,
  );
});

test("a timestamp in the future beyond the window is rejected", () => {
  const body = "From=%2B15550101234";
  const futureTs = String(Math.floor((NOW + REPLAY_WINDOW_MS + 10_000) / 1000));
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: sign(body, futureTs),
      timestamp: futureTs,
      publicKey: PUBLIC_KEY_B64,
      nowMs: NOW,
    }),
    false,
  );
});

test("malformed inputs reject instead of throwing", () => {
  const body = "From=%2B15550101234";
  const cases = [
    { rawBody: body, signature: "not-base64!!", timestamp: TS, publicKey: PUBLIC_KEY_B64 },
    { rawBody: body, signature: sign(body, TS).slice(0, 20), timestamp: TS, publicKey: PUBLIC_KEY_B64 },
    { rawBody: body, signature: sign(body, TS), timestamp: "yesterday", publicKey: PUBLIC_KEY_B64 },
    { rawBody: body, signature: sign(body, TS), timestamp: TS, publicKey: "not-a-key" },
    { rawBody: "", signature: sign(body, TS), timestamp: TS, publicKey: PUBLIC_KEY_B64 },
    { rawBody: body, signature: "", timestamp: TS, publicKey: PUBLIC_KEY_B64 },
  ];
  for (const c of cases) {
    assert.equal(verifyTelnyxSignature({ ...c, nowMs: NOW }), false, JSON.stringify(c).slice(0, 60));
  }
});

test("a PEM public key is accepted as well as a raw base64 key", () => {
  const pem = publicKey.export({ format: "pem", type: "spki" });
  const body = "From=%2B15550101234";
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: sign(body, TS),
      timestamp: TS,
      publicKey: pem,
      nowMs: NOW,
    }),
    true,
  );
});

test("an over-long signature is rejected even though Node would accept it", () => {
  // Ed25519 signatures are exactly 64 bytes; a valid signature with an extra
  // byte appended must not verify. Checked explicitly because Node's crypto
  // also rejects it, so this asserts the property rather than the mechanism.
  const body = "From=%2B15550101234";
  const padded = Buffer.concat([Buffer.from(sign(body, TS), "base64"), Buffer.from([0x00])]).toString("base64");

  // base64 of 64 bytes and of 65 bytes are both 88 characters, so compare the
  // decoded byte length - the string length proves nothing here.
  assert.equal(Buffer.from(padded, "base64").length, 65);
  assert.equal(
    verifyTelnyxSignature({
      rawBody: body,
      signature: padded,
      timestamp: TS,
      publicKey: PUBLIC_KEY_B64,
      nowMs: NOW,
    }),
    false,
  );
});

test("the SMS client posts JSON with a Bearer token", async () => {
  let seen = null;
  const sms = createTelnyxSmsClient({
    apiKey: "key_abc",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 202, json: async () => ({ data: { id: "msg_1", status: "queued" } }) };
    },
  });

  const res = await sms.send({ from: "+15559000001", to: "+15550101234", body: "On a job." });

  assert.equal(seen.url, "https://api.telnyx.com/v2/messages");
  assert.equal(seen.init.headers.Authorization, "Bearer key_abc");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  // Telnyx names the field `text`, not `Body` - sending the Twilio name would
  // post an empty message and bill for it.
  assert.deepEqual(JSON.parse(seen.init.body), {
    from: "+15559000001",
    to: "+15550101234",
    text: "On a job.",
  });
  assert.deepEqual(res, { sid: "msg_1", status: "queued" });
});

test("a Telnyx API error surfaces with its detail", async () => {
  const sms = createTelnyxSmsClient({
    apiKey: "key_abc",
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ errors: [{ code: "10007", title: "Unauthorized", detail: "invalid number" }] }),
    }),
  });
  await assert.rejects(() => sms.send({ from: "a", to: "b", body: "c" }), /422: invalid number/);
});

test("createProvider rejects an unknown provider", () => {
  assert.throws(() => createProvider({ provider: "vonage" }), /Unknown provider: vonage/);
});

test("createProvider caps the ring timeout per carrier", () => {
  assert.equal(createProvider({ provider: "twilio", twilioAuthToken: "t", twilioAccountSid: "a" }).maxDialTimeout, 600);
  assert.equal(
    createProvider({ provider: "telnyx", telnyxApiKey: "k", telnyxPublicKey: PUBLIC_KEY_B64 }).maxDialTimeout,
    120,
  );
});

// --- end to end over a real socket with Telnyx as the provider ----------------

function startTelnyxServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-telnyx-"));
  const sent = [];
  const config = {
    provider: "telnyx",
    telnyxApiKey: "key_abc",
    telnyxPublicKey: PUBLIC_KEY_B64,
    publicBaseUrl: BASE,
    apiKey: "",
    redisUrl: "",
    redisToken: "",
    storePath: path.join(dir, "s.json"),
    maxBodyBytes: 64 * 1024,
  };
  const store = createStore(config.storePath);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const provider = {
    ...createProvider(config),
    sendSms: async (m) => {
      sent.push(m);
      return { sid: `msg_${sent.length}`, status: "queued" };
    },
  };
  const app = createApp({ store, provider, config, logger });
  const server = http.createServer((req, res) => app.handle(req, res));

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        sent,
        store,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function postTelnyx(base, urlPath, fields) {
  const body = new URLSearchParams(fields).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": sign(body, timestamp),
    },
    body,
  });
}

test("a Telnyx missed call sends the text", async (t) => {
  const s = await startTelnyxServer();
  t.after(() => s.close());

  await s.store.upsert(TWILIO_NUMBER, {
    enabled: true,
    forwardTo: SUBSCRIBER_PHONE,
    message: "On a job - will call back.",
    activeHours: { startMinuteOfDay: minuteOfDay(0, 0), endMinuteOfDay: minuteOfDay(23, 59), alwaysOn: true },
  });

  const res = await postTelnyx(s.base, "/voice/completed", {
    From: "+15550101234",
    To: TWILIO_NUMBER,
    CallSid: "telnyx-call-1",
    DialCallStatus: "no-answer",
  });

  assert.equal(res.status, 200);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], {
    from: TWILIO_NUMBER,
    to: "+15550101234",
    body: "On a job - will call back.",
  });
});

test("a Telnyx answered call sends nothing", async (t) => {
  const s = await startTelnyxServer();
  t.after(() => s.close());

  await s.store.upsert(TWILIO_NUMBER, {
    enabled: true,
    forwardTo: SUBSCRIBER_PHONE,
    message: "On a job.",
    activeHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439, alwaysOn: true },
  });

  await postTelnyx(s.base, "/voice/completed", {
    From: "+15550101234",
    To: TWILIO_NUMBER,
    DialCallStatus: "completed",
  });

  assert.equal(s.sent.length, 0);
});

test("an unsigned Telnyx webhook is rejected", async (t) => {
  const s = await startTelnyxServer();
  t.after(() => s.close());

  const res = await fetch(`${s.base}/voice/completed`, {
    method: "POST",
    body: new URLSearchParams({
      From: "+15550101234",
      To: TWILIO_NUMBER,
      DialCallStatus: "no-answer",
    }).toString(),
  });

  assert.equal(res.status, 403);
  assert.equal(s.sent.length, 0);
});

test("a Twilio signature does not authenticate a Telnyx deployment", async (t) => {
  // Guarding against the two schemes being wired to the wrong provider.
  const s = await startTelnyxServer();
  t.after(() => s.close());

  const res = await fetch(`${s.base}/voice/completed`, {
    method: "POST",
    headers: { "x-twilio-signature": "anything" },
    body: "From=%2B15550101234&To=%2B15559000001&DialCallStatus=no-answer",
  });

  assert.equal(res.status, 403);
  assert.equal(s.sent.length, 0);
});

test("the TeXML dial timeout is clamped to Telnyx's 120s ceiling", async (t) => {
  const s = await startTelnyxServer();
  t.after(() => s.close());

  await s.store.upsert(TWILIO_NUMBER, {
    enabled: true,
    forwardTo: SUBSCRIBER_PHONE,
    ringSeconds: 500,
  });

  const res = await postTelnyx(s.base, "/voice", { From: "+15550101234", To: TWILIO_NUMBER });
  const twiml = await res.text();
  assert.match(twiml, /timeout="120"/);
});
