//! Where a connector's secrets live: this device's keychain, and nowhere
//! else. Not the database, not a synchronised row, not a log line, not the
//! webview. The values are wrapped in `Redacted` the moment they are read.
//!
//! Tests run against an in-memory store: a unit test must never write into
//! the developer's real keychain.

use crate::domain::types::AppError;
use crate::redacted::Redacted;

const SERVICE: &str = "xyz.carpediem.subrosa.connectors";

fn keychain_error() -> AppError {
    AppError::new(
        "connector_keychain",
        "Your system credential store is unavailable.",
    )
}

#[cfg(not(test))]
pub fn put(account: &str, value: &str) -> Result<(), AppError> {
    keyring::Entry::new(SERVICE, account)
        .and_then(|entry| entry.set_password(value))
        .map_err(|_| keychain_error())
}

#[cfg(not(test))]
pub fn get(account: &str) -> Result<Option<Redacted<String>>, AppError> {
    match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(Redacted::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(keychain_error()),
    }
}

#[cfg(not(test))]
pub fn remove(account: &str) -> Result<(), AppError> {
    match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(keychain_error()),
    }
}

#[cfg(test)]
fn memory() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, String>> {
    static STORE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::LazyLock::new(Default::default);
    STORE.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
pub fn put(account: &str, value: &str) -> Result<(), AppError> {
    let _ = (SERVICE, keychain_error as fn() -> AppError);
    memory().insert(account.to_string(), value.to_string());
    Ok(())
}

#[cfg(test)]
pub fn get(account: &str) -> Result<Option<Redacted<String>>, AppError> {
    Ok(memory().get(account).cloned().map(Redacted::new))
}

#[cfg(test)]
pub fn remove(account: &str) -> Result<(), AppError> {
    memory().remove(account);
    Ok(())
}

/// The keychain slot of a connector's tokens.
pub fn tokens_slot(connector_id: &str) -> String {
    format!("tokens:{connector_id}")
}

/// The keychain slot of a sign-in waiting for its callback, by its state.
pub fn pending_slot(state: &str) -> String {
    format!("pending:{state}")
}
