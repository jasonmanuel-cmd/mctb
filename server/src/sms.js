/**
 * Twilio Messages API client.
 *
 * Uses the built-in fetch rather than the `twilio` SDK so the runtime stays
 * dependency-free. Basic auth with the account SID as user and the auth token
 * as password.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/**
 * @param {object} args
 * @param {string} args.accountSid
 * @param {string} args.authToken
 * @param {string} args.from  Twilio number the message is sent from
 * @param {string} args.to    caller's number, E.164
 * @param {string} args.body
 * @param {(input: string, init: object) => Promise<Response>} [args.fetchImpl]
 *   injectable so tests never touch the network
 */
export function createSmsClient({ accountSid, authToken, fetchImpl = fetch }) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  async function send({ from, to, body }) {
    const url = `${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    });

    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(
        `Twilio Messages API returned ${res.status}: ${payload.message ?? "unknown error"}`,
      );
      err.status = res.status;
      err.code = payload.code;
      throw err;
    }

    return { sid: payload.sid, status: payload.status };
  }

  return { send };
}
