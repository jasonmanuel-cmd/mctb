import crypto from "node:crypto";

/**
 * Google OAuth for a service account, with no dependencies.
 *
 * The Play Developer API needs a bearer token minted from a service account
 * key. That is a signed JWT exchanged at the token endpoint. Doing it by hand
 * keeps the zero-dependency property the rest of the server has; the only
 * subtlety is that the private key arrives inside JSON with literal "\n"
 * escapes, which JSON.parse has already turned into real newlines.
 */

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** base64url, per RFC 7515 - no padding, URL-safe alphabet. */
function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(claims, privateKeyPem) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * @param {object} opts
 * @param {object} opts.serviceAccount  parsed service account JSON
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.now]        milliseconds, injectable for tests
 * @param {number}   [opts.skewSeconds] refresh early by this much
 */
export function createGoogleTokenSource({
  serviceAccount,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  skewSeconds = 60,
} = {}) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error(
      "Service account JSON must include client_email and private_key. " +
        "Download it from Google Cloud → IAM → Service Accounts → Keys.",
    );
  }

  const tokenUri = serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
  let cached = null;

  async function getAccessToken() {
    const nowMs = now();
    if (cached && cached.expiresAtMs - skewSeconds * 1000 > nowMs) return cached.accessToken;

    const iat = Math.floor(nowMs / 1000);
    const assertion = signJwt(
      {
        iss: serviceAccount.client_email,
        scope: SCOPE,
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      },
      serviceAccount.private_key,
    );

    const res = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error("Google token response had no access_token");

    cached = {
      accessToken: data.access_token,
      expiresAtMs: nowMs + (data.expires_in ?? 3600) * 1000,
    };
    return cached.accessToken;
  }

  return { getAccessToken };
}

/** Exposed for tests: the JWT structure is what Google actually validates. */
export function decodeJwtParts(jwt) {
  const [header, body, signature] = jwt.split(".");
  const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return {
    header: JSON.parse(fromB64url(header).toString("utf8")),
    claims: JSON.parse(fromB64url(body).toString("utf8")),
    signatureBytes: fromB64url(signature),
    signingInput: `${header}.${body}`,
  };
}
