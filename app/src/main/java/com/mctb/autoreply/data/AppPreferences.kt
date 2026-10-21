package com.mctb.autoreply.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.mctb.autoreply.domain.ActiveHours
import com.mctb.autoreply.domain.DebounceLedger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.io.IOException
import java.util.Calendar

/**
 * Single DataStore instance for the whole process.
 *
 * Declared at file top level (not inside a class or companion object) so every
 * accessor provably shares one instance - creating a second `DataStore` for the
 * same file throws `IllegalStateException` at runtime.
 */
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(
    name = "auto_reply_preferences"
)

/**
 * Everything the background path needs to decide whether to prompt for a reply,
 * read as one atomic snapshot.
 */
data class ReplySettings(
    val enabled: Boolean,
    val message: String,
    val activeHours: ActiveHours,
    val replyCount: Int,
    val isUnlimited: Boolean,
    val debounceLedger: String?
)

/**
 * Type-safe access to app configuration.
 *
 * Every one-shot read uses `Flow.first()`. The previous implementation used
 * `Flow.collect { }`, which never returns: `DataStore.data` emits the current
 * value and then stays open emitting subsequent changes, so those helpers
 * suspended forever and the send path never executed past its first line.
 */
class AppPreferences(private val context: Context) {

    companion object {
        private val KEY_ENABLED = booleanPreferencesKey("enabled")
        private val KEY_MESSAGE = stringPreferencesKey("message")
        private val KEY_START_HOUR = intPreferencesKey("start_hour")
        private val KEY_START_MINUTE = intPreferencesKey("start_minute")
        private val KEY_END_HOUR = intPreferencesKey("end_hour")
        private val KEY_END_MINUTE = intPreferencesKey("end_minute")
        private val KEY_ALWAYS_ON = booleanPreferencesKey("always_on")
        private val KEY_REPLY_COUNT = intPreferencesKey("reply_count")
        private val KEY_IS_UNLIMITED = booleanPreferencesKey("is_unlimited")
        private val KEY_DEBOUNCE_LEDGER = stringPreferencesKey("debounce_ledger")
        private val KEY_SERVER_BASE_URL = stringPreferencesKey("server_base_url")
        private val KEY_API_TOKEN = stringPreferencesKey("api_token")

        const val DEFAULT_MESSAGE =
            "Hi! I missed your call - I'm on the job right now. I'll call you back as soon as I can. Thanks!"
        const val DEFAULT_START_HOUR = 8
        const val DEFAULT_START_MINUTE = 0
        const val DEFAULT_END_HOUR = 18
        const val DEFAULT_END_MINUTE = 0

        /** Reply prompts included before the unlimited upgrade. */
        const val FREE_TIER_LIMIT = 5

        /** Cooldown per caller. */
        const val DEBOUNCE_WINDOW_MS = 30 * 60 * 1000L

        /** Hard cap on the message; one GSM segment. */
        const val MAX_MESSAGE_LENGTH = 160
    }

    /**
     * `DataStore.data` can throw `IOException` on a corrupt file. Falling back to
     * [emptyPreferences] means a damaged file degrades to defaults instead of
     * crashing a background receiver.
     */
    private val safeData: Flow<Preferences> = context.dataStore.data
        .catch { throwable ->
            if (throwable is IOException) emit(emptyPreferences()) else throw throwable
        }

    // ---------------------------------------------------------------------
    // Reactive views for the UI
    // ---------------------------------------------------------------------

    val isEnabled: Flow<Boolean> = safeData.map { it[KEY_ENABLED] ?: false }

    val message: Flow<String> = safeData.map { it[KEY_MESSAGE] ?: DEFAULT_MESSAGE }

    val isAlwaysOn: Flow<Boolean> = safeData.map { it[KEY_ALWAYS_ON] ?: false }

    val startMinuteOfDay: Flow<Int> = safeData.map {
        ActiveHours.minuteOfDay(
            it[KEY_START_HOUR] ?: DEFAULT_START_HOUR,
            it[KEY_START_MINUTE] ?: DEFAULT_START_MINUTE
        )
    }

    val endMinuteOfDay: Flow<Int> = safeData.map {
        ActiveHours.minuteOfDay(
            it[KEY_END_HOUR] ?: DEFAULT_END_HOUR,
            it[KEY_END_MINUTE] ?: DEFAULT_END_MINUTE
        )
    }

    val replyCount: Flow<Int> = safeData.map { it[KEY_REPLY_COUNT] ?: 0 }

    val isUnlimited: Flow<Boolean> = safeData.map { it[KEY_IS_UNLIMITED] ?: false }

    /** Origin of the reply server, e.g. https://missed-call-reply.vercel.app */
    val serverBaseUrl: Flow<String> = safeData.map { it[KEY_SERVER_BASE_URL] ?: "" }

    /** This subscriber's own credential. Not the operator API key. */
    val apiToken: Flow<String> = safeData.map { it[KEY_API_TOKEN] ?: "" }

    /**
     * Single read of the whole configuration. Used by the background path so one
     * DataStore round-trip serves the entire decision.
     */
    suspend fun readSettings(): ReplySettings {
        val prefs = safeData.first()
        val startHour = prefs[KEY_START_HOUR] ?: DEFAULT_START_HOUR
        val startMinute = prefs[KEY_START_MINUTE] ?: DEFAULT_START_MINUTE
        val endHour = prefs[KEY_END_HOUR] ?: DEFAULT_END_HOUR
        val endMinute = prefs[KEY_END_MINUTE] ?: DEFAULT_END_MINUTE

        return ReplySettings(
            enabled = prefs[KEY_ENABLED] ?: false,
            message = prefs[KEY_MESSAGE] ?: DEFAULT_MESSAGE,
            activeHours = ActiveHours(
                startMinuteOfDay = ActiveHours.minuteOfDay(startHour, startMinute),
                endMinuteOfDay = ActiveHours.minuteOfDay(endHour, endMinute),
                alwaysOn = prefs[KEY_ALWAYS_ON] ?: false
            ),
            replyCount = prefs[KEY_REPLY_COUNT] ?: 0,
            isUnlimited = prefs[KEY_IS_UNLIMITED] ?: false,
            debounceLedger = prefs[KEY_DEBOUNCE_LEDGER]
        )
    }

    // ---------------------------------------------------------------------
    // Writes
    // ---------------------------------------------------------------------

    suspend fun setEnabled(enabled: Boolean) {
        context.dataStore.edit { it[KEY_ENABLED] = enabled }
    }

    suspend fun setMessage(message: String) {
        context.dataStore.edit {
            it[KEY_MESSAGE] = message.take(MAX_MESSAGE_LENGTH)
        }
    }

    suspend fun resetMessageToDefault() {
        context.dataStore.edit { it[KEY_MESSAGE] = DEFAULT_MESSAGE }
    }

    suspend fun setAlwaysOn(alwaysOn: Boolean) {
        context.dataStore.edit { it[KEY_ALWAYS_ON] = alwaysOn }
    }

    /**
     * @param startMinuteOfDay inclusive window start, minutes since midnight
     * @param endMinuteOfDay   exclusive window end, minutes since midnight
     */
    suspend fun setActiveHours(startMinuteOfDay: Int, endMinuteOfDay: Int) {
        context.dataStore.edit { prefs ->
            prefs[KEY_START_HOUR] = startMinuteOfDay / 60
            prefs[KEY_START_MINUTE] = startMinuteOfDay % 60
            prefs[KEY_END_HOUR] = endMinuteOfDay / 60
            prefs[KEY_END_MINUTE] = endMinuteOfDay % 60
        }
    }

    suspend fun setUnlimited(unlimited: Boolean) {
        context.dataStore.edit { it[KEY_IS_UNLIMITED] = unlimited }
    }

    /**
     * Stores where the server is and how to authenticate to it.
     *
     * Both are written in one `edit` so the app can never hold a token pointed
     * at the wrong origin. Trailing slashes are stripped because the server
     * concatenates this with a path to build webhook signature URLs.
     */
    suspend fun setServerConfig(baseUrl: String, token: String) {
        context.dataStore.edit {
            it[KEY_SERVER_BASE_URL] = baseUrl.trim().trimEnd('/')
            it[KEY_API_TOKEN] = token.trim()
        }
    }

    /**
     * One read of both server values, for callers that need them together.
     *
     * Returns null when either is missing: a half-configured server is not
     * usable, and reporting that as "configured" would produce a confusing
     * network failure instead of a clear "not set up yet".
     */
    suspend fun readServerConfig(): ServerConfig? {
        val prefs = safeData.first()
        val url = prefs[KEY_SERVER_BASE_URL]?.trim()?.trimEnd('/') ?: ""
        val token = prefs[KEY_API_TOKEN]?.trim() ?: ""
        if (url.isEmpty() || token.isEmpty()) return null
        return ServerConfig(baseUrl = url, apiToken = token)
    }

    /**
     * Consumes one unit of quota and closes the cooldown for [number] atomically.
     *
     * Both happen in one `edit` so a crash between them cannot bill the user a
     * prompt without recording the debounce, or vice versa.
     */
    suspend fun consumeReplyFor(number: String, nowMs: Long) {
        context.dataStore.edit { prefs ->
            val unlimited = prefs[KEY_IS_UNLIMITED] ?: false
            if (!unlimited) {
                prefs[KEY_REPLY_COUNT] = (prefs[KEY_REPLY_COUNT] ?: 0) + 1
            }
            prefs[KEY_DEBOUNCE_LEDGER] = DebounceLedger.record(
                encoded = prefs[KEY_DEBOUNCE_LEDGER],
                number = number,
                nowMs = nowMs,
                windowMs = DEBOUNCE_WINDOW_MS
            )
        }
    }

    /** Current minute of the day in the device's local time zone. */
    fun currentMinuteOfDay(calendar: Calendar = Calendar.getInstance()): Int =
        ActiveHours.minuteOfDay(
            calendar.get(Calendar.HOUR_OF_DAY),
            calendar.get(Calendar.MINUTE)
        )
}

/** Where the reply server is, and the credential for this subscriber. */
data class ServerConfig(val baseUrl: String, val apiToken: String)

/** Free-tier status derived from a [ReplySettings] snapshot. */
data class Quota(val used: Int, val isUnlimited: Boolean) {
    val limit: Int get() = AppPreferences.FREE_TIER_LIMIT
    val isExhausted: Boolean get() = !isUnlimited && used >= limit
    val remaining: Int get() = if (isUnlimited) Int.MAX_VALUE else (limit - used).coerceAtLeast(0)
}
