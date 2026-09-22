//! How far a note's pipeline has got, for the screen that is waiting on it.
//!
//! A note parked in `transcribing` for eleven minutes looks identical to a
//! note whose pipeline died: a spinner and a word. Everything needed to say
//! more is already in hand while the work runs - how many chunks were cut, how
//! many turns came back - it just never left the process. This is where it is
//! kept so the command layer can hand it to the screen.
//!
//! **Nothing is persisted and nothing is emitted.** Liveness is an in-process
//! question (ADR-0018), the same one [`super::processing::ACTIVE_NOTES`]
//! answers, and `domain::processing` deliberately knows nothing of `tauri` -
//! its tests call it with no app at all - so progress leaves by the same door
//! as `queued_recordings`: a field on `NoteDto`, filled at the command layer,
//! read by the one-second poll the two shells already run.
//!
//! Progress is a sampled quantity rather than a stream: a dropped sample costs
//! one frame of a bar, never correctness.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, MutexGuard},
};

use tokio::sync::Notify;

use crate::domain::types::{AppError, ProcessingPhase, ProcessingProgressDto};

/// The error a pipeline returns when the user stopped it. The command layer
/// turns it into `ProcessingStatus::Stopped` rather than `Failed`.
pub const CANCELLED_CODE: &str = "processing_cancelled";

pub fn cancelled_error() -> AppError {
    AppError::new(CANCELLED_CODE, "Processing was stopped.")
}

struct Run {
    phase: ProcessingPhase,
    /// Units finished in the current phase.
    done: i64,
    /// Units the current phase will do, when that is known before it starts.
    total: Option<i64>,
    started_at: String,
    phase_started_at: String,
    /// Ref count, not a flag: the imported-audio path delegates to the
    /// saved-audio path, so one note legitimately holds two nested claims and
    /// the inner one must not tear down the outer one's run.
    claims: usize,
    /// The user asked to stop. Checked between units of work, so a stop lands
    /// on a boundary where everything already paid for has been kept.
    stopped: bool,
    /// Wakes whatever is waiting on a single long call (the note generation,
    /// which can take minutes) so a stop does not have to wait it out.
    stop: Arc<Notify>,
}

static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn runs() -> MutexGuard<'static, HashMap<String, Run>> {
    RUNS.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A note's progress as it stands, or `None` when no pipeline is running on it
/// in this process.
pub fn snapshot(note_id: &str) -> Option<ProcessingProgressDto> {
    runs().get(note_id).map(|run| ProcessingProgressDto {
        phase: run.phase,
        done: run.done,
        total: run.total,
        started_at: run.started_at.clone(),
        phase_started_at: run.phase_started_at.clone(),
    })
}

/// Fill in what only this process knows about a note: how far its pipeline
/// has got, and how many recordings are stacked behind it. Neither is stored,
/// so every command that hands a `NoteDto` to a screen has to ask.
pub fn fill_live_fields(note: &mut crate::domain::types::NoteDto) {
    use crate::domain::types::ProcessingStatus;

    note.queued_recordings = crate::domain::processing_queue::queued_behind(&note.id);
    note.live.processing_progress = snapshot(&note.id);
    note.live.processing_stalled = matches!(
        note.processing_status,
        ProcessingStatus::Transcribing | ProcessingStatus::Generating
    ) && !crate::domain::processing::is_processing(&note.id)
        && !crate::domain::processing_queue::is_enqueued(&note.id);
}

/// Ask the pipeline running on this note to stop. Returns whether one was
/// running here to ask. Idempotent: a second press changes nothing.
pub fn request_stop(note_id: &str) -> bool {
    let mut runs = runs();
    let Some(run) = runs.get_mut(note_id) else {
        return false;
    };
    run.stopped = true;
    // notify_waiters wakes the ones waiting now; `stopped()` checks the flag
    // after registering, so a waiter that arrives later is not left behind.
    run.stop.notify_waiters();
    true
}

/// RAII claim over a note's progress cell. Held for the length of one pipeline
/// run; the cell disappears when the last claim drops, which is what makes a
/// killed process read as "nothing is running" rather than as a stuck bar.
pub struct ProgressClaim(String);

impl ProgressClaim {
    pub fn begin(note_id: &str) -> Self {
        let stamp = now();
        let mut runs = runs();
        runs.entry(note_id.to_string())
            .and_modify(|run| run.claims += 1)
            .or_insert_with(|| Run {
                phase: ProcessingPhase::Preparing,
                done: 0,
                total: None,
                started_at: stamp.clone(),
                phase_started_at: stamp,
                claims: 1,
                stopped: false,
                stop: Arc::new(Notify::new()),
            });
        Self(note_id.to_string())
    }

    /// A handle the pipeline passes down to whatever is doing the counting.
    pub fn handle(&self) -> Progress {
        Progress::for_note(&self.0)
    }
}

impl Drop for ProgressClaim {
    fn drop(&mut self) {
        let mut runs = runs();
        match runs.get_mut(&self.0) {
            Some(run) if run.claims > 1 => run.claims -= 1,
            _ => {
                runs.remove(&self.0);
            }
        }
    }
}

/// Advances one note's progress. Cloneable and cheap, so a step that counts
/// (the chunk loop, the turn sink) can be handed one without learning where
/// the pipeline keeps its note id.
#[derive(Clone)]
pub struct Progress(String);

impl Progress {
    /// A handle on a note's cell, whether or not one is open. Every method is
    /// a no-op when it is not, so a step deep in the pipeline can report
    /// progress without being handed anything or knowing whether anybody is
    /// watching.
    pub fn for_note(note_id: &str) -> Self {
        Self(note_id.to_string())
    }

    /// Move to a later phase, resetting the count. A phase never goes
    /// backwards: a stage that reports out of order - or a stale task from a
    /// run that is already further along - must not rewind the bar.
    pub fn phase(&self, phase: ProcessingPhase) {
        let stamp = now();
        let mut runs = runs();
        let Some(run) = runs.get_mut(&self.0) else {
            return;
        };
        if phase.rank() <= run.phase.rank() {
            return;
        }
        run.phase = phase;
        run.done = 0;
        run.total = None;
        run.phase_started_at = stamp;
    }

    /// Declare what this phase is going to do, once and before it starts. A
    /// denominator that appears late is better than none; one that moves under
    /// the reader is worse than none.
    pub fn total(&self, total: i64) {
        let mut runs = runs();
        let Some(run) = runs.get_mut(&self.0) else {
            return;
        };
        run.total = Some(total.max(0));
        run.done = run.done.min(total.max(0));
    }

    /// Report that `done` units of this phase are finished.
    pub fn reached(&self, done: i64) {
        let mut runs = runs();
        let Some(run) = runs.get_mut(&self.0) else {
            return;
        };
        run.done = clamp_done(run.done.max(done), run.total);
    }

    /// Whether the user asked this run to stop.
    pub fn is_stopped(&self) -> bool {
        runs().get(&self.0).is_some_and(|run| run.stopped)
    }

    /// `Err(cancelled)` once the user has asked this run to stop, for the `?`
    /// at a boundary between two units of work.
    pub fn check(&self) -> Result<(), AppError> {
        if self.is_stopped() {
            Err(cancelled_error())
        } else {
            Ok(())
        }
    }

    /// Resolves when the user asks this run to stop, for racing a single long
    /// call against. Never resolves for a note nobody is processing.
    pub async fn stopped(&self) {
        let Some(stop) = runs().get(&self.0).map(|run| Arc::clone(&run.stop)) else {
            return std::future::pending().await;
        };
        let notified = stop.notified();
        tokio::pin!(notified);
        // Register before reading the flag, so a stop that lands between the
        // two is seen by one or the other and never missed by both.
        notified.as_mut().enable();
        if self.is_stopped() {
            return;
        }
        notified.await;
    }

    /// One more unit finished.
    pub fn advance(&self) {
        let mut runs = runs();
        let Some(run) = runs.get_mut(&self.0) else {
            return;
        };
        run.done = clamp_done(run.done + 1, run.total);
    }
}

/// The count may not pass the denominator it was given. The turn pipeline ends
/// with a whole-source fallback pass that calls the same sink one extra time,
/// so without this the bar would read "113 of 112".
fn clamp_done(done: i64, total: Option<i64>) -> i64 {
    match total {
        Some(total) => done.min(total),
        None => done,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry is one global, so the tests that write to it take turns.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn there_is_no_progress_until_a_run_claims_the_note() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        assert!(snapshot("note-unclaimed").is_none());
    }

    #[test]
    fn a_claim_opens_a_cell_and_dropping_it_closes_one() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        {
            let claim = ProgressClaim::begin("note-open");
            let seen = snapshot("note-open").expect("a claimed note reports progress");
            assert_eq!(seen.phase, ProcessingPhase::Preparing);
            assert_eq!(seen.done, 0);
            assert_eq!(seen.total, None);
            drop(claim);
        }
        assert!(
            snapshot("note-open").is_none(),
            "a finished run leaves nothing behind, which is what makes a killed \
             process read as stopped rather than stuck"
        );
    }

    #[test]
    fn nested_claims_keep_one_cell() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let outer = ProgressClaim::begin("note-nested");
        outer.handle().phase(ProcessingPhase::Transcribing);
        let inner = ProgressClaim::begin("note-nested");
        drop(inner);
        let seen = snapshot("note-nested").expect("the outer claim still holds the cell");
        assert_eq!(
            seen.phase,
            ProcessingPhase::Transcribing,
            "the inner claim of an import must not reset the run it delegated into"
        );
        drop(outer);
        assert!(snapshot("note-nested").is_none());
    }

    #[test]
    fn a_phase_never_goes_backwards() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let claim = ProgressClaim::begin("note-phases");
        let progress = claim.handle();
        progress.phase(ProcessingPhase::Transcribing);
        progress.total(10);
        progress.reached(4);
        progress.phase(ProcessingPhase::Preparing);
        let seen = snapshot("note-phases").expect("still running");
        assert_eq!(seen.phase, ProcessingPhase::Transcribing);
        assert_eq!(seen.done, 4, "a rewind must not reset the count either");
    }

    #[test]
    fn a_new_phase_starts_its_count_over() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let claim = ProgressClaim::begin("note-restart");
        let progress = claim.handle();
        progress.phase(ProcessingPhase::Transcribing);
        progress.total(3);
        progress.reached(3);
        progress.phase(ProcessingPhase::Composing);
        let seen = snapshot("note-restart").expect("still running");
        assert_eq!((seen.done, seen.total), (0, None));
        assert_eq!(
            seen.started_at,
            snapshot("note-restart").expect("still running").started_at
        );
    }

    #[test]
    fn the_count_only_rises_and_never_passes_the_total() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let claim = ProgressClaim::begin("note-count");
        let progress = claim.handle();
        progress.phase(ProcessingPhase::Transcribing);
        progress.total(2);
        progress.advance();
        progress.advance();
        // The whole-source fallback pass calls the sink once more than there
        // were jobs.
        progress.advance();
        assert_eq!(snapshot("note-count").expect("running").done, 2);

        progress.reached(1);
        assert_eq!(
            snapshot("note-count").expect("running").done,
            2,
            "a late sample from an earlier unit must not pull the bar back"
        );
    }

    #[test]
    fn a_stop_is_seen_by_the_run_and_only_by_that_run() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let claim = ProgressClaim::begin("note-stop");
        let other = ProgressClaim::begin("note-stop-other");
        assert!(claim.handle().check().is_ok());

        assert!(request_stop("note-stop"));
        assert!(claim.handle().is_stopped());
        let error = claim
            .handle()
            .check()
            .expect_err("a stopped run refuses to go on");
        assert_eq!(error.code, CANCELLED_CODE);
        assert!(
            other.handle().check().is_ok(),
            "stopping one note stops only that note"
        );

        drop(claim);
        drop(other);
        assert!(
            !request_stop("note-stop"),
            "nothing left to stop once the run ended"
        );
    }

    #[tokio::test]
    async fn a_stop_wakes_a_run_waiting_on_a_long_call() {
        let claim = {
            let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
            ProgressClaim::begin("note-stop-wait")
        };
        let progress = claim.handle();
        let waiter = tokio::spawn(async move { progress.stopped().await });
        tokio::task::yield_now().await;
        request_stop("note-stop-wait");
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("the stop reached the waiting call")
            .expect("the waiter did not panic");
        drop(claim);
    }

    #[tokio::test]
    async fn a_stop_that_came_first_is_not_missed() {
        let claim = {
            let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
            ProgressClaim::begin("note-stop-early")
        };
        request_stop("note-stop-early");
        tokio::time::timeout(std::time::Duration::from_secs(1), claim.handle().stopped())
            .await
            .expect("a stop requested before anyone waited still resolves the wait");
        drop(claim);
    }

    #[test]
    fn advancing_a_note_nobody_is_processing_is_a_no_op() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let progress = Progress::for_note("note-gone");
        progress.phase(ProcessingPhase::Transcribing);
        progress.total(5);
        progress.advance();
        assert!(snapshot("note-gone").is_none());
    }
}
