package com.mctb.autoreply.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveHoursTest {

    private fun at(h: Int, m: Int) = ActiveHours.minuteOfDay(h, m)

    @Test
    fun `always on is active at every hour`() {
        val hours = ActiveHours(at(8, 0), at(18, 0), alwaysOn = true)
        assertTrue(hours.isActiveAt(at(3, 0)))
        assertTrue(hours.isActiveAt(at(23, 59)))
    }

    @Test
    fun `same-day window includes start and excludes end`() {
        val hours = ActiveHours(at(8, 0), at(18, 0), alwaysOn = false)
        assertTrue(hours.isActiveAt(at(8, 0)))
        assertTrue(hours.isActiveAt(at(17, 59)))
        assertFalse(hours.isActiveAt(at(18, 0)))
        assertFalse(hours.isActiveAt(at(7, 59)))
    }

    @Test
    fun `window crossing midnight wraps correctly`() {
        val hours = ActiveHours(at(22, 0), at(2, 0), alwaysOn = false)
        assertTrue(hours.isActiveAt(at(22, 0)))
        assertTrue(hours.isActiveAt(at(23, 30)))
        assertTrue(hours.isActiveAt(at(0, 0)))
        assertTrue(hours.isActiveAt(at(1, 59)))
        assertFalse(hours.isActiveAt(at(2, 0)))
        assertFalse(hours.isActiveAt(at(12, 0)))
    }

    @Test
    fun `identical start and end means all day rather than never`() {
        val hours = ActiveHours(at(8, 0), at(8, 0), alwaysOn = false)
        assertTrue(hours.isActiveAt(at(0, 0)))
        assertTrue(hours.isActiveAt(at(8, 0)))
        assertTrue(hours.isActiveAt(at(23, 59)))
    }

    @Test
    fun `minuteOfDay packs and clamps`() {
        org.junit.Assert.assertEquals(1305, at(21, 45))
        org.junit.Assert.assertEquals(0, at(0, 0))
        // Clamped rather than throwing: a bad pick in the UI must not crash
        // the background path that reads it back.
        org.junit.Assert.assertEquals(23 * 60 + 59, at(25, 99))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `out of range minutes are rejected at construction`() {
        ActiveHours(startMinuteOfDay = 1440, endMinuteOfDay = 0, alwaysOn = false)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `out of range query is rejected`() {
        ActiveHours(at(8, 0), at(18, 0), alwaysOn = false).isActiveAt(1440)
    }
}
