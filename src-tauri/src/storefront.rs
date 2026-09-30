//! Where this copy of the app was bought, as far as the platform will say.
//!
//! App stores decide whether an app may point to a purchase outside them, and
//! they decide it per storefront country. The webview's pay-link policy
//! (`src/lib/store-policy.ts`) needs two facts it cannot read itself: which
//! store installed the app, and which storefront the person is on. Anything
//! unknown stays unknown here; the policy treats unknown as "no link".
use serde::Serialize;

use crate::domain::types::AppError;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreContext {
    /// `"desktop"`, `"ios"` or `"android"`.
    pub platform: &'static str,
    /// `"app-store"`, `"play"`, `"direct"` or `"unknown"`.
    pub distribution: &'static str,
    /// ISO 3166-1 alpha-2, when the store says.
    pub storefront: Option<String>,
}

/// StoreKit reports alpha-3 codes. Only the countries a policy can hinge on
/// need a name here: the one storefront where a link is allowed, and the
/// countries where Carpe Diem sells nothing. Anything else reads as unknown,
/// which is the conservative answer.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn alpha2_from_alpha3(code: &str) -> Option<&'static str> {
    Some(match code.trim().to_ascii_uppercase().as_str() {
        "USA" => "US",
        "IRN" => "IR",
        "PRK" => "KP",
        "CUB" => "CU",
        "SYR" => "SY",
        "SDN" => "SD",
        "SSD" => "SS",
        "MMR" => "MM",
        "RUS" => "RU",
        "BLR" => "BY",
        "CHE" => "CH",
        "FRA" => "FR",
        "DEU" => "DE",
        "GBR" => "GB",
        "CAN" => "CA",
        _ => return None,
    })
}

/// What the installer package name says about distribution on Android.
#[cfg(any(target_os = "android", test))]
pub(crate) fn android_distribution(installer: Option<&str>) -> &'static str {
    match installer {
        Some("com.android.vending") => "play",
        // Sideloaded from a file, a browser or adb: installed from the
        // project's own releases.
        Some(
            "com.google.android.packageinstaller"
            | "com.android.packageinstaller"
            | "com.android.shell",
        ) => "direct",
        None => "direct",
        Some(_) => "unknown",
    }
}

#[cfg(target_os = "ios")]
fn ios_storefront() -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    // StoreKit is a system framework the Xcode project does not link; loading
    // it here keeps the app free of a new link-time dependency for one read.
    let path = c"/System/Library/Frameworks/StoreKit.framework/StoreKit";
    // SAFETY: dlopen of a system framework path with a constant C string.
    let handle = unsafe { libc_dlopen(path.as_ptr(), 1) };
    if handle.is_null() {
        return None;
    }
    // SAFETY: plain Objective-C getters on StoreKit's shared payment queue,
    // available since iOS 13; every pointer is checked before use.
    unsafe {
        let class = AnyClass::get(c"SKPaymentQueue")?;
        let queue: *mut AnyObject = msg_send![class, defaultQueue];
        if queue.is_null() {
            return None;
        }
        let storefront: *mut AnyObject = msg_send![queue, storefront];
        if storefront.is_null() {
            return None;
        }
        let code: *mut NSString = msg_send![storefront, countryCode];
        if code.is_null() {
            return None;
        }
        alpha2_from_alpha3(&(*code).to_string()).map(str::to_string)
    }
}

#[cfg(target_os = "ios")]
extern "C" {
    #[link_name = "dlopen"]
    fn libc_dlopen(path: *const std::ffi::c_char, mode: i32) -> *mut std::ffi::c_void;
}

#[derive(serde::Deserialize)]
#[cfg(target_os = "android")]
struct InstallSource {
    installer: Option<String>,
}

#[tauri::command]
pub async fn store_context() -> Result<StoreContext, AppError> {
    #[cfg(target_os = "ios")]
    {
        let storefront = tokio::task::spawn_blocking(ios_storefront)
            .await
            .ok()
            .flatten();
        return Ok(StoreContext {
            platform: "ios",
            distribution: "app-store",
            storefront,
        });
    }
    #[cfg(target_os = "android")]
    {
        // A bridge that cannot answer is not a sideload: unknown, no link.
        let distribution = match crate::android::invoke::<InstallSource>("installSource", ()) {
            Ok(source) => android_distribution(source.installer.as_deref()),
            Err(_) => "unknown",
        };
        return Ok(StoreContext {
            platform: "android",
            distribution,
            storefront: None,
        });
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Ok(StoreContext {
        platform: "desktop",
        distribution: "direct",
        storefront: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storekit_codes_become_alpha2_or_nothing() {
        assert_eq!(alpha2_from_alpha3("USA"), Some("US"));
        assert_eq!(alpha2_from_alpha3("usa"), Some("US"));
        assert_eq!(alpha2_from_alpha3("CHE"), Some("CH"));
        assert_eq!(alpha2_from_alpha3("ZZZ"), None);
    }

    #[test]
    fn the_installer_names_the_distribution() {
        assert_eq!(android_distribution(Some("com.android.vending")), "play");
        assert_eq!(android_distribution(None), "direct");
        assert_eq!(
            android_distribution(Some("com.google.android.packageinstaller")),
            "direct"
        );
        assert_eq!(android_distribution(Some("com.amazon.venezia")), "unknown");
    }
}
