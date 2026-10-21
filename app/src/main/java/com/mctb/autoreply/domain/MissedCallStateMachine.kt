package com.mctb.autoreply.domain

/**
 * The three call states the framework reports through
 * `TelephonyManager.EXTRA_STATE`.
 */
enum class PhoneState(val extra: String) {
    IDLE("IDLE"),
    RINGING("RINGING"),
    OFFHOOK("OFFHOOK");

    companion object {
        fun fromExtra(value: String?): PhoneState? =
            entries.firstOrNull { it.extra.equals(value?.trim(), ignoreCase = true) }
    }
}

/**
 * An incoming call that [com.mctb.autoreply.screening.ReplyScreeningService] saw
 * before it started ringing, and whose outcome we have not observed yet.
 */
data class PendingCall(val number: String, val startedAtEpochMs: Long)

/** What a phone-state transition implies for the pending call. */
sealed interface CallOutcome {
    /** Nothing actionable; keep tracking. */
    data object Nothing : CallOutcome

    /** The call was picked up. The pending call should be discarded. */
    data object Answered : CallOutcome

    /** The call rang out unanswered and we know who it was from. */
    data class Missed(val number: String) : CallOutcome

    /**
     * We can tell a call went unanswered but never learned the number, so there
     * is nobody to reply to. Surfaced separately so the UI can explain it.
     */
    data object MissedUnknownCaller : CallOutcome
}

/**
 * Turns a stream of `RINGING` / `OFFHOOK` / `IDLE` transitions into missed-call
 * events.
 *
 * The caller id is *not* read from the phone-state broadcast: that extra is only
 * populated for apps holding `READ_CALL_LOG`, which Google Play restricts to
 * default SMS/Phone/Assistant handlers. It comes instead from
 * [com.mctb.autoreply.screening.ReplyScreeningService], which is allowed to see
 * it via `ROLE_CALL_SCREENING`. This class only decides *when* the call ended
 * unanswered.
 *
 * Pure Kotlin so the transition table can be unit tested on the JVM.
 */
object MissedCallStateMachine {

    /**
     * @param previous state observed on the last transition
     * @param current  state reported by the broadcast we are handling now
     * @param pending  caller id captured before the phone rang, if any
     * @param nowMs    current time, used to discard stale pending calls
     * @param maxPendingAgeMs pending calls older than this are treated as leftovers
     *   from an earlier call (for example if the process died mid-call)
     */
    fun evaluate(
        previous: PhoneState,
        current: PhoneState,
        pending: PendingCall?,
        nowMs: Long,
        maxPendingAgeMs: Long
    ): CallOutcome = when (current) {
        PhoneState.OFFHOOK -> CallOutcome.Answered

        PhoneState.RINGING -> CallOutcome.Nothing

        PhoneState.IDLE -> {
            val rangOut = previous == PhoneState.RINGING
            val fresh = pending != null &&
                (nowMs - pending.startedAtEpochMs) in 0..maxPendingAgeMs

            when {
                !rangOut -> CallOutcome.Nothing
                pending == null || !fresh -> CallOutcome.Nothing
                pending.number.isBlank() -> CallOutcome.MissedUnknownCaller
                else -> CallOutcome.Missed(pending.number)
            }
        }
    }
}
