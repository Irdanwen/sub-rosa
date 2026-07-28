//! iOS background-execution coordinator.
//!
//! iOS never lets an app "just keep running" once the user locks the screen or
//! switches away. It offers exactly three levers, and Sub Rosa uses all three:
//!
//! 1. `beginBackgroundTask` — one grace window (~30 s on current iOS) after the
//!    app leaves the foreground. Every in-flight unit of work holds a
//!    [`BackgroundTask`] guard; the guards are ref-counted onto a *single*
//!    UIKit task, so ten parallel jobs claim one window instead of ten.
//! 2. `UIBackgroundModes: audio` — unlimited runtime while the audio session is
//!    actually recording or playing (`audio/ios_session.rs`). A note recording
//!    therefore never stops, and whatever else is running rides along with it.
//! 3. `BGTaskScheduler` — the sanctioned way to get minutes of runtime *later*.
//!    Leaving the foreground with work still pending submits a refresh and a
//!    processing request; their launch handlers re-run [`crate::background`]'s
//!    sweep, the same one the app runs on cold launch and on `Resumed`.
//!
//! What makes the whole thing safe is that **no unit of work depends on staying
//! alive**: notes, media jobs and dictations are durable rows, so a suspension
//! costs time, never a result ([`crate::background`]). The guards and the BG
//! requests only shorten how long the user waits for it.
//!
//! Everything here is a no-op off iOS so call sites stay unconditional.

/// RAII guard over the shared UIKit background task. Hold one for the whole
/// duration of anything that must not be cut in half by a screen lock; drop it
/// (or let the system's grace period expire) to give the window back.
pub struct BackgroundTask {
    /// Zero-sized: the ref-count lives in [`ios`], the guard only releases it.
    _private: (),
}

impl BackgroundTask {
    /// Best-effort: failing to open a background task never blocks the work it
    /// protects. `name` labels the UIKit task for debugging and is only used
    /// when this guard is the one that opens it.
    pub fn begin(name: &str) -> Self {
        #[cfg(target_os = "ios")]
        ios::retain(name);
        #[cfg(not(target_os = "ios"))]
        let _ = name;
        Self { _private: () }
    }
}

impl Drop for BackgroundTask {
    fn drop(&mut self) {
        #[cfg(target_os = "ios")]
        ios::release();
    }
}

/// Whether any [`BackgroundTask`] guard is currently held — that is, whether
/// some request, transcription or tool loop is mid-flight right now.
pub fn work_in_flight() -> bool {
    #[cfg(target_os = "ios")]
    {
        ios::active_guards() > 0
    }
    #[cfg(not(target_os = "ios"))]
    {
        false
    }
}

/// Install the lifecycle observers and register the BGTaskScheduler launch
/// handlers. Must run during app setup: `BGTaskScheduler` refuses (and throws)
/// registrations made after the app has finished launching.
#[allow(unused_variables)]
pub fn setup(app: &tauri::AppHandle) {
    #[cfg(target_os = "ios")]
    ios::setup(app);
}

#[cfg(target_os = "ios")]
mod ios {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSError, NSString};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;

    /// UIBackgroundTaskInvalid (NSUIntegerMax).
    const INVALID: usize = usize::MAX;

    /// BGTaskScheduler identifiers. These must also be listed in the app's
    /// `BGTaskSchedulerPermittedIdentifiers` (Info.plist) or registration
    /// fails at launch.
    const REFRESH_IDENTIFIER: &str = "xyz.carpediem.subrosa.refresh";
    const PROCESSING_IDENTIFIER: &str = "xyz.carpediem.subrosa.processing";

    /// Ask for the soonest slot the scheduler will consider. The system
    /// ultimately decides; this is a floor, not a promise.
    const EARLIEST_BEGIN_SECONDS: f64 = 60.0;

    /// Outstanding guards. The UIKit task opens on the first one and closes
    /// when the last is dropped.
    static ACTIVE_GUARDS: AtomicUsize = AtomicUsize::new(0);
    /// The single shared UIKit task id, or [`INVALID`] when none is open.
    static TASK_ID: AtomicUsize = AtomicUsize::new(INVALID);
    /// Serializes open/close so a retain racing a release cannot leave the
    /// counter and the task id disagreeing.
    static TASK_LOCK: Mutex<()> = Mutex::new(());
    /// Set once at setup so the notification and launch handlers — which run
    /// on system queues, outside any command — can reach the app.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TASK_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn active_guards() -> usize {
        ACTIVE_GUARDS.load(Ordering::SeqCst)
    }

    pub fn retain(name: &str) {
        let _guard = lock();
        ACTIVE_GUARDS.fetch_add(1, Ordering::SeqCst);
        // Open whenever no task is live rather than only on 0 -> 1: after an
        // expiration the counter can still be positive, and the next piece of
        // work deserves a fresh window.
        if TASK_ID.load(Ordering::SeqCst) == INVALID {
            open(name);
        }
    }

    pub fn release() {
        let _guard = lock();
        if ACTIVE_GUARDS.fetch_sub(1, Ordering::SeqCst) == 1 {
            close();
        }
    }

    /// Coming back to the foreground with work still outstanding but no live
    /// task (the previous one expired): claim a new window.
    fn reopen_if_needed() {
        let _guard = lock();
        if ACTIVE_GUARDS.load(Ordering::SeqCst) > 0 && TASK_ID.load(Ordering::SeqCst) == INVALID {
            open("sub-rosa-work");
        }
    }

    fn shared_application() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"UIApplication")?;
        let shared: *mut AnyObject = unsafe { msg_send![class, sharedApplication] };
        (!shared.is_null()).then_some(shared)
    }

    fn open(name: &str) {
        let Some(shared) = shared_application() else {
            return;
        };
        // begin/endBackgroundTask are documented thread-safe, so no main-thread
        // hop: guards are taken on tokio workers.
        unsafe {
            // UIKit kills apps that let the grace period lapse without ending
            // the task, so the handler is mandatory in practice.
            let handler = RcBlock::new(expire);
            let label = NSString::from_str(name);
            let id: usize = msg_send![
                shared,
                beginBackgroundTaskWithName: &*label,
                expirationHandler: &*handler
            ];
            if id != INVALID {
                TASK_ID.store(id, Ordering::SeqCst);
            }
        }
    }

    fn close() {
        let id = TASK_ID.swap(INVALID, Ordering::SeqCst);
        if id != INVALID {
            end_task(id);
        }
    }

    /// The system is out of patience. End the task so we are suspended rather
    /// than killed; the work itself keeps its durable row and resumes later.
    fn expire() {
        let id = TASK_ID.swap(INVALID, Ordering::SeqCst);
        if id != INVALID {
            end_task(id);
        }
    }

    fn end_task(id: usize) {
        let Some(shared) = shared_application() else {
            return;
        };
        unsafe {
            let _: () = msg_send![shared, endBackgroundTask: id];
        }
    }

    // --- BGTaskScheduler ----------------------------------------------------

    pub fn setup(app: &AppHandle) {
        let _ = APP.set(app.clone());
        register_launch_handlers();
        install_lifecycle_observers();
    }

    fn shared_scheduler() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"BGTaskScheduler")?;
        let scheduler: *mut AnyObject = unsafe { msg_send![class, sharedScheduler] };
        (!scheduler.is_null()).then_some(scheduler)
    }

    fn register_launch_handlers() {
        let Some(scheduler) = shared_scheduler() else {
            return;
        };
        for identifier in [REFRESH_IDENTIFIER, PROCESSING_IDENTIFIER] {
            let handler = RcBlock::new(move |task: *mut AnyObject| run_launch_handler(task));
            let name = NSString::from_str(identifier);
            unsafe {
                let _: Bool = msg_send![
                    scheduler,
                    registerForTaskWithIdentifier: &*name,
                    usingQueue: std::ptr::null_mut::<AnyObject>(),
                    launchHandler: &*handler
                ];
            }
            // The handler outlives this call by design (process-lifetime).
            std::mem::forget(handler);
        }
    }

    /// A `BGTask` pointer moved onto the tokio runtime. The system keeps the
    /// task alive until `setTaskCompletedWithSuccess:`, and we retain it on top
    /// so the pointer stays valid across the await.
    #[derive(Clone, Copy)]
    struct TaskHandle(*mut AnyObject);
    // Safety: BGTask's only use here is the two completion selectors, both of
    // which are safe to send from any thread.
    unsafe impl Send for TaskHandle {}

    impl TaskHandle {
        fn complete(self, success: bool) {
            unsafe {
                let _: () = msg_send![self.0, setTaskCompletedWithSuccess: success];
                let _: () = msg_send![self.0, release];
            }
        }
    }

    /// The system woke us up (possibly into a fresh process) to make progress.
    /// Run the durable sweep and report back — every path must reach
    /// `setTaskCompletedWithSuccess:` or iOS stops scheduling us.
    fn run_launch_handler(task: *mut AnyObject) {
        if task.is_null() {
            return;
        }
        let handle = unsafe {
            let _: *mut AnyObject = msg_send![task, retain];
            TaskHandle(task)
        };
        // A fired request is consumed; queue the next one straight away so a
        // sweep that runs out of time is picked up again later.
        schedule_requests();

        let Some(app) = APP.get().cloned() else {
            handle.complete(false);
            return;
        };
        // Expiring mid-sweep is normal: the durable rows survive, so report
        // success and let the next window continue.
        unsafe {
            let expiration = RcBlock::new(move || handle.complete(true));
            let _: () = msg_send![task, setExpirationHandler: &*expiration];
            std::mem::forget(expiration);
        }
        tauri::async_runtime::spawn(async move {
            crate::background::sweep(&app).await;
            handle.complete(true);
        });
    }

    /// Ask the system for more runtime later, but only when something is
    /// actually waiting: waking up with nothing to do costs future priority.
    fn schedule_requests() {
        if !crate::background::has_pending_work() {
            return;
        }
        submit(PROCESSING_IDENTIFIER, c"BGProcessingTaskRequest");
        submit(REFRESH_IDENTIFIER, c"BGAppRefreshTaskRequest");
    }

    fn submit(identifier: &str, class_name: &std::ffi::CStr) {
        let (Some(scheduler), Some(class)) = (shared_scheduler(), AnyClass::get(class_name)) else {
            return;
        };
        unsafe {
            let name = NSString::from_str(identifier);
            let request: *mut AnyObject = msg_send![class, alloc];
            let request: *mut AnyObject = msg_send![request, initWithIdentifier: &*name];
            if request.is_null() {
                return;
            }
            if class_name == c"BGProcessingTaskRequest" {
                // Everything we resume is a network round-trip; running without
                // connectivity would burn the window for nothing. External
                // power is not required — that would defer most wake-ups to
                // overnight charging.
                let _: () = msg_send![request, setRequiresNetworkConnectivity: true];
                let _: () = msg_send![request, setRequiresExternalPower: false];
            }
            if let Some(date_class) = AnyClass::get(c"NSDate") {
                let date: *mut AnyObject =
                    msg_send![date_class, dateWithTimeIntervalSinceNow: EARLIEST_BEGIN_SECONDS];
                let _: () = msg_send![request, setEarliestBeginDate: date];
            }
            // Submitting over a pending request with the same identifier
            // replaces it, so re-submitting on every background entry is safe.
            let result: Result<(), Retained<NSError>> =
                msg_send![scheduler, submitTaskRequest: request, error: _];
            let _ = result;
            let _: () = msg_send![request, release];
        }
    }

    // --- lifecycle ----------------------------------------------------------

    fn install_lifecycle_observers() {
        observe("UIApplicationDidEnterBackgroundNotification", || {
            schedule_requests();
        });
        observe("UIApplicationWillEnterForegroundNotification", || {
            reopen_if_needed();
        });
    }

    /// Subscribe to a named notification for the process lifetime. Mirrors
    /// `audio::ios_session::install_interruption_observer`; the block leaks by
    /// design.
    fn observe(name: &str, handler: fn()) {
        let Some(center_class) = AnyClass::get(c"NSNotificationCenter") else {
            return;
        };
        unsafe {
            let center: *mut AnyObject = msg_send![center_class, defaultCenter];
            if center.is_null() {
                return;
            }
            let name = NSString::from_str(name);
            let block = RcBlock::new(move |_notification: *mut AnyObject| handler());
            let _observer: *mut AnyObject = msg_send![
                center,
                addObserverForName: &*name,
                object: std::ptr::null_mut::<AnyObject>(),
                queue: std::ptr::null_mut::<AnyObject>(),
                usingBlock: &*block
            ];
            std::mem::forget(block);
        }
    }
}
