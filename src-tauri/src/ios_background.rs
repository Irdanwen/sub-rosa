//! iOS background-execution guard for in-flight AI turns.
//!
//! Locking the screen suspends the process, which drops any in-flight
//! chat/tool request and surfaced as a network error when the phone woke
//! up. Holding a UIKit background task while a turn runs buys ~30 s of
//! wall clock after the lock, enough for most replies to land; anything
//! longer is recovered by the transport retry in `june_api`.
//!
//! The guard is a no-op off iOS so call sites stay unconditional.

/// RAII guard: the background task ends when the guard drops (or when the
/// system's grace period expires, whichever comes first).
pub struct BackgroundTask {
    /// Held only for its Drop (which ends the UIKit task), never read.
    #[cfg(target_os = "ios")]
    _task: Option<ios::Task>,
}

impl BackgroundTask {
    /// Best-effort: a failure to open a background task never blocks the
    /// request it protects.
    pub fn begin(name: &str) -> Self {
        #[cfg(target_os = "ios")]
        {
            Self {
                _task: ios::Task::begin(name),
            }
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = name;
            Self {}
        }
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// UIBackgroundTaskInvalid (NSUIntegerMax).
    const INVALID: usize = usize::MAX;

    pub struct Task {
        /// Shared with the expiration handler so whichever side ends the
        /// task first (drop or expiry) wins and the other becomes a no-op.
        ident: Arc<AtomicUsize>,
    }

    impl Task {
        pub fn begin(name: &str) -> Option<Self> {
            let ident = Arc::new(AtomicUsize::new(INVALID));
            let for_expiry = Arc::clone(&ident);
            // begin/endBackgroundTask are documented thread-safe, so no
            // main-thread hop: the guard is created on tokio workers.
            unsafe {
                let app_class = AnyClass::get(c"UIApplication")?;
                let shared: *mut AnyObject = msg_send![app_class, sharedApplication];
                if shared.is_null() {
                    return None;
                }
                // UIKit kills apps that let the grace period lapse without
                // ending the task; the handler is mandatory in practice.
                let handler = RcBlock::new(move || end(&for_expiry));
                let label = NSString::from_str(name);
                let id: usize = msg_send![
                    shared,
                    beginBackgroundTaskWithName: &*label,
                    expirationHandler: &*handler
                ];
                if id == INVALID {
                    return None;
                }
                ident.store(id, Ordering::SeqCst);
            }
            Some(Self { ident })
        }
    }

    impl Drop for Task {
        fn drop(&mut self) {
            end(&self.ident);
        }
    }

    fn end(ident: &AtomicUsize) {
        let id = ident.swap(INVALID, Ordering::SeqCst);
        if id == INVALID {
            return;
        }
        unsafe {
            let Some(app_class) = AnyClass::get(c"UIApplication") else {
                return;
            };
            let shared: *mut AnyObject = msg_send![app_class, sharedApplication];
            if shared.is_null() {
                return;
            }
            let _: () = msg_send![shared, endBackgroundTask: id];
        }
    }
}
