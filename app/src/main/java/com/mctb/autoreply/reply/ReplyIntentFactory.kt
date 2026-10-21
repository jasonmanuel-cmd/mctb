package com.mctb.autoreply.reply

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.mctb.autoreply.domain.PhoneNumberValidator

/**
 * Hands the composed reply to the user's own messaging app.
 *
 * This is the reason the app is publishable: it uses `ACTION_SENDTO`, which
 * needs no permission at all, instead of `SmsManager.sendTextMessage`, which
 * needs `SEND_SMS`. `SEND_SMS` sits in a restricted permission group that Google
 * Play limits to the registered default SMS/Phone/Assistant handler, and since
 * Android 15 it is additionally hard-restricted for sideloaded installs.
 *
 * The trade-off is explicit and unavoidable on Play: the user taps once to send
 * rather than the app sending silently.
 */
object ReplyIntentFactory {

    /**
     * Builds an intent that opens the default SMS app with [number] as the
     * recipient and [body] pre-filled.
     *
     * `Uri.fromParts` is used rather than string-concatenating `"smsto:$number"`
     * so a number containing characters with meaning in a URI cannot break the
     * parse.
     */
    fun create(number: String, body: String): Intent {
        val normalized = PhoneNumberValidator.normalize(number)
        val uri = Uri.fromParts(SCHEME_SMSTO, normalized, null)
        return Intent(Intent.ACTION_SENDTO, uri).apply {
            putExtra(EXTRA_SMS_BODY, body)
            // Required: this is launched from a BroadcastReceiver / notification.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * True when some app on the device can handle the reply intent.
     *
     * A device with no messaging app would otherwise throw
     * [ActivityNotFoundException] out of a notification tap.
     */
    fun canSend(context: Context, intent: Intent): Boolean =
        intent.resolveActivity(context.packageManager) != null

    private const val SCHEME_SMSTO = "smsto"
    private const val EXTRA_SMS_BODY = "sms_body"
}
