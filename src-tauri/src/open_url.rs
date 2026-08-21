//! Opens https links outside the app.
//!
//! Neither webview honors `target="_blank"` (no new-window handler is
//! installed), so every outbound link in chat content routes through this
//! command: the default browser on desktop, Safari on iOS. https only — chat
//! blocks and markdown links carry model-authored URLs, and this is the last
//! gate before they leave the app.

use crate::domain::types::AppError;
use tauri::AppHandle;

const MAX_URL_LEN: usize = 2048;

fn validated(url: &str) -> Result<&str, AppError> {
    let trimmed = url.trim();
    let scheme_ok = trimmed
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        && trimmed.len() > 8;
    if !scheme_ok
        || trimmed.len() > MAX_URL_LEN
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::new(
            "open_url_rejected",
            "Only https links can be opened.",
        ));
    }
    Ok(trimmed)
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), AppError> {
    let target = validated(&url)?.to_string();
    #[cfg(not(target_os = "ios"))]
    {
        let _ = &app;
        crate::os_accounts::open_in_browser(&target)
    }
    #[cfg(target_os = "ios")]
    {
        open_in_safari(app, target)
    }
}

/// `UIApplication openURL:` bridged the same way as the share sheet
/// (share_ios.rs): best-effort UIKit calls on the main thread, nothing to
/// clean up.
#[cfg(target_os = "ios")]
fn open_in_safari(app: AppHandle, url: String) -> Result<(), AppError> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;

    app.run_on_main_thread(move || unsafe {
        let Some(app_class) = AnyClass::get(c"UIApplication") else {
            return;
        };
        let shared: *mut AnyObject = msg_send![app_class, sharedApplication];
        if shared.is_null() {
            return;
        }
        let Some(url_class) = AnyClass::get(c"NSURL") else {
            return;
        };
        let string = NSString::from_str(&url);
        let nsurl: *mut AnyObject = msg_send![url_class, URLWithString: &*string];
        if nsurl.is_null() {
            return;
        }
        // nil options (empty dictionary semantics) and nil completion are
        // both sanctioned by UIKit.
        let _: () = msg_send![
            shared,
            openURL: nsurl,
            options: std::ptr::null_mut::<AnyObject>(),
            completionHandler: std::ptr::null_mut::<AnyObject>()
        ];
    })
    .map_err(|error| AppError::new("open_url_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::validated;

    #[test]
    fn accepts_plain_https() {
        assert!(validated("https://example.com/page?q=1").is_ok());
        assert!(validated("  https://example.com  ").is_ok());
        assert!(validated("HTTPS://example.com").is_ok());
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [
            "http://example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "https://exa mple.com",
            "https://example.com/\u{7}",
            "",
        ] {
            assert!(validated(bad).is_err(), "should reject {bad:?}");
        }
        let oversized = format!("https://example.com/{}", "a".repeat(3000));
        assert!(validated(&oversized).is_err());
    }
}
