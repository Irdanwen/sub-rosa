package xyz.carpediem.subrosa.nativebridge

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.core.content.FileProvider
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.util.concurrent.Executors

@InvokeArg
class ScanDocumentArgs { lateinit var outputPath: String }

@InvokeArg
class ShareScanArgs { lateinit var path: String }

/**
 * The phone's document scanner: ML Kit's scanner activity (edge detection,
 * cropping, cleanup, several pages) and its text recognizer on each page.
 * Rust (src/scan/android.rs) reads one answer, the same one the iPhone gives:
 *
 *   {"cancelled":true}
 *   {"error":"…"}
 *   {"pages":[{"lines":[{"text":"…","top":0.12,"bottom":0.14}, …]}, …]}
 *
 * `top` and `bottom` are fractions of the page height from the top. The PDF
 * is copied to the path Rust gives, which must sit in the app's scans folder.
 */
object DocumentScanner {
    private const val PAGE_LIMIT = 20
    private val io = Executors.newSingleThreadExecutor()
    /** The path the running scan writes its PDF to; one scan at a time. */
    private var pendingOutput: File? = null

    private fun scansDir(activity: Activity): File =
        File(activity.dataDir, "scans").canonicalFile

    fun start(plugin: SubRosaPlugin, activity: Activity, invoke: Invoke) {
        val output = try {
            val requested = File(invoke.parseArgs(ScanDocumentArgs::class.java).outputPath).canonicalFile
            require(requested.toPath().startsWith(scansDir(activity).toPath())) { "invalid_path" }
            requested
        } catch (error: Exception) {
            invoke.resolve(JSObject().put("error", error.message ?: "invalid_path"))
            return
        }
        val options = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(PAGE_LIMIT)
            .setResultFormats(
                GmsDocumentScannerOptions.RESULT_FORMAT_JPEG,
                GmsDocumentScannerOptions.RESULT_FORMAT_PDF,
            )
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()
        GmsDocumentScanning.getClient(options)
            .getStartScanIntent(activity)
            .addOnSuccessListener { sender ->
                pendingOutput = output
                plugin.startScan(invoke, IntentSenderRequest.Builder(sender).build())
            }
            .addOnFailureListener { error ->
                // No Play services, or the scanner module could not be fetched.
                invoke.resolve(JSObject().put("error", error.message ?: "unsupported"))
            }
    }

    fun finish(activity: Activity, invoke: Invoke, result: ActivityResult) {
        val output = pendingOutput
        pendingOutput = null
        val scan = if (result.resultCode == Activity.RESULT_OK) {
            GmsDocumentScanningResult.fromActivityResultIntent(result.data)
        } else {
            null
        }
        if (scan == null || output == null) {
            invoke.resolve(JSObject().put("cancelled", true))
            return
        }
        // Copying and recognition take a moment a page: off the main thread.
        io.execute {
            try {
                scan.pdf?.uri?.let { uri -> copy(activity, uri, output) }
                val pages = JSArray()
                val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
                for (page in scan.pages.orEmpty()) {
                    pages.put(JSObject().put("lines", lines(activity, recognizer, page.imageUri)))
                }
                recognizer.close()
                invoke.resolve(JSObject().put("pages", pages))
            } catch (error: Exception) {
                invoke.resolve(JSObject().put("error", error.message ?: "scan_failed"))
            }
        }
    }

    private fun copy(activity: Activity, uri: Uri, output: File) {
        output.parentFile?.mkdirs()
        activity.contentResolver.openInputStream(uri)?.use { input ->
            output.outputStream().use { input.copyTo(it) }
        }
    }

    private fun lines(
        activity: Activity,
        recognizer: com.google.mlkit.vision.text.TextRecognizer,
        uri: Uri,
    ): JSArray {
        val image = InputImage.fromFilePath(activity, uri)
        val height = image.height.coerceAtLeast(1).toDouble()
        val text = Tasks.await(recognizer.process(image))
        val lines = JSArray()
        for (block in text.textBlocks) {
            for (line in block.lines) {
                val box = line.boundingBox
                val entry = JSObject().put("text", line.text)
                if (box != null) {
                    entry.put("top", box.top / height)
                    entry.put("bottom", box.bottom / height)
                }
                lines.put(entry)
            }
        }
        return lines
    }

    /** The scan's PDF to the share sheet, copied into the cache the app's
     * FileProvider serves, so no other path is ever exposed. */
    fun share(activity: Activity, invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ShareScanArgs::class.java)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "share_failed")
            return
        }
        io.execute {
            try {
                val file = File(args.path).canonicalFile
                require(file.toPath().startsWith(scansDir(activity).toPath()) && file.isFile) {
                    "The scanned PDF is not on this device."
                }
                val outbox = File(activity.cacheDir, "share").apply { mkdirs() }
                outbox.listFiles()?.forEach { stale -> stale.delete() }
                val copy = File(outbox, file.name)
                file.inputStream().use { input -> copy.outputStream().use { input.copyTo(it) } }
                val uri = FileProvider.getUriForFile(
                    activity,
                    "${activity.packageName}.fileprovider",
                    copy,
                )
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "application/pdf"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.runOnUiThread {
                    activity.startActivity(Intent.createChooser(intent, null))
                }
                invoke.resolve(JSObject())
            } catch (error: Exception) {
                invoke.reject(error.message ?: "share_failed")
            }
        }
    }
}
