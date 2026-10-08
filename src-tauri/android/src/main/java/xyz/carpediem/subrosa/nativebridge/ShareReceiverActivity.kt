package xyz.carpediem.subrosa.nativebridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Android's half of "share to Sub Rosa" (ADR-0095, after ADR-0048).
 *
 * The share sheet hands this activity a text, a link or files. It does what
 * the iOS share extension does and no more: copies each item into the share
 * inbox with a manifest beside it, then opens the app on
 * `subrosa://share/<id>`. The app reads the manifest (`share_inbox.rs`) and
 * makes the note, starts the fetch or fills a chat. It runs in the app's own
 * process, so the inbox is a folder of the app's data directory rather than
 * a shared container.
 *
 * There is nothing to show: the activity is translucent and finishes as
 * soon as the copies are written.
 */
class ShareReceiverActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val received = intent
        val context = applicationContext
        // Copying a recording can take a while; never on the main thread.
        Thread {
            val ids = try {
                receive(context, received)
            } catch (_: Exception) {
                emptyList()
            }
            runOnUiThread {
                if (ids.isEmpty()) {
                    Toast.makeText(this, R.string.subrosa_share_failed, Toast.LENGTH_SHORT).show()
                }
                // One address per item. A cold start keeps only the last one,
                // and the app sweeps the inbox for the rest.
                for (id in ids) {
                    val open = Intent(Intent.ACTION_VIEW, Uri.parse("subrosa://share/$id"))
                        .setPackage(packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        startActivity(open)
                    } catch (_: Exception) {
                        // The app's main activity always answers the scheme.
                    }
                }
                finish()
            }
        }.start()
    }

    companion object {
        /** The same folder name as `share_inbox.rs`, whose test reads it here. */
        const val INBOX_DIR = "share-inbox"
        private const val MAX_FILE_BYTES = 512L * 1024 * 1024
        private const val MAX_ITEMS = 10
        private val WEB_LINK = Regex("https?://\\S+", RegexOption.IGNORE_CASE)

        fun receive(context: Context, intent: Intent): List<String> {
            val inbox = File(context.dataDir, INBOX_DIR).apply { mkdirs() }
            return when (intent.action) {
                Intent.ACTION_SEND -> {
                    val stream = streamOf(intent)
                    if (stream != null) {
                        listOfNotNull(file(context, inbox, stream, intent.type))
                    } else {
                        listOfNotNull(text(inbox, intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()))
                    }
                }
                Intent.ACTION_SEND_MULTIPLE ->
                    streamsOf(intent).take(MAX_ITEMS).mapNotNull { file(context, inbox, it, intent.type) }
                else -> emptyList()
            }
        }

        @Suppress("DEPRECATION")
        private fun streamOf(intent: Intent): Uri? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_STREAM)

        @Suppress("DEPRECATION")
        private fun streamsOf(intent: Intent): List<Uri> =
            (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

        private fun newId() = UUID.randomUUID().toString().lowercase()

        /** A link first, as on iOS: a page shared from a browser is a link with
         * a title around it, and the link is what the app can act on. */
        private fun text(inbox: File, value: String?): String? {
            val text = value?.trim().orEmpty()
            if (text.isEmpty()) return null
            val links = WEB_LINK.findAll(text).map { it.value }.toList()
            val id = newId()
            val manifest = JSONObject()
            if (links.size == 1 && text.replace(links[0], "").trim().length <= 120) {
                manifest.put("kind", "link").put("url", links[0])
            } else {
                manifest.put("kind", "text").put("text", text)
            }
            writeManifest(inbox, id, manifest)
            return id
        }

        private fun file(context: Context, inbox: File, uri: Uri, intentType: String?): String? {
            val id = newId()
            val resolver = context.contentResolver
            val name = displayName(context, uri, resolver.getType(uri) ?: intentType)
            val target = File(inbox, "$id-$name")
            try {
                val input = resolver.openInputStream(uri) ?: return null
                input.use { source ->
                    target.outputStream().use { sink ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val read = source.read(buffer)
                            if (read < 0) break
                            total += read
                            if (total > MAX_FILE_BYTES) throw IllegalStateException("too large")
                            sink.write(buffer, 0, read)
                        }
                    }
                }
            } catch (_: Exception) {
                target.delete()
                return null
            }
            writeManifest(inbox, id, JSONObject().put("kind", "file").put("fileName", target.name))
            return id
        }

        /** One path segment, with an extension the app can decide by. */
        private fun displayName(context: Context, uri: Uri, mime: String?): String {
            var name = try {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
            } catch (_: Exception) {
                null
            } ?: uri.lastPathSegment ?: "shared"
            name = name.substringAfterLast('/').replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim()
            if (name.isEmpty() || name == "." || name == "..") name = "shared"
            if (!name.contains('.')) {
                val extension = mime?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
                if (extension != null) name = "$name.$extension"
            }
            return name.take(180)
        }

        private fun writeManifest(inbox: File, id: String, manifest: JSONObject) {
            val staging = File(inbox, "$id.json.part")
            staging.writeText(manifest.toString())
            if (!staging.renameTo(File(inbox, "$id.json"))) staging.delete()
        }
    }
}
