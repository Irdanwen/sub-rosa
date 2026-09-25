package xyz.carpediem.subrosa.nativebridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@InvokeArg
class CredentialArgs {
    lateinit var id: String
    var secret: String? = null
}

@InvokeArg
class PasskeyArgs {
    lateinit var options: String
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class SubRosaPlugin(private val activity: Activity) : Plugin(activity) {
    private val credentials by lazy { CredentialStore(activity.applicationContext) }
    private var recordings = 0

    @Command
    fun passkeyGet(invoke: Invoke) {
        val options = try {
            invoke.parseArgs(PasskeyArgs::class.java).options
        } catch (_: Exception) {
            invoke.reject("The passkey request is invalid.", "passkey_request_invalid")
            return
        }
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val request = GetCredentialRequest(
                    listOf(GetPublicKeyCredentialOption(requestJson = options))
                )
                val result = CredentialManager.create(activity).getCredential(
                    context = activity, request = request
                )
                val credential = result.credential as? PublicKeyCredential
                if (credential == null) {
                    invoke.reject("Choose a passkey to continue.", "passkey_unavailable")
                } else {
                    invoke.resolve(JSObject().put("credential", credential.authenticationResponseJson))
                }
            } catch (_: Exception) {
                invoke.reject("The passkey could not be used.", "passkey_unavailable")
            }
        }
    }

    @Command
    fun credentialSet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialArgs::class.java)
            credentials.set(args.id, requireNotNull(args.secret))
            invoke.resolve()
        } catch (_: Exception) {
            // Neither platform exceptions nor invocation arguments may expose credentials.
            invoke.reject("Secure credential storage is unavailable.", "credential_store_failed")
        }
    }

    @Command
    fun credentialGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialArgs::class.java)
            val result = JSObject()
            val secret = credentials.get(args.id)
            result.put("found", secret != null)
            if (secret != null) result.put("secret", secret)
            invoke.resolve(result)
        } catch (_: Exception) {
            invoke.reject("Secure credential storage is unavailable.", "credential_store_failed")
        }
    }

    @Command
    fun credentialDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialArgs::class.java)
            invoke.resolve(JSObject().put("found", credentials.delete(args.id)))
        } catch (_: Exception) {
            invoke.reject("Secure credential storage is unavailable.", "credential_store_failed")
        }
    }

    @Command
    fun microphonePermission(invoke: Invoke) {
        val state = when (getPermissionState("microphone")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "unknown"
        }
        invoke.resolve(JSObject().put("state", state))
    }

    @Command
    fun startRecording(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            microphoneGranted(invoke)
        } else {
            requestPermissionForAlias("microphone", invoke, "microphoneGranted")
        }
    }

    @PermissionCallback
    private fun microphoneGranted(invoke: Invoke) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            invoke.reject("Microphone access is not allowed. Enable it in Settings for this app.", "microphone_permission_denied")
            return
        }
        try {
            if (recordings == 0) {
                ContextCompat.startForegroundService(activity, Intent(activity, RecordingService::class.java))
            }
            recordings += 1
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("Open Sub Rosa to start recording.", "recording_start_failed")
        }
    }

    @Command
    fun stopRecording(invoke: Invoke) {
        recordings = (recordings - 1).coerceAtLeast(0)
        if (recordings == 0) activity.stopService(Intent(activity, RecordingService::class.java))
        invoke.resolve()
    }

    @Command
    fun shareText(invoke: Invoke) = AndroidExports.shareText(activity, invoke)

    @Command
    fun saveToPhotos(invoke: Invoke) = AndroidExports.saveToPhotos(activity, invoke)

    @Command
    fun openUrl(invoke: Invoke) = AndroidExports.openUrl(activity, invoke)
}
