//! Proposed actions: the assistant can do things, and only ever after a tap.
//!
//! Two rules shape everything here.
//!
//! **Nothing executes without an explicit gesture.** The assistant proposes
//! — a follow-up in the calendar, a reminder, a line added to a note — and
//! the card in the reply is a button, never a receipt. There is no
//! "auto-apply", no undo-only flow, and no action that runs because a model
//! was confident.
//!
//! **The "done" state cannot live in the message.** A chat block is text
//! inside an immutable message (ADR-0024): re-open the conversation tomorrow
//! and the card would offer the same button for something already done. So
//! the state lives beside it, in a durable row keyed by the proposal, and the
//! card reads it. That is the ADR-0018 pattern applied to an interface: the
//! row is the truth, the text is only how it was proposed.
//!
//! One surface, N actions. Adding a kind means one arm here and one label in
//! the card — never a new confirmation screen.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Text bounds. Everything here arrives from a model.
const MAX_LABEL: usize = 200;
const MAX_BODY: usize = 4_000;

/// `rename_all` renames the *variants*; `rename_all_fields` renames what is
/// inside them. Both are needed, and the second was missing: the card has
/// always written `noteId` (so does the prompt in `hermes_bridge.rs`), while
/// this expected `note_id`, so tapping a note-append card failed at the IPC
/// boundary rather than doing anything. `reminder` and `event` were unaffected
/// only because every one of their fields is a single word.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ProposedAction {
    /// A reminder in the system list.
    Reminder {
        id: String,
        label: String,
        /// RFC3339. Optional: a reminder with no date is still a reminder.
        #[serde(default)]
        due: Option<String>,
    },
    /// A follow-up in the calendar.
    Event {
        id: String,
        label: String,
        start: String,
        #[serde(default)]
        end: Option<String>,
    },
    /// A line appended to one of the user's own notes.
    Note {
        id: String,
        label: String,
        note_id: String,
        text: String,
    },
    /// A long-form reading of one of the user's recordings (ADR-0027).
    ///
    /// Here rather than as a tool because it costs several model calls: a tap
    /// is the right gate for spending the user's money, and this module is
    /// already the place where nothing runs without one.
    Summarize {
        id: String,
        label: String,
        note_id: String,
    },
    /// A link fetched and turned into a note (ADR-0028).
    ImportLink {
        id: String,
        label: String,
        url: String,
    },
}

impl ProposedAction {
    pub fn id(&self) -> &str {
        match self {
            Self::Reminder { id, .. }
            | Self::Event { id, .. }
            | Self::Note { id, .. }
            | Self::Summarize { id, .. }
            | Self::ImportLink { id, .. } => id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Reminder { .. } => "reminder",
            Self::Event { .. } => "event",
            Self::Note { .. } => "note",
            Self::Summarize { .. } => "summarize",
            Self::ImportLink { .. } => "importLink",
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Reminder { label, .. }
            | Self::Event { label, .. }
            | Self::Note { label, .. }
            | Self::Summarize { label, .. }
            | Self::ImportLink { label, .. } => label,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionState {
    pub action_id: String,
    /// "done" or "failed". A proposal with no row has not been acted on.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Trims model-authored text to something a system list can hold.
pub fn clean_label(raw: &str, max: usize) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > max {
        text.chars().take(max).collect::<String>() + "…"
    } else {
        text.to_string()
    })
}

fn epoch_from_rfc3339(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|parsed| parsed.timestamp())
}

// --- Commands ----------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteActionRequest {
    /// The block that proposed it, so the card can find the state again.
    pub proposal_id: String,
    pub action: ProposedAction,
}

/// Performs one proposed action and records that it happened.
///
/// The row is written only on success: a failure leaves the card offering
/// the button again, which is the honest state — nothing happened.
#[tauri::command]
pub async fn action_execute(
    app: AppHandle,
    request: ExecuteActionRequest,
) -> Result<ActionState, AppError> {
    let action = request.action;
    let label = clean_label(action.label(), MAX_LABEL)
        .ok_or_else(|| AppError::new("action_invalid", "That action has nothing to do."))?;

    let detail = match &action {
        ProposedAction::Reminder { due, .. } => {
            let due_at = due.as_deref().and_then(epoch_from_rfc3339);
            eventkit::create_reminder(&label, due_at)?
        }
        ProposedAction::Event { start, end, .. } => {
            let start_at = epoch_from_rfc3339(start)
                .ok_or_else(|| AppError::new("action_invalid", "That date could not be read."))?;
            let end_at = end
                .as_deref()
                .and_then(epoch_from_rfc3339)
                // A follow-up with no end is half an hour, the length of the
                // meeting people actually book.
                .unwrap_or(start_at + 30 * 60);
            eventkit::create_event(&label, start_at, end_at)?
        }
        ProposedAction::Note { note_id, text, .. } => {
            let body = clean_label(text, MAX_BODY)
                .ok_or_else(|| AppError::new("action_invalid", "There is nothing to write."))?;
            let repos = crate::commands::repositories(&app).await?;
            repos
                .append_to_note_content(note_id, &body)
                .await
                .map_err(|error| AppError::new("action_note_failed", error.to_string()))?;
            None
        }
        ProposedAction::Summarize { note_id, .. } => {
            let summary = crate::longform::start(&app, note_id).await?;
            Some(if summary.chunk_count > 1 {
                format!("Reading it in {} parts", summary.chunk_count)
            } else {
                "Reading it".to_string()
            })
        }
        ProposedAction::ImportLink { url, .. } => {
            crate::ingest::start_link_ingest(app.clone(), url.clone(), None).await?;
            Some("Fetching it".to_string())
        }
    };

    let repos = crate::commands::repositories(&app).await?;
    repos
        .record_action(
            &request.proposal_id,
            action.id(),
            action.kind(),
            "done",
            detail.as_deref(),
        )
        .await
        .map_err(|error| AppError::new("action_record_failed", error.to_string()))?;
    Ok(ActionState {
        action_id: action.id().to_string(),
        status: "done".to_string(),
        detail,
    })
}

/// What has already been done for one proposal. The card calls this on
/// mount, which is what makes a reloaded conversation show "Done" instead of
/// the button that would do it twice.
#[tauri::command]
pub async fn action_states(
    app: AppHandle,
    proposal_id: String,
) -> Result<Vec<ActionState>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos
        .action_states(&proposal_id)
        .await
        .map_err(|error| AppError::new("action_states_failed", error.to_string()))
}

// --- EventKit writes ----------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod eventkit {
    use crate::domain::types::AppError;
    use objc2::rc::Retained;
    use objc2_event_kit::{EKEntityType, EKEvent, EKEventStore, EKReminder, EKSpan};
    use objc2_foundation::{NSDate, NSString};

    /// Asks for write access to one entity, and waits. Same shape as the
    /// read path in `crate::calendar`: blocking on purpose, because
    /// `Retained` is not `Send` and an await here would infect every caller.
    fn request_write(store: &EKEventStore, entity: EKEntityType) -> bool {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let completion = block2::RcBlock::new(
            move |granted: objc2::runtime::Bool, _error: *mut objc2::runtime::AnyObject| {
                let _ = tx.send(granted.as_bool());
            },
        );
        unsafe {
            // iOS 17 / macOS 14 split the request per entity and per intent;
            // the deployment target is iOS 15, so ask what the object knows.
            let modern = if entity == EKEntityType::Reminder {
                objc2::sel!(requestFullAccessToRemindersWithCompletion:)
            } else {
                objc2::sel!(requestWriteOnlyAccessToEventsWithCompletion:)
            };
            let responds: bool = objc2::msg_send![store, respondsToSelector: modern];
            if responds {
                if entity == EKEntityType::Reminder {
                    let _: () = objc2::msg_send![
                        store,
                        requestFullAccessToRemindersWithCompletion: &*completion
                    ];
                } else {
                    let _: () = objc2::msg_send![
                        store,
                        requestWriteOnlyAccessToEventsWithCompletion: &*completion
                    ];
                }
            } else {
                let _: () = objc2::msg_send![
                    store,
                    requestAccessToEntityType: entity,
                    completion: &*completion
                ];
            }
        }
        rx.recv_timeout(std::time::Duration::from_secs(180))
            .unwrap_or(false)
    }

    pub fn create_reminder(label: &str, due_at: Option<i64>) -> Result<Option<String>, AppError> {
        let store = unsafe { EKEventStore::new() };
        if !request_write(&store, EKEntityType::Reminder) {
            return Err(AppError::new(
                "action_permission_denied",
                "Sub Rosa needs access to your reminders to add this one.",
            ));
        }
        unsafe {
            let reminder: Retained<EKReminder> = EKReminder::reminderWithEventStore(&store);
            reminder.setTitle(Some(&NSString::from_str(label)));
            let Some(list) = store.defaultCalendarForNewReminders() else {
                return Err(AppError::new(
                    "action_no_list",
                    "There is no reminders list to add to.",
                ));
            };
            reminder.setCalendar(Some(&list));
            if let Some(due) = due_at {
                let date = NSDate::dateWithTimeIntervalSince1970(due as f64);
                let calendar = objc2_foundation::NSCalendar::currentCalendar();
                let units = objc2_foundation::NSCalendarUnit::Year
                    | objc2_foundation::NSCalendarUnit::Month
                    | objc2_foundation::NSCalendarUnit::Day
                    | objc2_foundation::NSCalendarUnit::Hour
                    | objc2_foundation::NSCalendarUnit::Minute;
                let components = calendar.components_fromDate(units, &date);
                reminder.setDueDateComponents(Some(&components));
            }
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|error| AppError::new("action_reminder_failed", error.to_string()))?;
        }
        Ok(Some("Added to your reminders".to_string()))
    }

    pub fn create_event(label: &str, start: i64, end: i64) -> Result<Option<String>, AppError> {
        let store = unsafe { EKEventStore::new() };
        if !request_write(&store, EKEntityType::Event) {
            return Err(AppError::new(
                "action_permission_denied",
                "Sub Rosa needs access to your calendar to add this.",
            ));
        }
        unsafe {
            let event: Retained<EKEvent> = EKEvent::eventWithEventStore(&store);
            event.setTitle(Some(&NSString::from_str(label)));
            event.setStartDate(Some(&NSDate::dateWithTimeIntervalSince1970(start as f64)));
            event.setEndDate(Some(&NSDate::dateWithTimeIntervalSince1970(end as f64)));
            let Some(calendar) = store.defaultCalendarForNewEvents() else {
                return Err(AppError::new(
                    "action_no_calendar",
                    "There is no calendar to add to.",
                ));
            };
            event.setCalendar(Some(&calendar));
            store
                .saveEvent_span_commit_error(&event, EKSpan::ThisEvent, true)
                .map_err(|error| AppError::new("action_event_failed", error.to_string()))?;
        }
        Ok(Some("Added to your calendar".to_string()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod eventkit {
    use crate::domain::types::AppError;

    fn unsupported() -> AppError {
        AppError::new(
            "action_unsupported",
            "This platform has no calendar or reminders to write to.",
        )
    }

    pub fn create_reminder(_label: &str, _due_at: Option<i64>) -> Result<Option<String>, AppError> {
        Err(unsupported())
    }

    pub fn create_event(_label: &str, _start: i64, _end: i64) -> Result<Option<String>, AppError> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_collapsed_capped_and_never_empty() {
        assert_eq!(
            clean_label("  Send   Ana\nthe numbers ", 200).as_deref(),
            Some("Send Ana the numbers")
        );
        assert_eq!(clean_label("   \n  ", 200), None);
        let long = clean_label(&"x".repeat(500), 200).unwrap();
        assert_eq!(long.chars().count(), 201);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn dates_are_read_or_refused_never_guessed() {
        assert_eq!(epoch_from_rfc3339("1970-01-01T00:00:10Z"), Some(10));
        assert_eq!(epoch_from_rfc3339("tomorrow"), None);
        assert_eq!(epoch_from_rfc3339(""), None);
    }

    #[test]
    fn every_action_carries_its_own_id_and_kind() {
        let reminder = ProposedAction::Reminder {
            id: "a1".to_string(),
            label: "Call Marie".to_string(),
            due: None,
        };
        assert_eq!(reminder.id(), "a1");
        assert_eq!(reminder.kind(), "reminder");

        let note = ProposedAction::Note {
            id: "a2".to_string(),
            label: "Add to the note".to_string(),
            note_id: "note-1".to_string(),
            text: "Ana sends the numbers.".to_string(),
        };
        assert_eq!(note.kind(), "note");
    }

    #[test]
    fn the_wire_shape_is_what_the_chat_block_writes() {
        let action: ProposedAction = serde_json::from_value(serde_json::json!({
            "kind": "event",
            "id": "a3",
            "label": "Follow-up with Marie",
            "start": "2026-08-25T09:00:00Z"
        }))
        .expect("event parses");
        assert_eq!(action.kind(), "event");
        assert_eq!(action.id(), "a3");
    }

    /// Every kind, exactly as `src/lib/chat-blocks.ts` writes it and as the
    /// prompt in `hermes_bridge.rs` teaches it.
    ///
    /// This is the seam nothing else covers: the frontend tests mock `invoke`,
    /// so they prove the card sends something, never that this side can read
    /// it. `note` was broken from the day it shipped for exactly that reason.
    #[test]
    fn every_kind_parses_from_the_json_the_card_actually_sends() {
        for payload in [
            serde_json::json!({ "kind": "reminder", "id": "a1", "label": "Call Marie", "due": "2026-08-25T09:00:00Z" }),
            serde_json::json!({ "kind": "event", "id": "a2", "label": "Follow up", "start": "2026-08-25T09:00:00Z" }),
            serde_json::json!({ "kind": "note", "id": "a3", "label": "Add a line", "noteId": "note-1", "text": "Ana owns it." }),
            serde_json::json!({ "kind": "summarize", "id": "a4", "label": "Read it", "noteId": "note-1" }),
            serde_json::json!({ "kind": "importLink", "id": "a5", "label": "Fetch it", "url": "https://cdn.example.com/a.mp3" }),
        ] {
            let kind = payload["kind"].as_str().unwrap_or_default().to_string();
            let action: ProposedAction = serde_json::from_value(payload)
                .unwrap_or_else(|error| panic!("the card's {kind} payload must parse: {error}"));
            assert_eq!(action.kind(), kind);
            assert!(!action.id().is_empty());
        }
    }

    /// The two kinds that spend the user's money. Their wire names are shared
    /// with `src/lib/chat-blocks.ts` and with the prompt in `hermes_bridge.rs`,
    /// so a rename here silently stops every card the model writes from
    /// parsing.
    #[test]
    fn the_kinds_that_spend_money_keep_the_names_the_card_and_the_prompt_use() {
        let summarize: ProposedAction = serde_json::from_value(serde_json::json!({
            "kind": "summarize",
            "id": "a4",
            "label": "Read the whole talk",
            "noteId": "note-7"
        }))
        .expect("summarize parses");
        assert_eq!(summarize.kind(), "summarize");
        assert_eq!(summarize.id(), "a4");

        let import: ProposedAction = serde_json::from_value(serde_json::json!({
            "kind": "importLink",
            "id": "a5",
            "label": "Fetch the episode",
            "url": "https://cdn.example.com/a.mp3"
        }))
        .expect("importLink parses");
        assert_eq!(import.kind(), "importLink");

        // camelCase on the wire, snake_case in Rust. Getting that wrong is how
        // a card renders and then does nothing at all.
        assert!(
            serde_json::from_value::<ProposedAction>(serde_json::json!({
                "kind": "summarize",
                "id": "a6",
                "label": "x",
                "note_id": "note-7"
            }))
            .is_err(),
            "the wire field is noteId, not note_id"
        );
    }

    /// The prompt that teaches the model these cards, and the card that renders
    /// them, both live elsewhere. This is the one place all three names meet.
    #[test]
    fn the_desktop_prompt_advertises_exactly_the_kinds_this_module_executes() {
        let prompt = crate::hermes_bridge::JUNE_SOUL_BLOCKS_MD;
        for kind in ["reminder", "event", "note", "summarize", "importLink"] {
            assert!(
                prompt.contains(&format!("\"kind\":\"{kind}\"")),
                "the desktop prompt does not offer {kind}"
            );
        }
    }
}
