package xyz.carpediem.subrosa.nativebridge

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/**
 * The home screen widget (ADR-0095): Ask, Dictate and Record, each one a
 * `subrosa://` address the app already answers (src/lib/destinations.ts).
 * It shows nothing of the person's data, so it never needs updating beyond
 * wiring its buttons.
 */
class AskWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        val views = RemoteViews(context.packageName, R.layout.subrosa_widget).apply {
            setOnClickPendingIntent(R.id.subrosa_widget_ask, open(context, 1, ASK))
            setOnClickPendingIntent(R.id.subrosa_widget_dictate, open(context, 2, DICTATE))
            setOnClickPendingIntent(R.id.subrosa_widget_record, open(context, 3, RECORD))
        }
        for (id in widgetIds) manager.updateAppWidget(id, views)
    }

    private fun open(context: Context, request: Int, address: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(address))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context, request, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    companion object {
        const val ASK = "subrosa://chat/new"
        const val DICTATE = "subrosa://dictation?start=1"
        const val RECORD = "subrosa://record"
    }
}
