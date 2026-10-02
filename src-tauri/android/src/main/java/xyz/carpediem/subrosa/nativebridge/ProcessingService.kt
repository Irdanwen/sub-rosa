package xyz.carpediem.subrosa.nativebridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process in the foreground while a note is transcribed (ADR-0071).
 *
 * The microphone service ends with the recording, and a meeting takes minutes
 * to transcribe after that: without this, switching app or locking the phone
 * left the work to whatever time Android felt like granting. The service only
 * keeps the process alive and shows the progress Rust reports; the work, its
 * durable row and its saved chunks stay in Rust, so a service Android stops
 * pauses the note rather than losing it.
 */
class ProcessingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = build(this, current.title, current.done)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    /** Android 15 caps data-sync services. Stopping here is mandatory; the
     * note is resumed from its saved chunks the next time the app runs. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    companion object {
        private data class Shown(val title: String?, val done: Int)

        private const val CHANNEL_ID = "subrosa-processing"
        private const val NOTIFICATION_ID = 4818
        const val PROGRESS_UNITS = 1000

        private val notes = mutableSetOf<String>()
        @Volatile private var current = Shown(null, 0)

        @Synchronized
        fun start(context: Context, noteId: String, title: String?) {
            current = Shown(title, 0)
            if (notes.isEmpty()) {
                ContextCompat.startForegroundService(context, Intent(context, ProcessingService::class.java))
            }
            notes.add(noteId)
        }

        @Synchronized
        fun update(context: Context, noteId: String, done: Int) {
            if (noteId !in notes) return
            current = current.copy(done = done)
            context.getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, build(context, current.title, done))
        }

        @Synchronized
        fun stop(context: Context, noteId: String) {
            if (!notes.remove(noteId) || notes.isNotEmpty()) return
            context.stopService(Intent(context, ProcessingService::class.java))
        }

        private fun build(context: Context, title: String?, done: Int): Notification {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(NotificationChannel(
                    CHANNEL_ID, context.getString(R.string.subrosa_processing_channel), NotificationManager.IMPORTANCE_LOW
                ))
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(context.getString(R.string.subrosa_processing_title))
                .setContentText(title?.takeIf { it.isNotBlank() } ?: context.getString(R.string.subrosa_processing_description))
                .setProgress(PROGRESS_UNITS, done.coerceIn(0, PROGRESS_UNITS), false)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .apply {
                    if (launch != null) setContentIntent(PendingIntent.getActivity(
                        context, 1, launch,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    ))
                }.build()
        }
    }
}
