import crypto from "node:crypto";

/**
 * Validates Twilio's `X-Twilio-Signature` request signature.
 *
 * Without this, anyone who guesses the webhook URL can forge a "missed call"
 * and make the service send SMS on your account - at your expense. Every
 * Twilio-facing route must call this before acting.
 *
 * Algorithm, per Twilio's spec for form-encoded webhooks:
 *   1. start with the full request URL, including query string
 *   2. sort POST parameters by key, concatenate key + value with no separator
 *   3. append that string to the URL
 *   4. HMAC-SHA1 with the account auth token, base64-encoded
 *   5. compare to the header
 */

/**
 * @param {object} args
 * @param {string} args.url          absolute URL exactly as Twilio called it
 * @param {Record<string,string|number|string[]>} args.params decoded body params
 * @param {string} args.signature    value of the X-Twilio-Signature header
 * @param {string} args.authToken    Twilio account auth token
 * @returns {boolean}
 */
export function validateTwilioSignature({ url, params, signature, authToken }) {
  if (!signature || !authToken) return false;

  const expected = computeTwilioSignature({ url, params, authToken });

  // Constant-time compare; both sides are base64 of a fixed-length digest so
  // lengths normally match, but guard anyway before calling timingSafeEqual.
  const a = Buffer.from(String(signature), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function computeTwilioSignature({ url, params, authToken }) {
  const sorted = Object.keys(params ?? {})
    .sort()
    .map((key) => {
      const value = params[key];
      // Twilio repeats array-valued keys as key=itemN in its own ordering.
      if (Array.isArray(value)) {
        return value
          .slice()
          .sort()
          .map((v) => `${key}${v}`)
          .join("");
      }
      return `${key}${value ?? ""}`;
    })
    .join("");

  return crypto
    .createHmac("sha1", authToken)
    .update(`${url}${sorted}`, "utf8")
    .digest("base64");
}

/**
 * Parses an `application/x-www-form-urlencoded` body.
 *
 * Written by hand rather than with `URLSearchParams` alone because Twilio can
 * repeat a key, and the signature must be computed over the repeated values.
 */
export function parseFormBody(body) {
  const params = {};
  if (!body) return params;

  for (const pair of String(body).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeComponent(rawKey);
    const value = decodeComponent(rawValue);

    if (key in params) {
      params[key] = Array.isArray(params[key]) ? [...params[key], value] : [params[key], value];
    } else {
      params[key] = value;
    }
  }
  return params;
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // Twilio will not send malformed escapes, but a forged request might.
    return value;
  }
}
