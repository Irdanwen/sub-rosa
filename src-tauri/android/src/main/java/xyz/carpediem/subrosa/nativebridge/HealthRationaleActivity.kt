package xyz.carpediem.subrosa.nativebridge

import android.app.Activity
import android.os.Bundle
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * What Health Connect shows when the person asks why Sub Rosa wants their
 * health data (the permission rationale every app reading it must offer, on
 * Android 13 and earlier through ACTION_SHOW_PERMISSIONS_RATIONALE and on 14
 * and later through VIEW_PERMISSION_USAGE). The text is the app's privacy
 * promise for Health, in the person's language (ADR-0099).
 */
class HealthRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val padding = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        column.addView(TextView(this).apply {
            setText(R.string.subrosa_health_rationale_title)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        })
        column.addView(TextView(this).apply {
            setText(R.string.subrosa_health_rationale_body)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(0, padding / 2, 0, 0)
        })
        setContentView(ScrollView(this).apply { addView(column) })
    }
}
