import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import handler, { __resetApp } from "../api/index.js";

/**
 * The serverless adapter, exercised directly with mock req/res.
 *
 * What matters here is the failure behaviour: a broken deployment must be
 * distinguishable from a broken request, and a health check must still answer
 * when the configuration is wrong - that is the only time it is useful.
 */

// Mirrors the parts of node:http ServerResponse that the app uses. Vercel hands
// the handler a real ServerResponse, so writeHead must exist here too.
function mockRes() {
  return {
    statusCode: null,
    headers: {},
    payload: null,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
      return this;
    },
    end(p) {
      this.payload = p;
      this.headersSent = true;
    },
  };
}

// Must be async: the adapter builds the app in a microtask, so restoring the
// environment synchronously would undo it before buildApp ever read it.
async function withEnv(overrides, fn) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  __resetApp();
  try {
    return await fn();
  } finally {
    process.env = saved;
    __resetApp();
  }
}

function validEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctb-vercel-"));
  return {
    PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "tok",
    PUBLIC_BASE_URL: "https://mctb.example.com",
    STORE_PATH: path.join(dir, "s.json"),
    REDIS_REST_URL: null,
    REDIS_REST_TOKEN: null,
  };
}

test("healthz answers with no configuration at all", async () => {
  await withEnv(
    {
      PROVIDER: null,
      TWILIO_ACCOUNT_SID: null,
      TWILIO_AUTH_TOKEN: null,
      PUBLIC_BASE_URL: null,
    },
    async () => {
      const res = mockRes();
      await handler({ method: "GET", url: "/healthz", headers: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), { ok: true, runtime: "serverless" });
    },
  );
});

test("the root path answers as a health check", async () => {
  await withEnv({ PUBLIC_BASE_URL: null }, async () => {
    const res = mockRes();
    await handler({ method: "GET", url: "/", headers: {} }, res);
    assert.equal(res.statusCode, 200);
  });
});

test("a missing credential is reported as a configuration error", async () => {
  // Distinguishing this from a request bug is the whole point: both would
  // otherwise be a bare 500.
  await withEnv(
    {
      PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: null,
      TWILIO_AUTH_TOKEN: null,
      PUBLIC_BASE_URL: null,
    },
    async () => {
      const res = mockRes();
      await handler(
        {
          method: "POST",
          url: "/voice/completed",
          headers: {},
          body: "",
          [Symbol.asyncIterator]: async function* () {},
        },
        res,
      );
      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.payload);
      assert.equal(body.error, "configuration_error");
      assert.match(body.detail, /Missing required environment variable/);
    },
  );
});

test("a malformed URL is rejected rather than crashing", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    await handler({ method: "GET", url: "http://[bad", headers: {} }, res);
    assert.equal(res.statusCode, 400);
  });
});

test("with valid config, requests route through to the app", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    // No signature, so the app must reject it - which proves the request
    // reached the app's routing rather than the adapter's error path.
    await handler(
      {
        method: "POST",
        url: "/voice/completed",
        headers: {},
        body: "From=%2B15550101234&To=%2B15559000001",
      },
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.payload), { error: "invalid_signature" });
  });
});

test("the settings API is reachable through the adapter", async () => {
  await withEnv({ ...validEnv(), API_KEY: "sekret" }, async () => {
    const res = mockRes();
    await handler(
      {
        method: "PUT",
        url: "/subscribers/%2B15559000001",
        headers: { authorization: "Bearer sekret" },
        body: JSON.stringify({ enabled: true, forwardTo: "+15558000002", message: "On a job." }),
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).forwardTo, "+15558000002");
  });
});

test("the control panel is served through the adapter", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    await handler({ method: "GET", url: "/panel", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.match(String(res.payload), /Missed Call Reply/);
  });
});
