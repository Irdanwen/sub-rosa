//! The parental-control switches behind the protected mode PIN (ADR-0084
//! addendum): quiet hours, memory, image and video generation, voice and past
//! chats. Pure functions of the switches and the time of day, so every guard
//! is tested without a clock or a settings file.
//!
//! Each switch is enforced where requests leave, not in the webview: quiet
//! hours and the media switch in the chat and media proxies, memory and past
//! chats at the memory seams (`memory::settings` reads them) and in the
//! desktop runtime's own tools (the `subrosa_guard` plugin's ledger). Voice
//! is stored for the voice mode to come and guards nothing yet.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};

const MINUTES_PER_DAY: u16 = 24 * 60;

/// A daily window, in minutes after local midnight. `start` is in the
/// window and `end` is not; a window whose end comes before its start runs
/// over midnight (21:00 to 07:00).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
}

impl QuietHours {
    pub fn contains(&self, minute: u16) -> bool {
        let minute = minute % MINUTES_PER_DAY;
        if self.start_minute <= self.end_minute {
            (self.start_minute..self.end_minute).contains(&minute)
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }
}

/// The switches. All off by default, and only in force while protected mode
/// is on.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Restrictions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quiet_hours: Option<QuietHours>,
    pub memory_off: bool,
    pub media_off: bool,
    /// Reserved for the voice mode: stored and shown, enforced by nothing yet.
    pub voice_off: bool,
    pub past_chats_off: bool,
}

impl Restrictions {
    /// Whether quiet hours are on at `minute` (after local midnight).
    pub fn quiet_at(&self, minute: u16) -> bool {
        self.quiet_hours
            .is_some_and(|window| window.contains(minute))
    }
}

/// Refuses a window that could not be meant: out of the day, or empty.
pub fn validate(restrictions: &Restrictions) -> Result<(), AppError> {
    if let Some(window) = restrictions.quiet_hours {
        let in_day = window.start_minute < MINUTES_PER_DAY && window.end_minute < MINUTES_PER_DAY;
        if !in_day || window.start_minute == window.end_minute {
            return Err(AppError::new(
                "protected_mode_quiet_hours_invalid",
                "Choose quiet hours that start and end at different times.",
            ));
        }
    }
    Ok(())
}

pub(super) fn quiet_hours_refusal() -> AppError {
    AppError::new(
        "protected_mode_quiet_hours",
        "Quiet hours are on. Chat and Studio are paused until they end.",
    )
}

fn media_refusal() -> AppError {
    AppError::new(
        "protected_mode_media_off",
        "Protected mode turned off image and video generation.",
    )
}

/// Refuses a chat request during quiet hours.
pub fn check_chat(restrictions: &Restrictions, minute: u16) -> Result<(), AppError> {
    if restrictions.quiet_at(minute) {
        return Err(quiet_hours_refusal());
    }
    Ok(())
}

/// A media path that only reads back work already paid for: a queued
/// render's status, its result, or a price. Refusing those would lose a
/// render queued before the window opened.
fn reads_back(path: &str) -> bool {
    ["/retrieve", "/complete", "/quote"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

/// Refuses a media request that starts new work during quiet hours, and an
/// image or video one while generation is off. Catalog reads (no body) and
/// read-backs always pass.
pub fn check_media(
    path: &str,
    has_body: bool,
    restrictions: &Restrictions,
    minute: u16,
) -> Result<(), AppError> {
    if !has_body || reads_back(path) {
        return Ok(());
    }
    if restrictions.quiet_at(minute) {
        return Err(quiet_hours_refusal());
    }
    if restrictions.media_off && (path.starts_with("/image/") || path.starts_with("/video/")) {
        return Err(media_refusal());
    }
    Ok(())
}

/// Minutes after local midnight, now.
pub fn local_minute() -> u16 {
    use chrono::Timelike as _;
    let now = chrono::Local::now();
    (now.hour() * 60 + now.minute()) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(start: u16, end: u16) -> Option<QuietHours> {
        Some(QuietHours {
            start_minute: start,
            end_minute: end,
        })
    }

    #[test]
    fn a_window_within_the_day_and_one_over_midnight() {
        let day = QuietHours {
            start_minute: 13 * 60,
            end_minute: 14 * 60,
        };
        assert!(day.contains(13 * 60));
        assert!(day.contains(13 * 60 + 59));
        assert!(!day.contains(14 * 60));
        assert!(!day.contains(12 * 60 + 59));
        let night = QuietHours {
            start_minute: 21 * 60,
            end_minute: 7 * 60,
        };
        assert!(night.contains(21 * 60));
        assert!(night.contains(23 * 60 + 59));
        assert!(night.contains(0));
        assert!(night.contains(6 * 60 + 59));
        assert!(!night.contains(7 * 60));
        assert!(!night.contains(20 * 60 + 59));
    }

    #[test]
    fn quiet_hours_refuse_chat_only_inside_the_window() {
        let quiet = Restrictions {
            quiet_hours: window(21 * 60, 7 * 60),
            ..Restrictions::default()
        };
        assert_eq!(
            check_chat(&quiet, 22 * 60).unwrap_err().code,
            "protected_mode_quiet_hours"
        );
        assert!(check_chat(&quiet, 12 * 60).is_ok());
        assert!(check_chat(&Restrictions::default(), 22 * 60).is_ok());
    }

    #[test]
    fn quiet_hours_refuse_new_media_work_but_not_read_backs() {
        let quiet = Restrictions {
            quiet_hours: window(21 * 60, 7 * 60),
            ..Restrictions::default()
        };
        for path in [
            "/image/generate",
            "/video/queue",
            "/audio/speech",
            "/chat/completions",
        ] {
            assert_eq!(
                check_media(path, true, &quiet, 23 * 60).unwrap_err().code,
                "protected_mode_quiet_hours",
                "{path}"
            );
            assert!(check_media(path, true, &quiet, 9 * 60).is_ok(), "{path}");
        }
        assert!(check_media("/video/retrieve", true, &quiet, 23 * 60).is_ok());
        assert!(check_media("/video/complete", true, &quiet, 23 * 60).is_ok());
        assert!(check_media("/models", false, &quiet, 23 * 60).is_ok());
    }

    #[test]
    fn media_off_refuses_image_and_video_generation_only() {
        let off = Restrictions {
            media_off: true,
            ..Restrictions::default()
        };
        for path in [
            "/image/generate",
            "/image/edit/queue",
            "/video/queue",
            "/image/upscale",
        ] {
            assert_eq!(
                check_media(path, true, &off, 12 * 60).unwrap_err().code,
                "protected_mode_media_off",
                "{path}"
            );
        }
        assert!(check_media("/audio/speech", true, &off, 12 * 60).is_ok());
        assert!(check_media("/chat/completions", true, &off, 12 * 60).is_ok());
        assert!(check_media("/video/retrieve", true, &off, 12 * 60).is_ok());
    }

    #[test]
    fn an_empty_or_out_of_day_window_is_refused() {
        assert!(validate(&Restrictions::default()).is_ok());
        let empty = Restrictions {
            quiet_hours: window(600, 600),
            ..Restrictions::default()
        };
        assert_eq!(
            validate(&empty).unwrap_err().code,
            "protected_mode_quiet_hours_invalid"
        );
        let late = Restrictions {
            quiet_hours: window(1440, 60),
            ..Restrictions::default()
        };
        assert!(validate(&late).is_err());
        let night = Restrictions {
            quiet_hours: window(21 * 60, 7 * 60),
            ..Restrictions::default()
        };
        assert!(validate(&night).is_ok());
    }

    #[test]
    fn the_switches_read_back_from_older_files_as_off() {
        let restrictions: Restrictions = serde_json::from_str("{}").unwrap();
        assert_eq!(restrictions, Restrictions::default());
        let json = serde_json::to_value(Restrictions {
            quiet_hours: window(60, 120),
            voice_off: true,
            ..Restrictions::default()
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "quietHours": {"startMinute": 60, "endMinute": 120},
                "memoryOff": false,
                "mediaOff": false,
                "voiceOff": true,
                "pastChatsOff": false
            })
        );
    }
}
