//! Android's native seams. Install this plugin before loading any settings:
//! keyring otherwise defaults to its non-persistent mock backend on Android.
//! Keystore credentials deliberately share the existing Entry API, so every
//! secret (Carpe Diem, GitHub and provider profiles) gets the same protection.

use std::{any::Any, sync::OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin};
use zeroize::Zeroizing;

use crate::domain::types::AppError;

static NATIVE: OnceLock<PluginHandle<tauri::Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("subrosa-native")
        .setup(|_app, api| {
            let handle =
                api.register_android_plugin("xyz.carpediem.subrosa.nativebridge", "SubRosaPlugin")?;
            NATIVE
                .set(handle)
                .map_err(|_| std::io::Error::other("Android native bridge already initialized"))?;
            keyring::set_default_credential_builder(Box::new(AndroidCredentialBuilder));
            Ok(())
        })
        .build()
}

pub fn invoke<T: DeserializeOwned>(command: &str, payload: impl Serialize) -> Result<T, AppError> {
    let native = NATIVE.get().ok_or_else(|| {
        AppError::new(
            "android_unavailable",
            "Native Android services are unavailable.",
        )
    })?;
    native.run_mobile_plugin(command, payload).map_err(|error| {
        if let PluginInvokeError::InvokeRejected(response) = error {
            AppError::new(
                response
                    .code
                    .unwrap_or_else(|| "android_command_failed".into()),
                response
                    .message
                    .unwrap_or_else(|| "Android could not complete the action.".into()),
            )
        } else {
            // Serialization errors may include response data. Do not log them:
            // credential commands carry secrets across this bridge.
            AppError::new(
                "android_command_failed",
                "Android could not complete the action.",
            )
        }
    })
}

#[derive(Deserialize)]
struct PermissionResponse {
    state: String,
}

pub fn microphone_permission_state() -> (String, Option<String>) {
    match invoke::<PermissionResponse>("microphonePermission", ()) {
        Ok(response) if response.state == "granted" => (response.state, None),
        Ok(response) if response.state == "denied" => (
            response.state,
            Some("Microphone access is not allowed. Enable it in Settings for this app.".into()),
        ),
        _ => ("unknown".into(), None),
    }
}

/// Own alongside the cpal stream. Acquisition requests RECORD_AUDIO while
/// foregrounded, then starts the microphone foreground service. Last release
/// removes the service and its notification; failed stream startup releases it too.
pub struct RecordingGuard;

impl RecordingGuard {
    pub fn start() -> Result<Self, AppError> {
        invoke::<()>("startRecording", ())?;
        Ok(Self)
    }
}

impl Drop for RecordingGuard {
    fn drop(&mut self) {
        let _ = invoke::<()>("stopRecording", ());
    }
}

struct AndroidCredentialBuilder;

impl CredentialBuilderApi for AndroidCredentialBuilder {
    fn build(
        &self,
        target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        if service.is_empty() {
            return Err(keyring::Error::Invalid(
                "service".into(),
                "must not be empty".into(),
            ));
        }
        // A tuple preserves boundaries (including absent versus empty target),
        // unlike joining with a separator that could occur in a user name.
        let id = serde_json::to_string(&(target, service, user)).map_err(|_| storage_error())?;
        Ok(Box::new(AndroidCredential { id }))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct AndroidCredential {
    id: String,
}

#[derive(Serialize)]
struct CredentialRequest<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<&'a str>,
}

#[derive(Deserialize)]
struct CredentialResponse {
    found: bool,
    secret: Option<String>,
}

fn storage_error() -> keyring::Error {
    keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
        "Android Keystore credential storage is unavailable",
    )))
}

impl CredentialApi for AndroidCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        let encoded = Zeroizing::new(STANDARD.encode(secret));
        invoke::<()>(
            "credentialSet",
            CredentialRequest {
                id: &self.id,
                secret: Some(encoded.as_str()),
            },
        )
        .map_err(|_| storage_error())
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        let response: CredentialResponse = invoke(
            "credentialGet",
            CredentialRequest {
                id: &self.id,
                secret: None,
            },
        )
        .map_err(|_| storage_error())?;
        if !response.found {
            return Err(keyring::Error::NoEntry);
        }
        let encoded = Zeroizing::new(response.secret.ok_or_else(storage_error)?);
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| storage_error())
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        let response: CredentialResponse = invoke(
            "credentialDelete",
            CredentialRequest {
                id: &self.id,
                secret: None,
            },
        )
        .map_err(|_| storage_error())?;
        if response.found {
            Ok(())
        } else {
            Err(keyring::Error::NoEntry)
        }
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}
