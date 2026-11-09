package com.mctb.autoreply.domain

/**
 * Decides whether a captured caller id is something we could sensibly text back.
 *
 * Pure Kotlin (no android.* imports) so it can be unit tested on the JVM.
 *
 * Design note: this intentionally errs towards accepting a number. A false
 * rejection silently loses the lead, which is the one thing this app exists to
 * prevent. A false acceptance costs one undeliverable SMS.
 */
object PhoneNumberValidator {

    /**
     * Tokens carriers / the framework use in place of a real number.
     *
     * Matched against the *whole* trimmed value, case-insensitively. The previous
     * implementation used `contains`, which meant any real number containing a
     * zero ("+44 7700 900123") was rejected as invalid.
     */
    private val PLACEHOLDER_TOKENS = setOf(
        "UNKNOWN",
        "PRIVATE",
        "ANONYMOUS",
        "BLOCKED",
        "RESTRICTED",
        "WITHHELD",
        "HIDDEN",
        "UNAVAILABLE",
        "-1",
        "-2",
        "0"
    )

    /** Shortest plausible subscriber number. Shorter is almost always a short code. */
    private const val MIN_DIGITS = 6

    /** E.164 caps a full international number at 15 digits. */
    private const val MAX_DIGITS = 15

    /**
     * Strips formatting, keeping only what an SMS destination needs.
     * `null` maps to the empty string so callers never have to null-check.
     */
    fun normalize(raw: String?): String =
        raw.orEmpty().trim().filter { it.isDigit() || it == '+' }

    /** True when [raw] looks like a number a human could receive an SMS on. */
    fun isReplyable(raw: String?): Boolean {
        val value = raw.orEmpty().trim()
        if (value.isEmpty()) return false
        if (PLACEHOLDER_TOKENS.contains(value.uppercase())) return false

        val digits = value.filter { it.isDigit() }
        if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return false

        // All-zero payloads are a common carrier stand-in for a withheld caller.
        if (digits.all { it == '0' }) return false

        return true
    }
}
