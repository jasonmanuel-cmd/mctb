package com.mctb.autoreply.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebounceLedgerTest {

    private val window = 30 * 60 * 1000L
    private val now = 10_000_000L

    @Test
    fun `an unknown number may be sent to`() {
        assertTrue(DebounceLedger.canSend(null, "+15550101234", now, window))
        assertTrue(DebounceLedger.canSend("", "+15550101234", now, window))
    }

    @Test
    fun `the same number is blocked inside the window`() {
        val ledger = DebounceLedger.record(null, "+15550101234", now, window)
        assertFalse(DebounceLedger.canSend(ledger, "+15550101234", now + 1_000, window))
    }

    @Test
    fun `the same number is allowed again after the window`() {
        val ledger = DebounceLedger.record(null, "+15550101234", now, window)
        assertTrue(DebounceLedger.canSend(ledger, "+15550101234", now + window + 1, window))
    }

    @Test
    fun `formatting differences do not defeat the cooldown`() {
        val ledger = DebounceLedger.record(null, "+1 (555) 010-1234", now, window)
        assertFalse(DebounceLedger.canSend(ledger, "15550101234", now, window))
        assertFalse(DebounceLedger.canSend(ledger, "+1-555-010-1234", now, window))
    }

    @Test
    fun `recording prunes expired entries so the ledger stays bounded`() {
        var ledger = DebounceLedger.record(null, "15550000001", now - (window * 3), window)
        ledger = DebounceLedger.record(ledger, "15550000002", now - (window * 2), window)
        ledger = DebounceLedger.record(ledger, "15550000003", now, window)

        val entries = DebounceLedger.parse(ledger)
        assertEquals(setOf("15550000003"), entries.keys)
    }

    @Test
    fun `round trips through parse and encode`() {
        val original = mapOf("15550101234" to now, "447700900123" to now - 1_000)
        assertEquals(original, DebounceLedger.parse(DebounceLedger.encode(original)))
    }

    @Test
    fun `malformed input is ignored rather than throwing`() {
        assertEquals(emptyMap<String, Long>(), DebounceLedger.parse("garbage"))
        assertEquals(emptyMap<String, Long>(), DebounceLedger.parse("1234:notanumber"))
        assertEquals(emptyMap<String, Long>(), DebounceLedger.parse(":12345"))
        // One good entry survives a bad neighbour.
        assertEquals(mapOf("15550101234" to now), DebounceLedger.parse("junk,15550101234:$now"))
    }

    @Test
    fun `a blank number never records an entry`() {
        val ledger = DebounceLedger.record(null, "", now, window)
        assertEquals(emptyMap<String, Long>(), DebounceLedger.parse(ledger))
    }
}
