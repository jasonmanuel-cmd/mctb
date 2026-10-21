package com.mctb.autoreply.domain

/**
 * The daily window during which a missed call should produce a reply prompt.
 *
 * Both bounds are minutes since local midnight, which keeps the comparison free
 * of `Calendar`/`java.time` and therefore unit testable on the JVM.
 *
 * @param startMinuteOfDay inclusive lower bound
 * @param endMinuteOfDay   exclusive upper bound
 * @param alwaysOn         when true the window is ignored entirely
 */
data class ActiveHours(
    val startMinuteOfDay: Int,
    val endMinuteOfDay: Int,
    val alwaysOn: Boolean
) {
    init {
        require(startMinuteOfDay in 0 until MINUTES_IN_DAY) {
            "startMinuteOfDay must be in 0 until $MINUTES_IN_DAY but was $startMinuteOfDay"
        }
        require(endMinuteOfDay in 0 until MINUTES_IN_DAY) {
            "endMinuteOfDay must be in 0 until $MINUTES_IN_DAY but was $endMinuteOfDay"
        }
    }

    /** True when a miss occurring at [minuteOfDay] should trigger a reply. */
    fun isActiveAt(minuteOfDay: Int): Boolean {
        require(minuteOfDay in 0 until MINUTES_IN_DAY) {
            "minuteOfDay must be in 0 until $MINUTES_IN_DAY but was $minuteOfDay"
        }
        if (alwaysOn) return true

        // A zero-length window ("08:00 to 08:00") is read as "all day" rather than
        // "never" - a user who picks identical times almost certainly means the former.
        if (startMinuteOfDay == endMinuteOfDay) return true

        return if (startMinuteOfDay < endMinuteOfDay) {
            // Same-day window, e.g. 08:00 -> 18:00.
            minuteOfDay in startMinuteOfDay until endMinuteOfDay
        } else {
            // Window crossing midnight, e.g. 22:00 -> 02:00.
            minuteOfDay >= startMinuteOfDay || minuteOfDay < endMinuteOfDay
        }
    }

    companion object {
        const val MINUTES_IN_DAY = 24 * 60

        /** Packs a wall-clock time into minutes since midnight, clamped into range. */
        fun minuteOfDay(hour: Int, minute: Int): Int {
            val h = hour.coerceIn(0, 23)
            val m = minute.coerceIn(0, 59)
            return h * 60 + m
        }
    }
}
