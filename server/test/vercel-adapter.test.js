import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import handler, { __resetApp } from "../api/index.js";
import { computeTwilioSignature } from "../src/signature.js";

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

// ---------------------------------------------------------------------------
// Path forwarding across a rewrite
//
// Whether Vercel preserves req.url through a rewrite depends on runtime and
// function type, so the original path is forwarded as ?__path=. These tests
// cover both behaviours so the adapter cannot be silently broken by either.
// ---------------------------------------------------------------------------

test("routes correctly when the rewrite flattens req.url", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    await handler({ method: "GET", url: "/api?__path=/panel", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.payload), /Missed Call Reply/);
  });
});

test("routes correctly when the rewrite preserves req.url", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    // Both the original path and the forwarded copy present - the common case.
    await handler({ method: "GET", url: "/panel?__path=/panel", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.payload), /Missed Call Reply/);
  });
});

test("a signed webhook still verifies when delivered in flattened form", async () => {
  // The regression this guards: Twilio signs the URL *it requested*. If
  // ?__path= were left on req.url, routes.js would sign
  // "<base>/api?__path=/voice/completed" and 403 every webhook.
  await withEnv(validEnv(), async () => {
    const params = { From: "+15550101234", To: "+15559000001", CallStatus: "no-answer" };
    const body = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature({
      url: "https://mctb.example.com/voice/completed",
      params,
      authToken: "tok",
    });

    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/api?__path=/voice/completed",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signature,
        },
        body,
      },
      res,
    );

    assert.notEqual(res.statusCode, 403, "signature must survive path forwarding");
    // An authenticated missed call with no subscriber configured answers with
    // Twiml XML. That the body is XML at all proves the request cleared
    // verification and reached the call-flow handler.
    assert.match(String(res.payload), /<\?xml|<Response>/);
  });
});

test("the forwarded path is normalised before the adapter routes on it", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    // routes.js re-parses req.url with new URL(), so dot segments are
    // normalised downstream regardless. The difference is visible here, where
    // the adapter's own healthz check is a raw string compare: only if
    // resolvePath normalises does the adapter answer this itself, and only its
    // answer carries `runtime: "serverless"`.
    await handler({ method: "GET", url: "/api?__path=/./healthz", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { ok: true, runtime: "serverless" });
  });
});

test("a protocol-relative __path does not become a route", async () => {
  await withEnv(validEnv(), async () => {
    const res = mockRes();
    // Parsing strips the host, leaving "/nope". Worth keeping as a regression
    // guard, though note it is not load-bearing on its own: the raw value
    // "//evil.com/nope" matches no route either, so this passes with or
    // without the parse. The normalisation test above is the one that
    // distinguishes.
    await handler({ method: "GET", url: "/api?__path=//evil.com/nope", headers: {} }, res);
    assert.notEqual(res.statusCode, 200);
    assert.ok(!String(res.payload ?? "").includes("evil.com"));
  });
});

test("a real query string survives alongside the forwarded path", async () => {
  await withEnv({ ...validEnv(), API_KEY: "sekret" }, async () => {
    const res = mockRes();
    await handler(
      {
        method: "PUT",
        url: "/api?__path=/subscribers/%2B15559000001&foo=bar",
        headers: { authorization: "Bearer sekret" },
        body: JSON.stringify({
          enabled: true,
          forwardTo: "+15558000002",
          message: "On a job.",
        }),
      },
      res,
    );
    // The unrelated query param must not disturb path resolution or the body.
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).forwardTo, "+15558000002");
  });
});
