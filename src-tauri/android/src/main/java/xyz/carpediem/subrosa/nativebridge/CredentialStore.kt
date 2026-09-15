package xyz.carpediem.subrosa.nativebridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only ciphertext is written to app storage; the encryption key never leaves Android Keystore.
 * noBackupFilesDir deliberately prevents restoring ciphertext without its device-bound key. */
internal class CredentialStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "credentials").apply {
        check(isDirectory || mkdirs()) { "Credential directory unavailable" }
    }

    private fun file(id: String): AtomicFile {
        val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
        val name = digest.joinToString("") { "%02x".format(it.toInt() and 255) }
        return AtomicFile(File(directory, name))
    }

    private fun encryptionKey(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        check(create) { "Credential encryption key unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    @Synchronized
    fun set(id: String, encoded: String) {
        val plaintext = Base64.decode(encoded, Base64.NO_WRAP)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey(true))
            cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
            val ciphertext = cipher.doFinal(plaintext)
            val destination = file(id)
            val stream = destination.startWrite()
            try {
                // Version + fixed 96-bit GCM nonce + ciphertext with authentication tag.
                check(cipher.iv.size == 12)
                stream.write(byteArrayOf(1))
                stream.write(cipher.iv)
                stream.write(ciphertext)
                destination.finishWrite(stream)
            } catch (error: Exception) {
                destination.failWrite(stream)
                throw error
            }
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun get(id: String): String? {
        val source = file(id)
        if (!source.baseFile.exists() && !File(source.baseFile.path + ".bak").exists()) return null
        val bytes = source.readFully()
        check(bytes.size >= 29 && bytes[0] == 1.toByte()) { "Invalid credential format" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(false), GCMParameterSpec(128, bytes, 1, 12))
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        val plaintext = cipher.doFinal(bytes, 13, bytes.size - 13)
        return try {
            Base64.encodeToString(plaintext, Base64.NO_WRAP)
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun delete(id: String): Boolean {
        val source = file(id)
        val existed = source.baseFile.exists() || File(source.baseFile.path + ".bak").exists()
        source.delete()
        check(!source.baseFile.exists() && !File(source.baseFile.path + ".bak").exists())
        return existed
    }

    companion object {
        private const val KEY_ALIAS = "xyz.carpediem.subrosa.credentials.v1"
    }
}
