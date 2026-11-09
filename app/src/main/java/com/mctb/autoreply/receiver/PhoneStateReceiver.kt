package com.mctb.autoreply.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import com.mctb.autoreply.domain.PhoneState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Watches call state and turns "rang out unanswered" into a reply prompt.
 *
 * Why a manifest-declared receiver rather than a foreground service: the
 * previous design ran a `phoneCall`-type foreground service, which on Android 14+
 * requires `MANAGE_OWN_CALLS` or the default dialer role (otherwise
 * `startForeground` throws `SecurityException`), and on Android 15+ cannot be
 * launched from `BOOT_COMPLETED` at all. `ACTION_PHONE_STATE_CHANGED` is a
 * protected system broadcast that wakes a manifest receiver from a dead process,
 * so no long-lived service is needed - which also removes the battery
 * optimisation fight entirely.
 *
 * Note the app does **not** hold `READ_CALL_LOG`. That permission is what
 * populates `EXTRA_INCOMING_NUMBER`, and holding both it and `READ_PHONE_STATE`
 * makes the system deliver this broadcast twice per transition (once with the
 * number, once blank) in unspecified order. Dropping it means exactly one
 * delivery per transition and no race; the caller id comes from the screening
 * service instead.
 */
class PhoneStateReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        val appContext = context?.applicationContext ?: return
        if (intent?.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val current = PhoneState.fromExtra(intent.getStringExtra(TelephonyManager.EXTRA_STATE))
        if (current == null) {
            Log.w(TAG, "Unrecognised phone state: ${intent.getStringExtra(TelephonyManager.EXTRA_STATE)}")
            return
        }

        // Work happens on a coroutine, so hold the broadcast open until it
        // finishes. Without goAsync() the process is fair game for reclamation
        // the moment onReceive returns, which can kill the work mid-flight.
        val pendingResult = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                MissedCallHandler.handle(appContext, current)
            } catch (throwable: Throwable) {
                Log.e(TAG, "Failed to handle phone state $current", throwable)
            } finally {
                pendingResult.finish()
            }
        }
    }

    private companion object {
        const val TAG = "PhoneStateReceiver"
    }
}
