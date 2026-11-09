/**
 * TwiML generation.
 *
 * Hand-built rather than pulling in the `twilio` SDK: it is a handful of
 * elements, and doing it here keeps the runtime dependency-free. Every
 * interpolated value is XML-escaped.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Forwards the inbound call to the subscriber's real number and asks Twilio to
 * report the outcome to `actionUrl`.
 *
 * `callerId` must be a number the Twilio account is allowed to present - in
 * practice the Twilio number itself, which is why the caller passes `To`.
 *
 * @param {object} args
 * @param {string} args.forwardTo     subscriber's real phone number, E.164
 * @param {string} args.actionUrl     absolute URL for the post-dial callback
 * @param {number} args.timeoutSeconds ring time before Twilio reports no-answer
 * @param {string} args.callerId      number to present to the subscriber
 */
export function forwardCall({ forwardTo, actionUrl, timeoutSeconds = 25, callerId }) {
  const timeout = Math.min(600, Math.max(5, Number(timeoutSeconds) || 25));
  const attrs = [
    `action="${escapeXml(actionUrl)}"`,
    `method="POST"`,
    `timeout="${timeout}"`,
  ];
  if (callerId) attrs.push(`callerId="${escapeXml(callerId)}"`);

  return [
    XML_DECL,
    "<Response>",
    `<Dial ${attrs.join(" ")}>`,
    `<Number>${escapeXml(forwardTo)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

/** Ends the call. Returned when the subscriber has no forwarding number set. */
export function hangup() {
  return `${XML_DECL}<Response><Hangup/></Response>`;
}

/**
 * Rejects the call without billing a forwarded leg.
 *
 * Note: per Twilio's changelog, rejecting here reports `DialCallStatus` as
 * `completed`, not `no-answer`, so a rejected call will not trigger a reply.
 */
export function reject(reason = "busy") {
  return `${XML_DECL}<Response><Reject reason="${escapeXml(reason)}"/></Response>`;
}

export const TWIML_CONTENT_TYPE = "application/xml; charset=utf-8";
