//! iOS: hide WKWebView's keyboard form-assistant bar.
//!
//! When a web text field is focused, WKWebView shows a native accessory bar
//! above the keyboard: the prev/next chevrons and a "Done" button. Sub Rosa's
//! chat and note inputs have no use for it (a single field per screen, and the
//! webview drives its own submit), so it is just chrome that steals a strip of
//! screen. WebKit vends the bar from `-[WKContentView inputAccessoryView]`;
//! swizzling that to return nil removes it (the long-standing approach, same as
//! Capacitor's `hideFormAccessoryBar`).
//!
//! Best-effort: installed once at launch. If the private `WKContentView` class
//! can't be found (a WebKit rename), it degrades to a no-op rather than
//! crashing, and the bar simply stays.

use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::sel;

/// Signature of `-[WKContentView inputAccessoryView]`: `id (id self, SEL)`.
type InputAccessoryImp = unsafe extern "C-unwind" fn(&AnyObject, Sel) -> *mut AnyObject;

/// The replacement getter: no accessory view, so no keyboard bar.
extern "C-unwind" fn no_input_accessory_view(_this: &AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

/// Swizzle `-[WKContentView inputAccessoryView]` to return nil. Call once from
/// the iOS setup hook, after the main webview exists (which registers the
/// WebKit classes). `WKContentView` overrides `inputAccessoryView` itself — the
/// override is what shows the bar — so this resolves to its own method and the
/// swizzle stays scoped to that class rather than an inherited `UIResponder`
/// one.
pub fn hide_form_assistant_bar() {
    unsafe {
        let Some(class) = AnyClass::get(c"WKContentView") else {
            return;
        };
        let Some(method) = class.instance_method(sel!(inputAccessoryView)) else {
            return;
        };
        let replacement: objc2::runtime::Imp =
            std::mem::transmute(no_input_accessory_view as InputAccessoryImp);
        let _previous = method.set_implementation(replacement);
    }
}
