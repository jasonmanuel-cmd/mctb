package com.mctb.autoreply.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MissedCallStateMachineTest {

    private val now = 1_000_000L
    private val maxAge = 5 * 60 * 1000L
    private val pending = PendingCall("+15550101234", startedAtEpochMs = now - 10_000)

    private fun evaluate(previous: PhoneState, current: PhoneState, p: PendingCall? = pending) =
        MissedCallStateMachine.evaluate(previous, current, p, now, maxAge)

    @Test
    fun `ringing to idle with a known caller is a miss`() {
        val outcome = evaluate(PhoneState.RINGING, PhoneState.IDLE)
        assertTrue(outcome is CallOutcome.Missed)
        assertEquals("+15550101234", (outcome as CallOutcome.Missed).number)
    }

    @Test
    fun `answering the call suppresses the miss`() {
        assertTrue(evaluate(PhoneState.RINGING, PhoneState.OFFHOOK) is CallOutcome.Answered)
        // The call then ends normally; that is not a miss.
        assertTrue(evaluate(PhoneState.OFFHOOK, PhoneState.IDLE) is CallOutcome.Nothing)
    }

    @Test
    fun `idle to idle is nothing`() {
        assertTrue(evaluate(PhoneState.IDLE, PhoneState.IDLE) is CallOutcome.Nothing)
    }

    @Test
    fun `ringing alone is nothing`() {
        assertTrue(evaluate(PhoneState.IDLE, PhoneState.RINGING) is CallOutcome.Nothing)
    }

    @Test
    fun `idle after ringing with no pending call is nothing`() {
        // Nothing was screened - e.g. the user revoked the role mid-session.
        assertTrue(evaluate(PhoneState.RINGING, PhoneState.IDLE, p = null) is CallOutcome.Nothing)
    }

    @Test
    fun `a withheld caller surfaces separately`() {
        val outcome = evaluate(
            PhoneState.RINGING,
            PhoneState.IDLE,
            p = PendingCall("", startedAtEpochMs = now - 10_000)
        )
        assertTrue(outcome is CallOutcome.MissedUnknownCaller)
    }

    @Test
    fun `a stale pending call from an earlier session is ignored`() {
        val stale = PendingCall("+15550101234", startedAtEpochMs = now - (maxAge + 60_000))
        assertTrue(
            evaluate(PhoneState.RINGING, PhoneState.IDLE, p = stale) is CallOutcome.Nothing
        )
    }

    @Test
    fun `a pending call timestamped in the future is ignored`() {
        val future = PendingCall("+15550101234", startedAtEpochMs = now + 60_000)
        assertTrue(
            evaluate(PhoneState.RINGING, PhoneState.IDLE, p = future) is CallOutcome.Nothing
        )
    }

    @Test
    fun `extra state strings map to phone states`() {
        assertEquals(PhoneState.RINGING, PhoneState.fromExtra("RINGING"))
        assertEquals(PhoneState.OFFHOOK, PhoneState.fromExtra("OFFHOOK"))
        assertEquals(PhoneState.IDLE, PhoneState.fromExtra("IDLE"))
        assertEquals(PhoneState.IDLE, PhoneState.fromExtra(" idle "))
        assertEquals(null, PhoneState.fromExtra("GARBAGE"))
        assertEquals(null, PhoneState.fromExtra(null))
    }
}
