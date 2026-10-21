import crypto from "node:crypto";

/**
 * Telnyx provider.
 *
 * Telnyx's TeXML is deliberately Twilio-TwiML-compatible: the webhook body is
 * form-encoded with the same field names (From, To, CallSid, DialCallStatus)
 * and the same status values (completed, busy, no-answer, canceled, failed).
 * So the call-flow logic is shared; only two things genuinely differ:
 *
 *   1. Webhook signatures are Ed25519 over `${timestamp}|${raw body}`, verified
 *      with an account PUBLIC key - not an HMAC over a shared secret.
 *   2. The Messaging API is JSON with a Bearer token, and the field is `text`.
 *
 * Still zero dependencies: Node has Ed25519 built in.
 */

const TELNYX_API = "https://api.telnyx.com/v2";

/** Reject signatures older than this, so a captured request cannot be replayed. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * RFC 8410 SPKI prefix for Ed25519. Telnyx hands out the raw 32-byte key,
 * which Node's crypto will not accept until it is wrapped in this envelope.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function toKeyObject(publicKey) {
  const text = String(publicKey).trim();

  if (text.startsWith("-----BEGIN")) {
    return crypto.createPublicKey(text);
  }

  const raw = Buffer.from(text, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `TELNYX_PUBLIC_KEY must be a 32-byte Ed25519 key (or a PEM); decoded ${raw.length} bytes`,
    );
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * @param {object} args
 * @param {string} args.rawBody    exact bytes received - never re-serialised
 * @param {string} args.signature  telnyx-signature-ed25519 header
 * @param {string} args.timestamp  telnyx-timestamp header
 * @param {string} args.publicKey  account public key, base64 or PEM
 * @param {number} [args.nowMs]
 */
export function verifyTelnyxSignature({ rawBody, signature, timestamp, publicKey, nowMs = Date.now() }) {
  if (!rawBody || !signature || !timestamp || !publicKey) return false;

  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) return false;

  // Replay guard. Telnyx's own SDK default is 300s.
  if (Math.abs(nowMs - signedAt * 1000) > REPLAY_WINDOW_MS) return false;

  let sigBytes;
  try {
    sigBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  // Ed25519 signatures are exactly 64 bytes. Node's crypto rejects other
  // lengths too; this is explicit rather than relying on library internals.
  if (sigBytes.length !== 64) return false;

  try {
    const key = toKeyObject(publicKey);
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), Buffer.from(rawBody, "utf8")]);
    return crypto.verify(null, signed, key, sigBytes);
  } catch {
    // A malformed key must reject, not crash the request.
    return false;
  }
}

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {(input: string, init: object) => Promise<Response>} [args.fetchImpl]
 */
export function createTelnyxSmsClient({ apiKey, fetchImpl = fetch }) {
  async function send({ from, to, body }) {
    const res = await fetchImpl(`${TELNYX_API}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Telnyx calls the message field `text`, not `Body`.
      body: JSON.stringify({ from, to, text: body }),
    });

    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = payload.errors?.[0];
      const err = new Error(
        `Telnyx Messaging API returned ${res.status}: ${detail?.detail ?? detail?.title ?? "unknown error"}`,
      );
      err.status = res.status;
      err.code = detail?.code;
      throw err;
    }

    return { sid: payload.data?.id, status: payload.data?.status ?? "queued" };
  }

  return { send };
}
