package com.mctb.autoreply.billing

import android.app.Activity
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the upgrade screen should show right now. */
sealed interface UnlockOffer {
    /** Still connecting; show a spinner rather than an error. */
    data object Loading : UnlockOffer

    /** Already bought. Includes purchases restored from another device. */
    data object Owned : UnlockOffer

    /** Ready to buy, with a localised price if Play returned one. */
    data class Purchasable(val productDetails: ProductDetails, val formattedPrice: String?) :
        UnlockOffer

    /**
     * The product could not be resolved - typically because it has not been
     * created in Play Console yet, or the build is not from a track Play
     * recognises. The app must stay usable in this state.
     */
    data class Unavailable(val reason: String) : UnlockOffer
}

/**
 * Play Billing for the one-time "unlimited replies" unlock.
 *
 * Written against Play Billing Library 8.x, where `queryProductDetailsAsync`
 * returns a `QueryProductDetailsResult` (fetched + unfetched lists) rather than
 * the bare `List<ProductDetails>` used in 7.x.
 *
 * IMPORTANT - this is the one component that could not be exercised in the
 * environment it was written in. Billing only resolves real products for a build
 * installed from a Play track against an app that has [PRODUCT_ID_UNLIMITED]
 * published in Play Console. Until then [UnlockOffer.Unavailable] is the
 * expected state, and by design that never blocks the free tier.
 *
 * Security note: purchases are verified only as "signed by Play and
 * acknowledged" on-device, which proves nothing to anyone else - a purchase
 * token can be lifted off a rooted device and replayed.
 *
 * The server now has the authoritative check (`POST /billing/verify`, which
 * asks the Play Developer API whether the token is real and still purchased
 * before lifting the limit). This class does not call it yet: that needs a
 * configured server base URL, which is not plumbed through preferences. Until
 * it is, an unlock applies on this device only and does not lift the limit for
 * server-mode replies.
 */
class BillingManager(
    private val activity: Activity
) : PurchasesUpdatedListener {

    private val _offer = MutableStateFlow<UnlockOffer>(UnlockOffer.Loading)
    val offer: StateFlow<UnlockOffer> = _offer.asStateFlow()

    private var cachedDetails: ProductDetails? = null

    private val billingClient: BillingClient = BillingClient.newBuilder(activity)
        .setListener(this)
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder()
                .enableOneTimeProducts()
                .build()
        )
        .build()

    /** Connects, then loads both any existing entitlement and the product offer. */
    fun start() {
        billingClient.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    restoreExistingPurchase()
                    queryOffer()
                } else {
                    _offer.value = UnlockOffer.Unavailable(billingResult.debugMessage)
                    Log.w(TAG, "Billing setup failed: ${billingResult.debugMessage}")
                }
            }

            override fun onBillingServiceDisconnected() {
                // Play will let us retry on the next interaction; don't spin here.
                Log.i(TAG, "Billing service disconnected")
            }
        })
    }

    /** Re-reads entitlement, e.g. after returning from a purchase flow. */
    fun restoreExistingPurchase() {
        val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP)
            .build()

        billingClient.queryPurchasesAsync(params) { billingResult, purchases ->
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                Log.w(TAG, "queryPurchases failed: ${billingResult.debugMessage}")
                return@queryPurchasesAsync
            }
            val owned = purchases.firstOrNull { it.isEntitlementForUnlock() }
            if (owned != null) {
                acknowledgeIfNeeded(owned)
                _offer.value = UnlockOffer.Owned
            }
        }
    }

    private fun queryOffer() {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(PRODUCT_ID_UNLIMITED)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                )
            )
            .build()

        billingClient.queryProductDetailsAsync(params) { billingResult, result ->
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                _offer.value = UnlockOffer.Unavailable(billingResult.debugMessage)
                return@queryProductDetailsAsync
            }

            val details = result.productDetailsList.firstOrNull()
            if (details == null) {
                val unfetched = result.unfetchedProductList.firstOrNull()
                _offer.value = UnlockOffer.Unavailable(
                    unfetched?.let { "${it.productId}: status ${it.statusCode}" }
                        ?: "Product not published"
                )
                return@queryProductDetailsAsync
            }

            val offer = details.oneTimePurchaseOfferDetailsList?.firstOrNull()
            if (offer == null) {
                // Fetched, but nothing this user can actually buy - showing a
                // buy button here would fail the moment it was tapped.
                _offer.value = UnlockOffer.Unavailable("No offers available to this user")
                return@queryProductDetailsAsync
            }

            cachedDetails = details
            // Don't overwrite an already-known entitlement with a buy button.
            if (_offer.value !is UnlockOffer.Owned) {
                _offer.value = UnlockOffer.Purchasable(
                    productDetails = details,
                    formattedPrice = offer.formattedPrice
                )
            }
        }
    }

    /** Launches the system purchase sheet. Result arrives in [onPurchasesUpdated]. */
    fun launchPurchase() {
        val details = cachedDetails
        if (details == null) {
            Log.w(TAG, "Cannot purchase before the product has loaded")
            return
        }

        // Play Billing 8 models one-time products as purchase options, so the
        // flow needs an offer token taken from the offer list, not the product
        // alone. Leaving it off still compiles - the failure only appears when
        // someone actually taps buy, which is the worst place to find it.
        val offer = details.oneTimePurchaseOfferDetailsList?.firstOrNull()
        if (offer == null) {
            _offer.value = UnlockOffer.Unavailable("No purchasable offer available")
            Log.w(TAG, "No one-time purchase offers returned for $PRODUCT_ID_UNLIMITED")
            return
        }

        val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .setOfferToken(offer.offerToken)
            .build()

        val flowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productParams))
            .build()

        val result = billingClient.launchBillingFlow(activity, flowParams)
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            Log.w(TAG, "launchBillingFlow failed: ${result.debugMessage}")
        }
    }

    override fun onPurchasesUpdated(billingResult: BillingResult, purchases: List<Purchase>?) {
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val purchased = purchases?.firstOrNull { it.isEntitlementForUnlock() }
                if (purchased != null) {
                    acknowledgeIfNeeded(purchased)
                    _offer.value = UnlockOffer.Owned
                }
            }

            BillingClient.BillingResponseCode.USER_CANCELED ->
                Log.i(TAG, "Purchase cancelled by user")

            else -> Log.w(TAG, "Purchase failed: ${billingResult.debugMessage}")
        }
    }

    /**
     * Unacknowledged purchases are automatically refunded after 3 days, so this
     * is not optional.
     */
    private fun acknowledgeIfNeeded(purchase: Purchase) {
        if (purchase.isAcknowledged) return
        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
        billingClient.acknowledgePurchase(params) { billingResult ->
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                Log.e(TAG, "Acknowledge failed: ${billingResult.debugMessage}")
            }
        }
    }

    private fun Purchase.isEntitlementForUnlock(): Boolean =
        purchaseState == Purchase.PurchaseState.PURCHASED &&
            products.contains(PRODUCT_ID_UNLIMITED)

    fun release() {
        if (billingClient.isReady) billingClient.endConnection()
    }

    companion object {
        /** Must match an in-app product id created in Play Console. */
        const val PRODUCT_ID_UNLIMITED = "unlimited_replies"

        private const val TAG = "BillingManager"
    }
}
