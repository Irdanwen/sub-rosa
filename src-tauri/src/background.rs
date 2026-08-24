//! The durable-work sweep: everything that must finish even if the app is
//! suspended, killed, or reinstalled between the start and the end of it.
//!
//! iOS gives no guarantee that a running future survives the user locking the
//! screen ([`crate::ios_background`] buys a window, not immortality), and the
//! webview is frozen outright while the app is away — so nothing long-running
//! may live in a JavaScript promise or in a bare tokio task. The rule this
//! module enforces is:
//!
//! > Every operation that can outlast a foreground session writes a row first,
//! > and the row — not the task — is the source of truth.
//!
//! [`sweep`] re-drives all of those rows. It runs on cold launch, on
//! `RunEvent::Resumed`, and from the iOS BGTaskScheduler launch handlers, so a
//! generation queued before locking the phone lands whether the user comes back
//! in ten seconds or tomorrow. Every step is idempotent: sweeping twice must
//! never duplicate work.
//!
//! The module is cross-platform on purpose. Desktop has no suspension problem,
//! but it does get killed, and the same sweep turns "the app quit mid-render"
//! into "the render finished on next launch".

use tauri::AppHandle;

/// Re-drive every durable queue. Safe to call concurrently with itself; each
/// queue de-duplicates its own in-flight work.
pub async fn sweep(app: &AppHandle) {
    // Notes killed in transit (recorded audio is on disk, the note row is
    // stuck in `transcribing`/`generating`). Mobile only: desktop is not
    // suspended out from under a running pipeline, and auto-retrying there
    // would change how the existing "retry processing" affordance behaves.
    #[cfg(mobile)]
    crate::commands::resume_interrupted_processing(app);
    // Studio generations already queued (and paid for) upstream: poll, download
    // and file them in the gallery.
    crate::carpe_diem::jobs::resume_all(app).await;
    // A dictation whose transcription never came back.
    #[cfg(mobile)]
    crate::dictation_mobile::resume_pending(app).await;
    // A chat turn cut off between the user's message and the reply.
    #[cfg(mobile)]
    crate::agent_lite::resume_interrupted_turns(app).await;
    // A link the user pasted whose download never finished. Cross-platform:
    // the desktop gets killed mid-download too.
    crate::ingest::resume_unfinished(app).await;
    // A long-form summary is a dozen model calls over several minutes, which
    // on iOS is several lifetimes of a foreground session. Cross-platform on
    // purpose: the desktop gets killed too.
    crate::longform::resume_unfinished(app).await;
    crate::shotlist::resume_unfinished(app).await;
    // The moments the app speaks first: schedule the briefs for the meetings
    // ahead, deliver the ones that came due while we were away. A row, never
    // a timer — which is exactly why it belongs in this sweep.
    crate::moments::tick(app).await;
    // Keep the system index honest about what exists. Cheap (titles and
    // dates unless the user opted the body in) and idempotent.
    crate::spotlight::reindex_all(app).await;
}

/// Fire-and-forget [`sweep`], for call sites that are not async (app setup, the
/// `Resumed` run event).
pub fn sweep_detached(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sweep(&app).await;
    });
}

/// Whether anything is waiting on us right now. Deliberately cheap and
/// in-memory: iOS asks this while handling a lifecycle notification, and
/// waking the app up for a background window that finds nothing to do costs
/// future scheduling priority.
pub fn has_pending_work() -> bool {
    crate::ios_background::work_in_flight() || crate::carpe_diem::jobs::has_active()
}
