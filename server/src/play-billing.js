/**
 * Server-side verification of a Google Play in-app purchase.
 *
 * The Android app can only prove that Play *showed* a purchase sheet and
 * returned a signed receipt. That receipt is trivially replayable: anyone can
 * lift a valid purchase token out of a rooted device and post it again. The
 * authoritative answer comes from the Play Developer API, which knows whether
 * the token is real, still purchased, and for the product we think it is.
 *
 * This matters here specifically because the server is what sends the replies.
 * An unlock that only ever flipped a flag on the phone would unlock nothing.
 */

const ANDROID_PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3";

/** Google's purchaseState values for a one-time product. */
export const PURCHASE_STATE = {
  PURCHASED: 0,
  CANCELED: 1,
  PENDING: 2,
};

/**
 * @param {object} opts
 * @param {string} opts.packageName       the Android application id
 * @param {Function} opts.getAccessToken  from createGoogleTokenSource
 * @param {Function} [opts.fetchImpl]
 * @param {string} [opts.baseUrl]         injectable for tests
 */
export function createPlayBillingClient({
  packageName,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  baseUrl = ANDROID_PUBLISHER,
} = {}) {
  if (!packageName) throw new Error("packageName is required to verify Play purchases");

  /**
   * @param {string} productId
   * @param {string} purchaseToken
   * @returns {Promise<{valid: boolean, reason: string, orderId?: string, purchaseState?: number}>}
   */
  async function verifyPurchase(productId, purchaseToken) {
    if (!productId) return { valid: false, reason: "missing_product_id" };
    if (!purchaseToken) return { valid: false, reason: "missing_purchase_token" };

    // Both values land in a URL path, so they must be encoded. A token can
    // contain characters that are meaningful in a path otherwise.
    const url =
      `${baseUrl}/applications/${encodeURIComponent(packageName)}` +
      `/purchases/products/${encodeURIComponent(productId)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}`;

    const token = await getAccessToken();
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    // Google answers 404 for a token it has never heard of, which is the
    // single most likely forged-receipt case.
    if (res.status === 404) return { valid: false, reason: "token_not_found" };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { valid: false, reason: `play_api_${res.status}`, detail: text.slice(0, 200) };
    }

    const data = await res.json();

    if (data.purchaseState !== PURCHASE_STATE.PURCHASED) {
      return {
        valid: false,
        reason: data.purchaseState === PURCHASE_STATE.PENDING ? "purchase_pending" : "not_purchased",
        purchaseState: data.purchaseState,
      };
    }

    return {
      valid: true,
      reason: "ok",
      orderId: data.orderId,
      purchaseState: data.purchaseState,
      acknowledgementState: data.acknowledgementState,
    };
  }

  return { verifyPurchase };
}
