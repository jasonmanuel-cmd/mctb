import { parseFormBody } from "./signature.js";
import { decideReply, isMissedCall, isReplyableNumber, digitsOf } from "./policy.js";
import { forwardCall, hangup, TWIML_CONTENT_TYPE } from "./twiml.js";
import { PANEL_HTML } from "./panel.js";

/**
 * Routes and handlers.
 *
 * Split from the HTTP server so handlers can be driven directly in tests as
 * well as over a real socket.
 */

export function createApp({ store, provider, config, logger = console, billing = null }) {
  /** Absolute URL Twilio signed. Behind a proxy this must come from config. */
  function absoluteUrl(req) {
    if (config.publicBaseUrl) return `${config.publicBaseUrl}${req.url}`;
    const proto = req.headers["x-forwarded-proto"] ?? "https";
    return `${proto}://${req.headers.host}${req.url}`;
  }

  function send(res, status, body, headers = {}) {
    const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
    res.writeHead(status, {
      "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  function tooLarge() {
    const err = new Error("payload too large");
    err.status = 413;
    return err;
  }

  async function readBody(req) {
    // Serverless platforms may buffer the request and hand over the body
    // directly. If so, use it: re-reading the stream would yield nothing, and
    // every webhook would then fail signature verification on an empty body -
    // a 403 on every single call.
    if (typeof req.body === "string") {
      if (req.body.length > config.maxBodyBytes) throw tooLarge();
      return req.body;
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > config.maxBodyBytes) throw tooLarge();
      return req.body.toString("utf8");
    }
    if (req.body && typeof req.body === "object") {
      // The platform parsed the body for us. Refuse loudly rather than
      // reconstructing a form string whose byte-for-byte form we cannot
      // guarantee - a wrong reconstruction silently fails signature checks.
      const err = new Error(
        "request body was pre-parsed by the platform; this handler needs the raw body",
      );
      err.status = 500;
      throw err;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > config.maxBodyBytes) throw tooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * Rejects the request unless the carrier actually sent it.
   *
   * Both providers post form-encoded bodies with the same field names, so the
   * parsed params are shared; only how the signature is checked differs.
   */
  function carrierAuthed(req, rawBody) {
    const valid = provider.verifyWebhook({
      url: absoluteUrl(req),
      rawBody,
      headers: req.headers,
    });
    return { valid, params: parseFormBody(rawBody) };
  }

  function bearerAuthed(req) {
    if (!config.apiKey) return false; // settings API disabled entirely
    return bearerToken(req) === config.apiKey;
  }

  function bearerToken(req) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return match?.[1] ?? null;
  }

  /**
   * Works out who is calling: the operator, or one subscriber acting as itself.
   *
   * The operator key configures every number and can never be handed to a
   * customer, so each subscriber also has its own token. That is what the app
   * holds - it authenticates the device and identifies which number it is,
   * which the app otherwise has no way of knowing.
   *
   * Subscribers are matched by scanning, which is O(n) over subscriber count.
   * That is fine at the scale this runs at; past a few thousand it wants an
   * index, the same way all() wanted SMEMBERS instead of KEYS.
   */
  async function resolveActor(req) {
    const token = bearerToken(req);
    if (!token) return null;
    if (config.apiKey && token === config.apiKey) return { kind: "operator" };

    const match = (await store.all()).find((sub) => sub.apiToken && sub.apiToken === token);
    return match ? { kind: "subscriber", subscriber: match } : null;
  }

  return {
    async handle(req, res) {
      const { pathname } = new URL(req.url, "http://localhost");

      try {
        if (req.method === "GET" && pathname === "/healthz") {
          return send(res, 200, { ok: true });
        }

        if (req.method === "POST" && pathname === "/voice") {
          return await handleVoice(req, res);
        }

        if (req.method === "POST" && pathname === "/voice/completed") {
          return await handleVoiceCompleted(req, res);
        }

        if (req.method === "GET" && (pathname === "/panel" || pathname === "/panel/")) {
          return send(res, 200, PANEL_HTML, { "Content-Type": "text/html; charset=utf-8" });
        }

        if (pathname === "/me") {
          return await handleMe(req, res);
        }

        if (req.method === "POST" && pathname === "/billing/verify") {
          return await handleBillingVerify(req, res);
        }

        if (pathname === "/subscribers") {
          return await handleSubscriberList(req, res);
        }

        if (pathname.endsWith("/token") && pathname.startsWith("/subscribers/")) {
          return await handleSubscriberToken(req, res, pathname);
        }

        if (pathname.startsWith("/subscribers/")) {
          return await handleSubscriber(req, res, pathname);
        }

        return send(res, 404, { error: "not_found" });
      } catch (err) {
        logger.error("request failed", { url: req.url, err: err.message });
        return send(res, err.status ?? 500, { error: "internal_error" });
      }
    },

    // exported for direct testing without a socket
    handleVoice: (req, res) => handleVoice(req, res),
    handleBillingVerify: (req, res) => handleBillingVerify(req, res),
    handleVoiceCompleted: (req, res) => handleVoiceCompleted(req, res),
  };

  /**
   * Inbound call to one of our Twilio numbers.
   * Forwards to the subscriber's real phone and asks Twilio to report back.
   */
  async function handleVoice(req, res) {
    const raw = await readBody(req);
    const { valid, params } = carrierAuthed(req, raw);
    if (!valid) {
      logger.warn("rejected unsigned /voice request");
      return send(res, 403, { error: "invalid_signature" });
    }

    const subscriber = await store.byTwilioNumber(params.To);
    if (!subscriber?.enabled || !subscriber.forwardTo) {
      // Not a configured subscriber, or not set up yet. Do not leak which.
      return send(res, 200, hangup(), { "Content-Type": TWIML_CONTENT_TYPE });
    }

    const actionUrl = `${config.publicBaseUrl ?? `${req.headers["x-forwarded-proto"] ?? "https"}://${req.headers.host}`}/voice/completed`;

    return send(
      res,
      200,
      forwardCall({
        forwardTo: subscriber.forwardTo,
        actionUrl,
        timeoutSeconds: Math.min(subscriber.ringSeconds, provider.maxDialTimeout),
        callerId: params.To,
      }),
      { "Content-Type": TWIML_CONTENT_TYPE },
    );
  }

  /**
   * Post-dial callback. This is where a missed call becomes a text.
   *
   * `From` is the original caller, `To` is our Twilio number, and
   * `DialCallStatus` says whether the subscriber picked up.
   */
  async function handleVoiceCompleted(req, res) {
    const raw = await readBody(req);
    const { valid, params } = carrierAuthed(req, raw);
    if (!valid) {
      logger.warn("rejected unsigned /voice/completed request");
      return send(res, 403, { error: "invalid_signature" });
    }

    // All the work happens BEFORE the response is written, on purpose.
    //
    // On a serverless host the invocation is frozen as soon as the response is
    // sent, so anything queued after res.end() may never run - which would mean
    // the text is silently not sent while the logs and the HTTP 200 both say it
    // was. Twilio allows 15s for a webhook response, so doing the send first
    // costs nothing and makes both hosting models behave identically.
    const respond = () => send(res, 200, hangup(), { "Content-Type": TWIML_CONTENT_TYPE });

    const status = params.DialCallStatus;
    if (!isMissedCall(status)) {
      logger.info("call answered or not a miss", { status });
      return respond();
    }

    const subscriber = await store.byTwilioNumber(params.To);
    if (!subscriber) {
      logger.warn("missed call for unknown number", { to: params.To });
      return respond();
    }

    const nowMs = Date.now();
    const decision = decideReply({
      settings: subscriber,
      callerNumber: params.From,
      nowMs,
      lastReplyAtMs: await store.lastReplyAt(params.To, params.From),
    });

    if (!decision.allow) {
      logger.info("reply suppressed", { reason: decision.reason, from: params.From });
      return respond();
    }

    if (!isReplyableNumber(params.From)) {
      logger.warn("caller number not replyable", { from: params.From });
      return respond();
    }

    try {
      const result = await provider.sendSms({
        from: params.To,
        to: params.From,
        body: String(subscriber.message).trim().slice(0, 160),
      });
      await store.recordReply(params.To, params.From, nowMs);
      logger.info("reply sent", { to: params.From, sid: result.sid });
    } catch (err) {
      // Do NOT record the reply on failure: the user must not be charged quota
      // for a text that never went out.
      logger.error("reply failed", { to: params.From, err: err.message, code: err.code });
    }

    return respond();
  }

  /**
   * Settings API for the control panel.
   * PUT  /subscribers/:twilioNumber   create or update
   * GET  /subscribers/:twilioNumber   read
   */
  /**
   * Verifies a Google Play purchase and lifts the free-tier limit.
   *
   * The purchase token is the only credential the app presents, and it is a
   * bearer secret: it can be lifted off a device and replayed. Two defences
   * follow from that. The token is checked against Google rather than
   * trusted, and it is recorded on the subscriber and refused if a different
   * number has already redeemed it - otherwise one purchase would unlock
   * every number on the account.
   *
   * The reuse check runs before the Google call on purpose: a replayed token
   * is the common case, and answering it locally costs no API quota.
   */
  async function handleBillingVerify(req, res) {
    if (!billing) {
      return send(res, 503, { error: "billing_not_configured" });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }

    const purchaseToken =
      typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
    if (!purchaseToken) return send(res, 400, { error: "missing_purchase_token" });

    // A subscriber token carries the number, so the app never has to be told
    // which server-side number it was assigned. The operator key is not
    // scoped, so an operator call must name the number explicitly.
    const actor = await resolveActor(req);
    if (!actor) return send(res, 401, { error: "unauthorized" });

    const twilioNumber =
      actor.kind === "subscriber"
        ? actor.subscriber.twilioNumber
        : digitsOf(body.twilioNumber ?? "");
    if (!twilioNumber) return send(res, 400, { error: "invalid_number" });

    const existing = await store.byTwilioNumber(twilioNumber);
    if (!existing) return send(res, 404, { error: "subscriber_not_found" });

    // Re-verifying the same purchase is idempotent, so a retry after a dropped
    // response cannot strand a paying customer.
    if (existing.unlimited && existing.purchaseToken === purchaseToken) {
      return send(res, 200, { unlocked: true, alreadyVerified: true });
    }

    const claimed = (await store.all()).find(
      (sub) => sub.purchaseToken === purchaseToken && sub.twilioNumber !== twilioNumber,
    );
    if (claimed) return send(res, 409, { error: "purchase_already_redeemed" });

    const result = await billing.verifyPurchase(config.playProductId, purchaseToken);
    if (!result.valid) {
      logger.warn("purchase rejected", { reason: result.reason });
      return send(res, 402, { error: "purchase_not_verified", reason: result.reason });
    }

    await store.upsert(twilioNumber, {
      unlimited: true,
      purchaseToken,
      purchasedAt: Date.now(),
    });

    logger.info("purchase verified", { twilioNumber, orderId: result.orderId ?? null });
    return send(res, 200, { unlocked: true, orderId: result.orderId ?? null });
  }

  /**
   * What a subscriber may change about itself.
   *
   * Deliberately narrower than the operator's sanitize(): `unlimited` and
   * `limit` are absent, because a customer who could set them would not need
   * to buy anything. `apiToken` is absent too, or a stolen token could be
   * rotated to lock the real owner out.
   */
  function sanitizeSelfService(patch) {
    const allowed = {};
    if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
    if (typeof patch.message === "string") allowed.message = patch.message;
    if (typeof patch.timeZone === "string") allowed.timeZone = patch.timeZone;
    if (typeof patch.forwardTo === "string") allowed.forwardTo = patch.forwardTo;
    if (patch.activeHours && typeof patch.activeHours === "object") {
      allowed.activeHours = {};
      if (Number.isInteger(patch.activeHours.startMinuteOfDay)) {
        allowed.activeHours.startMinuteOfDay = patch.activeHours.startMinuteOfDay;
      }
      if (Number.isInteger(patch.activeHours.endMinuteOfDay)) {
        allowed.activeHours.endMinuteOfDay = patch.activeHours.endMinuteOfDay;
      }
      if (typeof patch.activeHours.alwaysOn === "boolean") {
        allowed.activeHours.alwaysOn = patch.activeHours.alwaysOn;
      }
    }
    return allowed;
  }

  /** A subscriber reading and editing its own settings with its own token. */
  async function handleMe(req, res) {
    const actor = await resolveActor(req);
    if (!actor) {
      return send(res, 401, { error: "unauthorized" });
    }
    if (actor.kind !== "subscriber") {
      // The operator key is not scoped to one number, so "me" is meaningless.
      return send(res, 400, { error: "operator_key_not_scoped", hint: "use /subscribers/:number" });
    }

    const number = actor.subscriber.twilioNumber;

    if (req.method === "GET") {
      return send(res, 200, redact(await store.byTwilioNumber(number)));
    }

    if (req.method !== "PATCH" && req.method !== "PUT") {
      return send(res, 405, { error: "method_not_allowed" });
    }

    let patch;
    try {
      patch = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }

    const allowed = sanitizeSelfService(patch);
    if (Object.keys(allowed).length === 0) {
      return send(res, 400, { error: "no_recognised_fields" });
    }

    try {
      const next = await store.upsert(number, allowed);
      return send(res, 200, redact(next));
    } catch (err) {
      return send(res, 400, { error: "invalid_settings", detail: err.message });
    }
  }

  /**
   * Reveals one subscriber's token so the operator can hand it to that
   * customer.
   *
   * A separate endpoint rather than a field on GET /subscribers/:number,
   * because credentials should not ride along in ordinary reads - they end up
   * in shell history, proxy logs and screenshots that way. Operator-only.
   */
  async function handleSubscriberToken(req, res, pathname) {
    if (!bearerAuthed(req)) {
      return send(res, config.apiKey ? 401 : 503, {
        error: config.apiKey ? "unauthorized" : "settings_api_disabled",
      });
    }
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

    const number = digitsOf(
      decodeURIComponent(pathname.slice("/subscribers/".length, -"/token".length)),
    );
    if (!number) return send(res, 400, { error: "invalid_number" });

    const sub = await store.byTwilioNumber(number);
    if (!sub) return send(res, 404, { error: "not_found" });

    return send(res, 200, { twilioNumber: sub.twilioNumber, apiToken: sub.apiToken });
  }

  async function handleSubscriber(req, res, pathname) {
    if (!bearerAuthed(req)) {
      return send(res, config.apiKey ? 401 : 503, {
        error: config.apiKey ? "unauthorized" : "settings_api_disabled",
      });
    }

    const twilioNumber = decodeURIComponent(pathname.slice("/subscribers/".length));
    if (!digitsOf(twilioNumber)) {
      return send(res, 400, { error: "invalid_number" });
    }

    if (req.method === "GET") {
      const sub = await store.byTwilioNumber(twilioNumber);
      return sub ? send(res, 200, redact(sub)) : send(res, 404, { error: "not_found" });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const raw = await readBody(req);
      let patch;
      try {
        patch = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      try {
        const sub = await store.upsert(twilioNumber, sanitize(patch));
        return send(res, 200, redact(sub));
      } catch (err) {
        return send(res, 422, { error: "invalid_settings", detail: err.message });
      }
    }

    return send(res, 405, { error: "method_not_allowed" });
  }

  /** Operator view of every configured number. */
  async function handleSubscriberList(req, res) {
    if (!bearerAuthed(req)) {
      return send(res, config.apiKey ? 401 : 503, {
        error: config.apiKey ? "unauthorized" : "settings_api_disabled",
      });
    }
    return send(res, 200, { subscribers: (await store.all()).map(redact) });
  }

  /** Never hand internal bookkeeping back over the API. */
  function redact(sub) {
    // apiToken is a credential and purchaseToken is a Play receipt; neither
    // belongs in a list response, a log line, or the panel HTML.
    const { lastReply, apiToken, purchaseToken, ...rest } = sub;
    return rest;
  }

  /** Whitelist what the control panel may change. */
  function sanitize(patch) {
    const allowed = {};
    if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
    if (typeof patch.message === "string") allowed.message = patch.message;
    if (typeof patch.timeZone === "string") allowed.timeZone = patch.timeZone;
    if (typeof patch.forwardTo === "string") allowed.forwardTo = patch.forwardTo;
    if (typeof patch.unlimited === "boolean") allowed.unlimited = patch.unlimited;
    if (Number.isInteger(patch.ringSeconds)) allowed.ringSeconds = patch.ringSeconds;
    if (patch.activeHours && typeof patch.activeHours === "object") {
      allowed.activeHours = {};
      if (Number.isInteger(patch.activeHours.startMinuteOfDay)) {
        allowed.activeHours.startMinuteOfDay = patch.activeHours.startMinuteOfDay;
      }
      if (Number.isInteger(patch.activeHours.endMinuteOfDay)) {
        allowed.activeHours.endMinuteOfDay = patch.activeHours.endMinuteOfDay;
      }
      if (typeof patch.activeHours.alwaysOn === "boolean") {
        allowed.activeHours.alwaysOn = patch.activeHours.alwaysOn;
      }
    }
    return allowed;
  }
}
