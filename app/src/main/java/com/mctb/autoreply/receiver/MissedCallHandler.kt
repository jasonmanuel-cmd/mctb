package com.mctb.autoreply.receiver

import android.content.Context
import android.util.Log
import com.mctb.autoreply.data.AppPreferences
import com.mctb.autoreply.data.CallStateStore
import com.mctb.autoreply.domain.CallOutcome
import com.mctb.autoreply.domain.DebounceLedger
import com.mctb.autoreply.domain.MissedCallStateMachine
import com.mctb.autoreply.domain.PhoneNumberValidator
import com.mctb.autoreply.domain.PhoneState
import com.mctb.autoreply.notify.MissedCallNotifier

/**
 * Decides what to do about a phone-state transition.
 *
 * Kept separate from [PhoneStateReceiver] so the decision logic has no
 * `BroadcastReceiver` in it and can be reasoned about on its own.
 */
object MissedCallHandler {

    /**
     * Anything tracked for longer than this is stale - a leftover from a call
     * whose broadcasts we never saw, typically because the process was reclaimed
     * mid-call. Ignoring it prevents replying to a number from hours ago.
     */
    private const val MAX_PENDING_AGE_MS = 5 * 60 * 1000L

    suspend fun handle(context: Context, current: PhoneState) {
        val store = CallStateStore(context)
        val previous = store.readPreviousState()
        val pending = store.readPending()
        val nowMs = System.currentTimeMillis()

        val outcome = MissedCallStateMachine.evaluate(
            previous = previous,
            current = current,
            pending = pending,
            nowMs = nowMs,
            maxPendingAgeMs = MAX_PENDING_AGE_MS
        )

        when (outcome) {
            is CallOutcome.Answered -> {
                store.clear()
                Log.d(TAG, "Call answered; tracking reset")
            }

            is CallOutcome.Missed -> {
                store.clear()
                promptForReply(context, outcome.number, nowMs)
            }

            is CallOutcome.MissedUnknownCaller -> {
                store.clear()
                Log.i(TAG, "Missed call from a withheld number; nothing to reply to")
            }

            is CallOutcome.Nothing -> Unit
        }

        store.writePreviousState(current)
    }

    private suspend fun promptForReply(context: Context, rawNumber: String, nowMs: Long) {
        if (!PhoneNumberValidator.isReplyable(rawNumber)) {
            Log.d(TAG, "Caller id is not replyable")
            return
        }

        val prefs = AppPreferences(context)
        val settings = prefs.readSettings()

        if (!settings.enabled) {
            Log.d(TAG, "Auto-reply is off")
            return
        }

        val message = settings.message.trim()
        if (message.isEmpty()) {
            Log.w(TAG, "Reply message is empty")
            return
        }

        if (!settings.activeHours.isActiveAt(prefs.currentMinuteOfDay())) {
            Log.d(TAG, "Outside active hours")
            return
        }

        val quotaExhausted = !settings.isUnlimited &&
            settings.replyCount >= AppPreferences.FREE_TIER_LIMIT
        if (quotaExhausted) {
            Log.i(TAG, "Free tier exhausted; prompt suppressed")
            return
        }

        if (!DebounceLedger.canSend(
                encoded = settings.debounceLedger,
                number = rawNumber,
                nowMs = nowMs,
                windowMs = AppPreferences.DEBOUNCE_WINDOW_MS
            )
        ) {
            Log.d(TAG, "Inside cooldown for this number")
            return
        }

        val number = PhoneNumberValidator.normalize(rawNumber)
        MissedCallNotifier(context).notifyMissedCall(
            number = number,
            message = message,
            requestCode = number.hashCode()
        )
        Log.i(TAG, "Reply prompt posted")
    }

    private const val TAG = "MissedCallHandler"
}
