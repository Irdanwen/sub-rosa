//! Calendar context — what the day says, never a calendar surface.
//!
//! The product specs exclude a calendar deliberately: "MUST remain notes-first
//! and MUST NOT reintroduce … calendar … or a dedicated meetings product
//! surface", "no meeting object" (`specs/002-system-audio-source-mode`). This
//! module works inside that: it reads EventKit so a NOTE can know what it is
//! called, when it was scheduled and who was invited. There is no calendar
//! screen, no `meetings` table, no second noun — the note stays the only one.
//!
//! EventKit is the same framework on macOS and iOS, so one module serves both
//! shells (unlike, say, a Live Activity). Everything here stays on the device:
//! the app talks to no server for calendar data, and the agent reaches it
//! through a retrieval tool, never through a planning dump injected into a
//! prompt.
//!
//! Permission is asked at the moment it pays off (the first recording), never
//! at launch, and a refusal degrades to exactly today's behaviour.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};

/// How far before a scheduled start a recording still belongs to it. Someone
/// who hits record while the invite is still ringing is in that meeting.
pub const MATCH_BEFORE_SECS: i64 = 10 * 60;
/// How far after a scheduled start a recording still belongs to it — late
/// joins are the norm, but an hour later is a different meeting.
pub const MATCH_AFTER_SECS: i64 = 15 * 60;
/// Attendee lists are display metadata on a note, not a directory.
const MAX_ATTENDEES: usize = 24;
const MAX_TEXT: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    /// EventKit's own identifier, stored on the note so a re-open resolves
    /// the same event.
    pub id: String,
    pub title: String,
    /// Epoch seconds, so the shell formats in its own locale.
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// The invitation's own notes: the agenda, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agenda: Option<String>,
    /// Display names (or emails when a name is missing), organiser first.
    pub attendees: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarAccess {
    Granted,
    Denied,
    NotDetermined,
    /// The platform cannot answer (non-Apple build).
    Unsupported,
}

/// What a recording started at some instant belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "events")]
pub enum CalendarMatch {
    /// Nothing in the window: the note behaves exactly as it always has.
    None,
    /// Exactly one candidate — attach it.
    One(CalendarEventDto),
    /// Overlapping candidates. We do NOT guess; the shell asks, once.
    Ambiguous(Vec<CalendarEventDto>),
}

/// Picks the event a recording started at `started_at` belongs to.
///
/// Pure, so the rule is testable without a calendar: candidates are the
/// events whose start falls inside [t - MATCH_BEFORE, t + MATCH_AFTER], plus
/// any event already running when the recording began. All-day events never
/// match — "Vacation" is not the meeting anyone just started recording.
pub fn match_recording(started_at: i64, events: &[CalendarEventDto]) -> CalendarMatch {
    let mut candidates: Vec<&CalendarEventDto> = events
        .iter()
        .filter(|event| !event.all_day)
        .filter(|event| {
            let near_start = event.start >= started_at - MATCH_AFTER_SECS
                && event.start <= started_at + MATCH_BEFORE_SECS;
            let already_running = event.start <= started_at && event.end > started_at;
            near_start || already_running
        })
        .collect();
    if candidates.is_empty() {
        return CalendarMatch::None;
    }
    if candidates.len() == 1 {
        return CalendarMatch::One(candidates[0].clone());
    }
    // Several: closest start first, so the shell's question leads with the
    // likeliest answer. Ties break on the shorter event (a 30-minute slot
    // inside a 3-hour block is what someone is recording).
    candidates.sort_by_key(|event| {
        (
            (event.start - started_at).abs(),
            event.end - event.start,
            event.id.clone(),
        )
    });
    CalendarMatch::Ambiguous(candidates.into_iter().cloned().collect())
}

fn cap(value: String) -> String {
    if value.chars().count() > MAX_TEXT {
        value.chars().take(MAX_TEXT).collect::<String>() + "…"
    } else {
        value
    }
}

// --- EventKit ---------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod eventkit {
    use super::{cap, CalendarAccess, CalendarEventDto, MAX_ATTENDEES};
    use objc2::rc::Retained;
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEvent, EKEventStore};
    use objc2_foundation::{NSArray, NSDate, NSString};

    fn nsstring(value: &Retained<NSString>) -> String {
        value.to_string()
    }

    /// One shared store: EventKit warms a connection per instance, and the
    /// authorization a user grants belongs to the process, not the object.
    fn store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::new() }
    }

    pub fn access() -> CalendarAccess {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        match status {
            // `FullAccess` and the older `Authorized` are the same value (3),
            // so this one arm covers iOS 15 through 17+ — which matters,
            // because 15 is the deployment target.
            EKAuthorizationStatus::FullAccess => CalendarAccess::Granted,
            EKAuthorizationStatus::NotDetermined => CalendarAccess::NotDetermined,
            // Denied, Restricted and write-only all mean the same thing to us:
            // we cannot read the day, so the note behaves as it always has.
            _ => CalendarAccess::Denied,
        }
    }

    /// Asks for read access and waits for the answer.
    ///
    /// iOS 17 / macOS 14 replaced `requestAccessToEntityType:` with
    /// `requestFullAccessToEventsWithCompletion:`; the deployment target is
    /// iOS 15, so both paths have to exist.
    ///
    /// Deliberately blocking, not async: `Retained<…>` is not `Send`, so an
    /// await inside this scope would make every command that touches it a
    /// non-`Send` future. The caller runs it on a blocking thread instead —
    /// nothing ObjC ever crosses an await point.
    pub fn request_access_blocking() -> CalendarAccess {
        if access() == CalendarAccess::Granted {
            return CalendarAccess::Granted;
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let completion = block2::RcBlock::new(
            move |granted: objc2::runtime::Bool, _error: *mut objc2::runtime::AnyObject| {
                let _ = tx.send(granted.as_bool());
            },
        );
        let store = store();
        unsafe {
            // Ask the object which selector it knows rather than assuming the
            // newer system.
            let modern = objc2::sel!(requestFullAccessToEventsWithCompletion:);
            let responds: bool = objc2::msg_send![&*store, respondsToSelector: modern];
            if responds {
                let _: () = objc2::msg_send![&*store, requestFullAccessToEventsWithCompletion: &*completion];
            } else {
                let _: () = objc2::msg_send![
                    &*store,
                    requestAccessToEntityType: EKEntityType::Event,
                    completion: &*completion
                ];
            }
        }
        // The system dialog is the user's to answer; a generous ceiling keeps
        // a forgotten prompt from pinning the thread forever.
        match rx.recv_timeout(std::time::Duration::from_secs(180)) {
            Ok(true) => CalendarAccess::Granted,
            Ok(false) => CalendarAccess::Denied,
            // The block never fired: report what the system currently thinks
            // rather than inventing an answer.
            Err(_) => access(),
        }
    }

    fn event_dto(event: &EKEvent) -> Option<CalendarEventDto> {
        unsafe {
            let id = event.eventIdentifier().map(|value| nsstring(&value))?;
            let start = event.startDate().timeIntervalSince1970() as i64;
            let end = event.endDate().timeIntervalSince1970() as i64;
            let title = nsstring(&event.title());
            let mut attendees: Vec<String> = Vec::new();
            if let Some(organizer) = event.organizer() {
                if let Some(name) = organizer.name() {
                    attendees.push(nsstring(&name));
                }
            }
            if let Some(participants) = event.attendees() {
                for participant in participants.iter() {
                    if attendees.len() >= MAX_ATTENDEES {
                        break;
                    }
                    let Some(name) = participant.name() else {
                        continue;
                    };
                    let name = nsstring(&name);
                    if !name.is_empty() && !attendees.contains(&name) {
                        attendees.push(name);
                    }
                }
            }
            Some(CalendarEventDto {
                id,
                title,
                start,
                end,
                all_day: event.isAllDay(),
                location: event
                    .location()
                    .map(|value| cap(nsstring(&value)))
                    .filter(|value| !value.is_empty()),
                agenda: event
                    .notes()
                    .map(|value| cap(nsstring(&value)))
                    .filter(|value| !value.is_empty()),
                attendees,
            })
        }
    }

    pub fn events_between(start: i64, end: i64) -> Vec<CalendarEventDto> {
        if access() != CalendarAccess::Granted || end <= start {
            return Vec::new();
        }
        let store = store();
        unsafe {
            let from = NSDate::dateWithTimeIntervalSince1970(start as f64);
            let to = NSDate::dateWithTimeIntervalSince1970(end as f64);
            let predicate =
                store.predicateForEventsWithStartDate_endDate_calendars(&from, &to, None);
            let events: Retained<NSArray<EKEvent>> = store.eventsMatchingPredicate(&predicate);
            events
                .iter()
                .filter_map(|event| event_dto(&event))
                .collect()
        }
    }

    pub fn event_by_id(id: &str) -> Option<CalendarEventDto> {
        if access() != CalendarAccess::Granted {
            return None;
        }
        let store = store();
        unsafe {
            let identifier = NSString::from_str(id);
            let event = store.eventWithIdentifier(&identifier)?;
            event_dto(&event)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod eventkit {
    use super::{CalendarAccess, CalendarEventDto};

    pub fn access() -> CalendarAccess {
        CalendarAccess::Unsupported
    }
    pub fn request_access_blocking() -> CalendarAccess {
        CalendarAccess::Unsupported
    }
    pub fn events_between(_start: i64, _end: i64) -> Vec<CalendarEventDto> {
        Vec::new()
    }
    pub fn event_by_id(_id: &str) -> Option<CalendarEventDto> {
        None
    }
}

/// Read access to the day, for other modules (the brief scheduler). Kept as
/// thin wrappers so `eventkit` itself stays private.
pub fn access_state() -> CalendarAccess {
    eventkit::access()
}

pub fn events_in_window(start: i64, end: i64) -> Vec<CalendarEventDto> {
    eventkit::events_between(start, end)
}

pub fn event_by_id(id: &str) -> Option<CalendarEventDto> {
    eventkit::event_by_id(id)
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn calendar_access_state() -> CalendarAccess {
    eventkit::access()
}

#[tauri::command]
pub async fn calendar_request_access() -> CalendarAccess {
    // Off the async runtime: see request_access_blocking.
    tokio::task::spawn_blocking(eventkit::request_access_blocking)
        .await
        .unwrap_or_else(|_| eventkit::access())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarWindowRequest {
    pub start: i64,
    pub end: i64,
}

/// The events in a window. Bounded to a week so no caller can walk the whole
/// calendar in one call — the agent asks about a day, not a life.
#[tauri::command]
pub fn calendar_events_between(
    request: CalendarWindowRequest,
) -> Result<Vec<CalendarEventDto>, AppError> {
    const MAX_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
    if request.end <= request.start || request.end - request.start > MAX_WINDOW_SECS {
        return Err(AppError::new(
            "calendar_window_invalid",
            "Ask for a window of at most a week.",
        ));
    }
    Ok(eventkit::events_between(request.start, request.end))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMatchRequest {
    /// Epoch seconds the recording started at.
    pub started_at: i64,
}

/// What a recording that started at `started_at` belongs to.
#[tauri::command]
pub fn calendar_match_recording(request: CalendarMatchRequest) -> CalendarMatch {
    let events = eventkit::events_between(
        request.started_at - MATCH_AFTER_SECS - 4 * 60 * 60,
        request.started_at + MATCH_BEFORE_SECS + 60,
    );
    match_recording(request.started_at, &events)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkRequest {
    pub note_id: String,
    /// Epoch seconds the recording started at.
    pub started_at: i64,
}

/// Attaches the event a recording belongs to, to its note.
///
/// The three answers are the whole design: exactly one candidate attaches
/// silently (and names the note, if it is still untitled — that is the
/// visible payoff); several are handed back for the shell to ask about,
/// once, because guessing between two overlapping meetings is worse than
/// asking; none leaves the note exactly as the app has always made it.
#[tauri::command]
pub async fn calendar_link_note(
    app: tauri::AppHandle,
    request: CalendarLinkRequest,
) -> Result<CalendarMatch, AppError> {
    let matched = calendar_match_recording(CalendarMatchRequest {
        started_at: request.started_at,
    });
    if let CalendarMatch::One(event) = &matched {
        attach_event(&app, &request.note_id, event).await?;
    }
    Ok(matched)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAttachRequest {
    pub note_id: String,
    /// The event the user picked out of an ambiguous match, or none to
    /// detach a note the app got wrong.
    pub event_id: Option<String>,
}

/// The answer to the ambiguity question, and the way to undo a bad link.
#[tauri::command]
pub async fn calendar_attach_note(
    app: tauri::AppHandle,
    request: CalendarAttachRequest,
) -> Result<Option<CalendarEventDto>, AppError> {
    let Some(event_id) = request.event_id.filter(|id| !id.is_empty()) else {
        let repos = crate::commands::repositories(&app).await?;
        repos
            .set_note_calendar_context(&request.note_id, None, None, &[])
            .await
            .map_err(|error| AppError::new("calendar_detach_failed", error.to_string()))?;
        return Ok(None);
    };
    let Some(event) = eventkit::event_by_id(&event_id) else {
        return Err(AppError::new(
            "calendar_event_missing",
            "That event is no longer in the calendar.",
        ));
    };
    attach_event(&app, &request.note_id, &event).await?;
    Ok(Some(event))
}

async fn attach_event(
    app: &tauri::AppHandle,
    note_id: &str,
    event: &CalendarEventDto,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let scheduled = crate::domain::types::rfc3339_from_epoch_secs(event.start);
    repos
        .set_note_calendar_context(note_id, Some(&event.id), Some(&scheduled), &event.attendees)
        .await
        .map_err(|error| AppError::new("calendar_link_failed", error.to_string()))?;
    // Naming an untitled note is the point of the whole exercise; a note the
    // user already named is theirs, and we never rename it.
    let title = event.title.trim();
    if !title.is_empty() {
        repos
            .set_note_title_if_empty(note_id, title)
            .await
            .map_err(|error| AppError::new("calendar_title_failed", error.to_string()))?;
    }
    Ok(())
}

/// Resolves one stored event id, for a note re-opened later.
#[tauri::command]
pub fn calendar_event(id: String) -> Option<CalendarEventDto> {
    eventkit::event_by_id(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, start: i64, end: i64) -> CalendarEventDto {
        CalendarEventDto {
            id: id.to_string(),
            title: format!("Event {id}"),
            start,
            end,
            all_day: false,
            location: None,
            agenda: None,
            attendees: vec![],
        }
    }

    const T: i64 = 1_760_000_000;

    #[test]
    fn nothing_in_the_window_means_the_note_is_unchanged() {
        assert_eq!(match_recording(T, &[]), CalendarMatch::None);
        // Two hours later is a different meeting.
        let far = event("far", T + 2 * 60 * 60, T + 3 * 60 * 60);
        assert_eq!(match_recording(T, &[far]), CalendarMatch::None);
    }

    #[test]
    fn a_recording_started_just_before_or_after_belongs_to_the_event() {
        let soon = event("soon", T + 9 * 60, T + 39 * 60);
        assert_eq!(
            match_recording(T, std::slice::from_ref(&soon)),
            CalendarMatch::One(soon.clone())
        );
        let started = event("started", T - 14 * 60, T + 16 * 60);
        assert_eq!(
            match_recording(T, std::slice::from_ref(&started)),
            CalendarMatch::One(started)
        );
    }

    #[test]
    fn a_meeting_already_running_still_matches_a_late_record() {
        // Started an hour ago, runs another hour: joining late is normal.
        let long = event("long", T - 60 * 60, T + 60 * 60);
        assert_eq!(
            match_recording(T, std::slice::from_ref(&long)),
            CalendarMatch::One(long)
        );
    }

    #[test]
    fn all_day_events_never_match() {
        let mut vacation = event("vac", T - 60 * 60, T + 8 * 60 * 60);
        vacation.all_day = true;
        assert_eq!(match_recording(T, &[vacation]), CalendarMatch::None);
    }

    #[test]
    fn overlapping_events_are_asked_about_closest_first_never_guessed() {
        let block = event("block", T - 30 * 60, T + 150 * 60);
        let slot = event("slot", T + 2 * 60, T + 32 * 60);
        let matched = match_recording(T, &[block.clone(), slot.clone()]);
        let CalendarMatch::Ambiguous(ordered) = matched else {
            panic!("expected an ambiguous match, got {matched:?}");
        };
        assert_eq!(ordered.len(), 2);
        // The 30-minute slot starting in two minutes leads.
        assert_eq!(ordered[0].id, slot.id);
        assert_eq!(ordered[1].id, block.id);
    }

    #[test]
    fn long_free_text_is_capped_not_dropped() {
        let capped = cap("x".repeat(1000));
        assert_eq!(capped.chars().count(), MAX_TEXT + 1);
        assert!(capped.ends_with('…'));
        assert_eq!(cap("short".to_string()), "short");
    }
}
