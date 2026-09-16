package xyz.carpediem.subrosa.nativebridge

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.util.concurrent.Executors

@InvokeArg
class ShareTextArgs { lateinit var text: String }

@InvokeArg
class OpenUrlArgs { lateinit var url: String }

@InvokeArg
class SaveToPhotosArgs {
    lateinit var path: String
    lateinit var kind: String
}

/** The app reads only its own gallery; Android chooses every export destination. */
object AndroidExports {
    private val io = Executors.newSingleThreadExecutor()

    fun shareText(activity: Activity, invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareTextArgs::class.java)
            require(args.text.isNotBlank()) { "There is nothing to share." }
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, args.text)
            }
            activity.startActivity(Intent.createChooser(intent, null))
            invoke.resolve(JSObject())
        } catch (error: Exception) {
            invoke.reject(error.message ?: "share_failed")
        }
    }

    fun openUrl(activity: Activity, invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenUrlArgs::class.java)
            val uri = Uri.parse(args.url)
            require(uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()) {
                "Only https links can be opened."
            }
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
            })
            invoke.resolve(JSObject())
        } catch (error: Exception) {
            invoke.reject(error.message ?: "open_url_failed")
        }
    }

    fun saveToPhotos(activity: Activity, invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SaveToPhotosArgs::class.java)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "photos_save_failed")
            return
        }
        io.execute {
            val resolver = activity.contentResolver
            var inserted: Uri? = null
            try {
                // Rust canonicalizes against the actual Tauri gallery root before
                // invoking us. Repeat the sandbox check at the Android boundary.
                val file = File(args.path).canonicalFile
                val filesRoot = activity.filesDir.canonicalFile
                require(file.toPath().startsWith(filesRoot.toPath()) && file.isFile) {
                    "The media file could not be found."
                }
                require(args.kind == "image" || args.kind == "video") { "photos_kind_invalid" }
                val mime = MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(file.extension.lowercase())
                require(mime != null && mime.startsWith("${args.kind}/")) { "photos_kind_invalid" }
                val video = args.kind == "video"
                val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                val directory = if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "$directory/Sub Rosa")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = resolver.insert(collection, values) ?: error("photos_save_failed")
                inserted = uri
                resolver.openOutputStream(uri, "w")?.use { output ->
                    file.inputStream().use { input -> input.copyTo(output) }
                } ?: error("photos_save_failed")
                val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                check(resolver.update(uri, published, null, null) == 1) { "photos_save_failed" }
                invoke.resolve(JSObject())
            } catch (error: Exception) {
                inserted?.let { uri -> runCatching { resolver.delete(uri, null, null) } }
                invoke.reject(error.message ?: "photos_save_failed")
            }
        }
    }
}
