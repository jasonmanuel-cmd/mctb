package com.mctb.autoreply.screening

import android.telecom.Call
import android.telecom.CallScreeningService
import android.telecom.PhoneAccount
import android.util.Log
import com.mctb.autoreply.data.CallStateStore
import com.mctb.autoreply.domain.PhoneNumberValidator

/**
 * Captures who is calling, before the phone rings.
 *
 * This is what makes the app publishable. `ROLE_CALL_SCREENING` is granted by
 * the user through a system dialog and is not part of the restricted SMS / Call
 * Log permission groups, so it needs no Play declaration form. Android's own
 * documentation states that this API "eliminates the requirement to obtain the
 * READ_CALL_LOG permission in order to provide call screening and caller ID
 * functionality".
 *
 * Known, accepted limitation: the framework only passes calls from numbers that
 * are **not** in the user's contacts (unless the app also holds READ_CONTACTS).
 * For this product that is the right trade - unknown numbers are new leads,
 * which is exactly the case worth catching, and saved contacts already have a
 * way to reach you. READ_CONTACTS is deliberately not requested.
 *
 * Requires API 29+: below that, only the default dialer's screening service is
 * bound. `minSdk` is 29 to match.
 */
class ReplyScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        try {
            if (callDetails.callDirection == Call.Details.DIRECTION_INCOMING) {
                recordIncoming(callDetails)
            }
        } catch (throwable: Throwable) {
            // Never let screening logic break the user's incoming call.
            Log.e(TAG, "Failed to record incoming call", throwable)
        } finally {
            // Must happen within 5 seconds or the framework unbinds and ignores
            // us. An empty CallResponse means "allow the call, change nothing".
            respondToCall(callDetails, CallResponse.Builder().build())
        }
    }

    private fun recordIncoming(callDetails: Call.Details) {
        val handle: android.net.Uri? = callDetails.handle ?: return
        if (handle.scheme != PhoneAccount.SCHEME_TEL) return

        val rawNumber = handle.schemeSpecificPart
        if (!PhoneNumberValidator.isReplyable(rawNumber)) {
            Log.d(TAG, "Skipping non-replyable caller id")
            return
        }

        CallStateStore(this).recordIncoming(
            number = PhoneNumberValidator.normalize(rawNumber),
            nowMs = System.currentTimeMillis()
        )
        Log.i(TAG, "Recorded incoming call for reply tracking")
    }

    private companion object {
        const val TAG = "ReplyScreening"
    }
}
