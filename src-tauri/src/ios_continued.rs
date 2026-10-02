//! iOS 26 continued processing for a note the user is waiting on (ADR-0071).
//!
//! The grace window `beginBackgroundTask` buys is about thirty seconds, and a
//! meeting takes minutes to transcribe. iOS 26 added the one lever that fits:
//! a `BGContinuedProcessingTask`, which a foreground app submits for work the
//! user just started, which keeps running after the user locks the phone or
//! switches app, and whose progress the system shows on the lock screen. The
//! price is honesty: the task must report progress, and one that looks stalled
//! is expired.
//!
//! This module only *keeps the process alive and shows the bar*. The work
//! stays in the pipeline's own tokio task, behind its durable row and its
//! saved chunks, so an expiration (the system's, or the user's from the lock
//! screen) costs time and never a result: the sweep resumes it at the first
//! unfinished chunk.
//!
//! Everything is looked up at run time. The deployment target is iOS 15, and
//! on a system without the class this is a no-op that leaves the older levers
//! (`beginBackgroundTask`, `BGProcessingTask`) to do what they can.

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::{NSError, NSString};
use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// Must match the wildcard in `BGTaskSchedulerPermittedIdentifiers`.
const IDENTIFIER_PREFIX: &str = "xyz.carpediem.subrosa.transcribe.";

/// `BGContinuedProcessingTaskRequestSubmissionStrategyFail`: if the system
/// cannot start the task now, say so rather than queue it. A queued request
/// would start later, on a note the sweep may already have resumed.
const STRATEGY_FAIL: isize = 0;

/// How often the system's bar is brought up to date. Apple expires tasks that
/// look stalled, and the pipeline's own cell is cheap to read.
const REPORT_EVERY: Duration = Duration::from_secs(1);

/// The bar is in thousandths.
const PROGRESS_UNITS: i64 = 1_000;

/// Notes with a continued task asked for or running. One per note: an import
/// delegates into the recorded path and would otherwise ask twice.
static LIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Makes every identifier unique for the life of the process: registering the
/// same identifier twice is, per the headers, a crash.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn live() -> std::sync::MutexGuard<'static, HashSet<String>> {
    LIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Ask iOS to keep transcribing this note after the user leaves the app.
/// Best effort and silent: on an older iOS, from the background, or when the
/// system declines, nothing happens and the durable path carries on.
pub fn start(note_id: &str, title: &str) {
    let (Some(scheduler), Some(request_class)) = (
        super::ios::shared_scheduler(),
        AnyClass::get(c"BGContinuedProcessingTaskRequest"),
    ) else {
        return;
    };
    if !live().insert(note_id.to_string()) {
        return;
    }
    let identifier = format!(
        "{IDENTIFIER_PREFIX}{}",
        SEQUENCE.fetch_add(1, Ordering::SeqCst)
    );
    if !register(scheduler, &identifier, note_id)
        || !submit(scheduler, request_class, &identifier, title)
    {
        live().remove(note_id);
    }
}

fn register(scheduler: *mut AnyObject, identifier: &str, note_id: &str) -> bool {
    let note_id = note_id.to_string();
    let handler = RcBlock::new(move |task: *mut AnyObject| run(task, note_id.clone()));
    let name = NSString::from_str(identifier);
    // The headers promise a NO for an identifier the plist does not permit,
    // but an Objective-C exception unwinding into Rust is undefined behaviour,
    // so the call is fenced all the same.
    let registered = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let ok: Bool = msg_send![
            scheduler,
            registerForTaskWithIdentifier: &*name,
            usingQueue: std::ptr::null_mut::<AnyObject>(),
            launchHandler: &*handler
        ];
        ok.as_bool()
    }));
    // The scheduler keeps the handler for the life of the process.
    std::mem::forget(handler);
    matches!(registered, Ok(true))
}

fn submit(
    scheduler: *mut AnyObject,
    request_class: &AnyClass,
    identifier: &str,
    title: &str,
) -> bool {
    let subtitle = if title.trim().is_empty() {
        "Sub Rosa"
    } else {
        title.trim()
    };
    let submitted = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let name = NSString::from_str(identifier);
        // The word is the same in both languages the app speaks.
        let heading = NSString::from_str("Transcription");
        let subtitle = NSString::from_str(subtitle);
        let request: *mut AnyObject = msg_send![request_class, alloc];
        let request: *mut AnyObject = msg_send![
            request,
            initWithIdentifier: &*name,
            title: &*heading,
            subtitle: &*subtitle
        ];
        if request.is_null() {
            return false;
        }
        let _: () = msg_send![request, setStrategy: STRATEGY_FAIL];
        let result: Result<(), Retained<NSError>> =
            msg_send![scheduler, submitTaskRequest: request, error: _];
        let _: () = msg_send![request, release];
        result.is_ok()
    }));
    matches!(submitted, Ok(true))
}

/// A running `BGContinuedProcessingTask`, retained across the await.
#[derive(Clone)]
struct ContinuedTask {
    task: *mut AnyObject,
    /// Completion happens once, whether the work or an expiration gets there
    /// first: a second `release` would free the task under the system.
    completed: Arc<AtomicBool>,
}
// Safety: the task is only sent `progress`, `setTaskCompletedWithSuccess:` and
// `release`, all safe from any thread, and `completed` makes the last two run
// once however many threads race to them.
unsafe impl Send for ContinuedTask {}
unsafe impl Sync for ContinuedTask {}

impl ContinuedTask {
    fn report(&self, done: i64) {
        unsafe {
            let progress: *mut AnyObject = msg_send![self.task, progress];
            if progress.is_null() {
                return;
            }
            let _: () = msg_send![progress, setTotalUnitCount: PROGRESS_UNITS];
            let _: () = msg_send![progress, setCompletedUnitCount: done.clamp(0, PROGRESS_UNITS)];
        }
    }

    fn complete(&self, success: bool) {
        if self.completed.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            let _: () = msg_send![self.task, setTaskCompletedWithSuccess: success];
            let _: () = msg_send![self.task, release];
        }
    }

    fn is_completed(&self) -> bool {
        self.completed.load(Ordering::SeqCst)
    }
}

/// The system started the task. Mirror the note's progress into it until the
/// pipeline lets go of the note, then hand it back.
fn run(task: *mut AnyObject, note_id: String) {
    if task.is_null() {
        live().remove(&note_id);
        return;
    }
    let handle = unsafe {
        let _: *mut AnyObject = msg_send![task, retain];
        ContinuedTask {
            task,
            completed: Arc::new(AtomicBool::new(false)),
        }
    };
    // Expired by the system or cancelled from the lock screen. Either way the
    // work is paused, not lost: the chunks are saved and the sweep resumes
    // the note when the app next runs.
    let on_expiry = handle.clone();
    unsafe {
        let expiration = RcBlock::new(move || on_expiry.complete(false));
        let _: () = msg_send![task, setExpirationHandler: &*expiration];
        std::mem::forget(expiration);
    }
    tauri::async_runtime::spawn(async move {
        while !handle.is_completed() {
            match crate::domain::processing_progress::snapshot(&note_id) {
                Some(progress) => handle.report(
                    crate::domain::processing_progress::overall_fraction(&progress, PROGRESS_UNITS),
                ),
                None if !crate::domain::processing::is_processing(&note_id)
                    && !crate::domain::processing_queue::is_enqueued(&note_id) =>
                {
                    handle.report(PROGRESS_UNITS);
                    handle.complete(true);
                }
                None => {}
            }
            tokio::time::sleep(REPORT_EVERY).await;
        }
        live().remove(&note_id);
    });
}
