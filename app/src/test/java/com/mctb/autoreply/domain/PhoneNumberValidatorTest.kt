package com.mctb.autoreply.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the exact regression the previous implementation shipped: it treated
 * placeholder tokens as *substrings*, so any real number containing a zero was
 * rejected as invalid.
 */
class PhoneNumberValidatorTest {

    @Test
    fun `real international numbers are replyable`() {
        assertTrue(PhoneNumberValidator.isReplyable("+1 (212) 555-0134"))
        assertTrue(PhoneNumberValidator.isReplyable("+44 7700 900123"))
        assertTrue(PhoneNumberValidator.isReplyable("0412 345 678"))
        assertTrue(PhoneNumberValidator.isReplyable("15550101234"))
    }

    @Test
    fun `numbers containing a zero are not rejected`() {
        // The old `contains("0")` check failed every one of these.
        assertTrue(PhoneNumberValidator.isReplyable("+15550101234"))
        assertTrue(PhoneNumberValidator.isReplyable("555-0100"))
        assertTrue(PhoneNumberValidator.isReplyable("+442070001234"))
    }

    @Test
    fun `numbers containing a dash-one are not rejected`() {
        assertTrue(PhoneNumberValidator.isReplyable("+1-212-555-1234"))
        assertTrue(PhoneNumberValidator.isReplyable("(555) 123-1234"))
    }

    @Test
    fun `carrier placeholders are rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable("UNKNOWN"))
        assertFalse(PhoneNumberValidator.isReplyable("private"))
        assertFalse(PhoneNumberValidator.isReplyable("Anonymous"))
        assertFalse(PhoneNumberValidator.isReplyable("BLOCKED"))
        assertFalse(PhoneNumberValidator.isReplyable("Restricted"))
        assertFalse(PhoneNumberValidator.isReplyable("WITHHELD"))
        assertFalse(PhoneNumberValidator.isReplyable("-1"))
        assertFalse(PhoneNumberValidator.isReplyable("-2"))
        assertFalse(PhoneNumberValidator.isReplyable("0"))
    }

    @Test
    fun `blank and null are rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable(null))
        assertFalse(PhoneNumberValidator.isReplyable(""))
        assertFalse(PhoneNumberValidator.isReplyable("   "))
    }

    @Test
    fun `empty input is rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable(""))
    }

    @Test
    fun `all-zero payloads are rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable("0000000"))
        assertFalse(PhoneNumberValidator.isReplyable("+0000000"))
    }

    @Test
    fun `short codes are rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable("911"))
        assertFalse(PhoneNumberValidator.isReplyable("611"))
        assertFalse(PhoneNumberValidator.isReplyable("12345"))
    }

    @Test
    fun `overlong strings are rejected`() {
        assertFalse(PhoneNumberValidator.isReplyable("1".repeat(16)))
    }

    @Test
    fun `normalize strips formatting but keeps the plus`() {
        assertEquals("+12125550134", PhoneNumberValidator.normalize("+1 (212) 555-0134"))
        assertEquals("", PhoneNumberValidator.normalize(null))
    }
}
