package com.mctb.autoreply.domain

/**
 * Per-number cooldown, so a caller who redials four times does not get four
 * prompts.
 *
 * Encoded as a single flat string (`digits:timestamp,digits:timestamp`) so it can
 * live in one DataStore key. The previous implementation minted a new preference
 * key per phone number and never removed any, so the store grew without bound
 * for the lifetime of the install.
 *
 * [record] prunes every entry whose window has already expired, which keeps the
 * map bounded by "numbers that called in the last window" rather than "numbers
 * that ever called".
 */
object DebounceLedger {

    private const val ENTRY_SEPARATOR = ','
    private const val FIELD_SEPARATOR = ':'

    /** Stable key for a number: digits only, so `+1 (555) 010-1234` == `15550101234`. */
    fun keyFor(number: String): String = number.filter { it.isDigit() }

    /** Parses [encoded], silently dropping malformed entries rather than throwing. */
    fun parse(encoded: String?): Map<String, Long> {
        if (encoded.isNullOrBlank()) return emptyMap()
        return encoded.split(ENTRY_SEPARATOR)
            .mapNotNull { entry ->
                val parts = entry.split(FIELD_SEPARATOR)
                if (parts.size != 2) return@mapNotNull null
                val key = parts[0]
                val at = parts[1].toLongOrNull() ?: return@mapNotNull null
                if (key.isEmpty()) return@mapNotNull null
                key to at
            }
            .toMap()
    }

    fun encode(entries: Map<String, Long>): String =
        entries.entries.joinToString(separator = ENTRY_SEPARATOR.toString()) { (key, at) ->
            "$key$FIELD_SEPARATOR$at"
        }

    /** True when nothing has been sent to this number inside the cooldown window. */
    fun canSend(
        encoded: String?,
        number: String,
        nowMs: Long,
        windowMs: Long
    ): Boolean {
        val key = keyFor(number)
        if (key.isEmpty()) return false
        val last = parse(encoded)[key] ?: return true
        return (nowMs - last) > windowMs
    }

    /** Records a send and returns the re-encoded ledger with expired entries pruned. */
    fun record(
        encoded: String?,
        number: String,
        nowMs: Long,
        windowMs: Long
    ): String {
        val key = keyFor(number)
        val pruned = parse(encoded).filterValues { (nowMs - it) <= windowMs }.toMutableMap()
        if (key.isNotEmpty()) pruned[key] = nowMs
        return encode(pruned)
    }
}
