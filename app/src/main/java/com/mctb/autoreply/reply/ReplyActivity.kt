package com.mctb.autoreply.reply

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.mctb.autoreply.R
import com.mctb.autoreply.data.AppPreferences
import com.mctb.autoreply.domain.PhoneNumberValidator
import kotlinx.coroutines.launch

/**
 * Invisible trampoline between the notification's "Send reply" action and the
 * user's messaging app.
 *
 * It exists so quota is charged when the user actually acts, not when a prompt
 * is merely posted - otherwise someone who ignores five prompts would burn their
 * whole free tier without sending anything.
 *
 * Being a real activity (rather than a `BroadcastReceiver` that then tries to
 * start one) keeps this clear of Android 10+'s background activity start
 * restrictions: the launch is user-initiated from a notification tap.
 */
class ReplyActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val number = intent.getStringExtra(EXTRA_NUMBER)
        val message = intent.getStringExtra(EXTRA_MESSAGE).orEmpty()

        if (number == null || !PhoneNumberValidator.isReplyable(number)) {
            Log.w(TAG, "Reply requested for an unusable number")
            finish()
            return
        }

        // Charge the reply, then hand off. Fired before the hand-off so a
        // crashed messaging app cannot produce a free send.
        lifecycleScope.launch {
            runCatching {
                AppPreferences(applicationContext)
                    .consumeReplyFor(number, System.currentTimeMillis())
            }.onFailure { throwable -> Log.e(TAG, "Failed to record reply", throwable) }
        }

        val sendIntent = ReplyIntentFactory.create(number, message)
        if (ReplyIntentFactory.canSend(this, sendIntent)) {
            startActivity(sendIntent)
        } else {
            Toast.makeText(this, R.string.error_no_messaging_app, Toast.LENGTH_LONG).show()
        }

        finish()
    }

    companion object {
        const val EXTRA_NUMBER = "extra_number"
        const val EXTRA_MESSAGE = "extra_message"

        private const val TAG = "ReplyActivity"

        /** Intent targeting the trampoline for a given caller. */
        fun intentFor(context: Context, number: String, message: String): Intent =
            Intent(context, ReplyActivity::class.java).apply {
                putExtra(EXTRA_NUMBER, number)
                putExtra(EXTRA_MESSAGE, message)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
    }
}
