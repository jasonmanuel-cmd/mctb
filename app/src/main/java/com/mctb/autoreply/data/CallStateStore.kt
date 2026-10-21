package com.mctb.autoreply.data

import android.content.Context
import com.mctb.autoreply.domain.PendingCall
import com.mctb.autoreply.domain.PhoneState

/**
 * Ephemeral call tracking, deliberately kept in `SharedPreferences` rather than
 * DataStore.
 *
 * The caller id is captured by [com.mctb.autoreply.screening.ReplyScreeningService]
 * and consumed later by [com.mctb.autoreply.receiver.PhoneStateReceiver]. Those
 * are two separate component lifecycles and the process can be killed between
 * them, so the value has to be on disk before `onScreenCall` returns - the
 * framework unbinds from a screening service within 5 seconds. `commit()` is
 * used instead of `apply()` for exactly that reason: `apply()` could still be in
 * flight when the process dies.
 *
 * This holds call-transient state only. User settings live in DataStore.
 */
class CallStateStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    /** Called from the screening service, before the phone starts ringing. */
    fun recordIncoming(number: String, nowMs: Long) {
        prefs.edit()
            .putString(KEY_NUMBER, number)
            .putLong(KEY_STARTED_AT, nowMs)
            .commit()
    }

    /** The call currently being tracked, if any. */
    fun readPending(): PendingCall? {
        val number = prefs.getString(KEY_NUMBER, null) ?: return null
        val startedAt = prefs.getLong(KEY_STARTED_AT, 0L)
        if (startedAt <= 0L) return null
        return PendingCall(number = number, startedAtEpochMs = startedAt)
    }

    /**
     * Drops the tracked call. Called both when a call is answered and after a
     * miss has been handled, so one call can never produce two prompts.
     */
    fun clear() {
        prefs.edit()
            .remove(KEY_NUMBER)
            .remove(KEY_STARTED_AT)
            .commit()
    }

    /**
     * Last state seen. Stored rather than held in a static field: a receiver's
     * process can be reclaimed between RINGING and IDLE, and in-memory state
     * would reset to IDLE and silently swallow the miss.
     */
    fun readPreviousState(): PhoneState {
        val raw = prefs.getString(KEY_PREVIOUS_STATE, null)
        return PhoneState.fromExtra(raw) ?: PhoneState.IDLE
    }

    fun writePreviousState(state: PhoneState) {
        prefs.edit().putString(KEY_PREVIOUS_STATE, state.extra).commit()
    }

    private companion object {
        const val FILE_NAME = "call_state"
        const val KEY_NUMBER = "pending_number"
        const val KEY_STARTED_AT = "pending_started_at"
        const val KEY_PREVIOUS_STATE = "previous_state"
    }
}
