import crypto from "node:crypto";
import { computeTwilioSignature, parseFormBody } from "./signature.js";
import { verifyTelnyxSignature, createTelnyxSmsClient } from "./telnyx.js";
import { createSmsClient } from "./sms.js";

/**
 * Provider abstraction.
 *
 * Everything above this line is provider-agnostic: the missed-call policy, the
 * gating order, the store, the panel. Only signature verification and the SMS
 * call differ between carriers, so those are the only two things behind this
 * seam.
 *
 * Both providers receive form-encoded webhooks with the same field names
 * (From, To, CallSid, DialCallStatus) and the same status values, because
 * Telnyx's TeXML is deliberately TwiML-compatible. That is what makes the
 * shared call-flow logic safe to share.
 */

/** Twilio allows a 600s ring timeout; Telnyx's TeXML caps it at 120s. */
const MAX_DIAL_TIMEOUT = { twilio: 600, telnyx: 120 };

export function createProvider(config, { fetchImpl = fetch } = {}) {
  switch (config.provider) {
    case "telnyx":
      return {
        name: "telnyx",
        maxDialTimeout: MAX_DIAL_TIMEOUT.telnyx,
        verifyWebhook({ rawBody, headers }) {
          return verifyTelnyxSignature({
            rawBody,
            signature: headers["telnyx-signature-ed25519"],
            timestamp: headers["telnyx-timestamp"],
            publicKey: config.telnyxPublicKey,
          });
        },
        sendSms: createTelnyxSmsClient({ apiKey: config.telnyxApiKey, fetchImpl }).send,
      };

    case "twilio":
      return {
        name: "twilio",
        maxDialTimeout: MAX_DIAL_TIMEOUT.twilio,
        verifyWebhook({ url, rawBody, headers }) {
          // Twilio signs the full URL it called plus the sorted, decoded
          // parameters - so the origin cannot be guessed from the Host header
          // behind a proxy.
          const expected = computeTwilioSignature({
            url,
            params: parseFormBody(rawBody),
            authToken: config.twilioAuthToken,
          });
          const given = headers["x-twilio-signature"];
          if (!given) return false;

          const a = Buffer.from(String(given), "utf8");
          const b = Buffer.from(expected, "utf8");
          if (a.length !== b.length) return false;
          return crypto.timingSafeEqual(a, b);
        },
        sendSms: createSmsClient({
          accountSid: config.twilioAccountSid,
          authToken: config.twilioAuthToken,
          fetchImpl,
        }).send,
      };

    default:
      throw new Error(`Unknown provider: ${config.provider}. Use "twilio" or "telnyx".`);
  }
}
