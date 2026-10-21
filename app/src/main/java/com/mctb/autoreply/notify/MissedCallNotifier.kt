package com.mctb.autoreply.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.mctb.autoreply.R
import com.mctb.autoreply.reply.ReplyActivity
import com.mctb.autoreply.ui.MainActivity

/**
 * Posts the "you missed a call - send the reply?" prompt.
 *
 * Priority is high so the prompt reaches the user while the caller is still
 * deciding whether to redial, which is the whole point of the product.
 */
class MissedCallNotifier(private val context: Context) {

    /**
     * @param requestCode unique per call so prompts for different callers get
     *   distinct [PendingIntent]s instead of overwriting one another
     */
    fun notifyMissedCall(number: String, message: String, requestCode: Int) {
        createChannel()

        val replyPendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            ReplyActivity.intentFor(context, number, message),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            context,
            // Offset so this never collides with the reply intent's request code.
            requestCode + OPEN_APP_REQUEST_CODE_OFFSET,
            openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle(context.getString(R.string.missed_call_title, number))
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openAppPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_send,
                context.getString(R.string.missed_call_action_send),
                replyPendingIntent
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .build()

        val manager = NotificationManagerCompat.from(context)

        // POST_NOTIFICATIONS is a runtime permission on API 33+. Posting without
        // it throws SecurityException, so check first and let the caller surface
        // the problem through the UI.
        if (!manager.areNotificationsEnabled()) return

        manager.notify(
            NOTIFICATION_ID_BASE + (requestCode % NOTIFICATION_ID_SPREAD),
            notification
        )
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.notification_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private companion object {
        const val CHANNEL_ID = "missed_call_replies"
        const val NOTIFICATION_ID_BASE = 2000
        const val NOTIFICATION_ID_SPREAD = 500
        const val OPEN_APP_REQUEST_CODE_OFFSET = 100_000
    }
}
