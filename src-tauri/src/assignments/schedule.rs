//! When an assignment is due: pure functions of a cadence and a clock.
//!
//! The app owns the clock, not Hermes and not the phone's scheduler. A slot is
//! a local time the cadence names; the device that runs the row asks "which is
//! the latest slot at or before now, and has it run?" every time it looks.
//! That one question covers the open app, the app coming back from the menu
//! bar after a night asleep, and the phone opened at noon: a missed morning is
//! one late run, never seven, and a slot older than the latest is never run at
//! all (the perishable rule of ADR-0054, applied to a schedule).

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc, Weekday};
use serde::{Deserialize, Serialize};

/// After this long past its slot, a run says it ran late.
pub const LATE_AFTER: Duration = Duration::minutes(10);
/// How long a phone leaves a slot to the computer that runs the assignment
/// before running it itself, as a catch-up, in the foreground.
pub const FALLBACK_GRACE: Duration = Duration::minutes(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Every,
}

impl Cadence {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "hourly" => Some(Self::Hourly),
            "daily" => Some(Self::Daily),
            "weekdays" => Some(Self::Weekdays),
            "weekly" => Some(Self::Weekly),
            "every" => Some(Self::Every),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hourly => "hourly",
            Self::Daily => "daily",
            Self::Weekdays => "weekdays",
            Self::Weekly => "weekly",
            Self::Every => "every",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Schedule {
    pub cadence: Cadence,
    /// Minutes after local midnight. Hourly reads only the minute of the hour.
    pub at_minute: u32,
    /// 0 for Sunday to 6 for Saturday, for `weekly`.
    pub weekday: u32,
    /// The gap in hours for `every`, counted from the day's first slot.
    pub every_hours: u32,
}

/// Who is asking whether a slot is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The device the row names: it runs the slot as soon as it is due.
    Executor,
    /// A phone whose assignment runs on a computer: it runs a slot only when
    /// the computer has left it for [`FALLBACK_GRACE`], and always late.
    Fallback,
}

/// A slot to run now, and whether it is late.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub slot: DateTime<Utc>,
    pub late: bool,
}

const DAY_MINUTES: u32 = 24 * 60;
/// How far a search for the previous or next slot looks. A weekly cadence
/// always finds one inside eight days.
const SEARCH_DAYS: i64 = 8;

impl Schedule {
    fn time(minute: u32) -> Option<NaiveTime> {
        let minute = minute.min(DAY_MINUTES - 1);
        NaiveTime::from_hms_opt(minute / 60, minute % 60, 0)
    }

    /// The slots of one local day, in order. A local time that does not exist
    /// (the hour a clock skips in spring) has no slot that day.
    fn slots_on<Tz: TimeZone>(&self, tz: &Tz, date: NaiveDate) -> Vec<DateTime<Tz>> {
        let minutes: Vec<u32> = match self.cadence {
            Cadence::Hourly => (0..24)
                .map(|hour| hour * 60 + self.at_minute % 60)
                .collect(),
            Cadence::Daily => vec![self.at_minute],
            Cadence::Weekdays => {
                if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
                    Vec::new()
                } else {
                    vec![self.at_minute]
                }
            }
            Cadence::Weekly => {
                if date.weekday().num_days_from_sunday() == self.weekday % 7 {
                    vec![self.at_minute]
                } else {
                    Vec::new()
                }
            }
            Cadence::Every => {
                let step = self.every_hours.clamp(1, 24) * 60;
                let first = self.at_minute.min(DAY_MINUTES - 1);
                (0..)
                    .map(|k: u32| first + k * step)
                    .take_while(|minute| *minute < DAY_MINUTES)
                    .collect()
            }
        };
        minutes
            .into_iter()
            .filter_map(Self::time)
            .filter_map(|time| tz.from_local_datetime(&date.and_time(time)).earliest())
            .collect()
    }

    /// The latest slot at or before `now`, in `now`'s time zone.
    pub fn latest_at_or_before<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Option<DateTime<Tz>> {
        let tz = now.timezone();
        let today = now.date_naive();
        (0..=SEARCH_DAYS).find_map(|back| {
            self.slots_on(&tz, today - Duration::days(back))
                .into_iter()
                .filter(|slot| slot <= now)
                .last()
        })
    }

    /// The first slot after `now`, for "next run" on a screen.
    pub fn next_after<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Option<DateTime<Tz>> {
        let tz = now.timezone();
        let today = now.date_naive();
        (0..=SEARCH_DAYS).find_map(|ahead| {
            self.slots_on(&tz, today + Duration::days(ahead))
                .into_iter()
                .find(|slot| slot > now)
        })
    }
}

/// The key a slot is recorded under. UTC, to the second, so the two devices
/// of one account write the same key for the same slot.
pub fn slot_key(slot: &DateTime<Utc>) -> String {
    slot.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Whether a slot is due now, for one device, and whether it is late.
///
/// - Nothing is due before the assignment was active: a daily 9:00 created at
///   14:00 first runs tomorrow, and one resumed at 14:00 does not run the 9:00
///   it was paused through.
/// - Only the latest slot can be due. Everything older has perished.
/// - A slot already run, here or by another device, is not due.
/// - A fallback leaves the slot to the computer for [`FALLBACK_GRACE`].
pub fn due<Tz: TimeZone>(
    schedule: &Schedule,
    active_since: DateTime<Utc>,
    now: &DateTime<Tz>,
    already_ran: impl Fn(&str) -> bool,
    role: Role,
) -> Option<Due> {
    let slot = schedule.latest_at_or_before(now)?.with_timezone(&Utc);
    if slot < active_since || already_ran(&slot_key(&slot)) {
        return None;
    }
    let waited = now.with_timezone(&Utc) - slot;
    if role == Role::Fallback && waited < FALLBACK_GRACE {
        return None;
    }
    Some(Due {
        slot,
        late: role == Role::Fallback || waited > LATE_AFTER,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn paris() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn at(day: u32, hour: u32, minute: u32) -> DateTime<FixedOffset> {
        // October 2026: the 5th is a Monday, the 10th a Saturday.
        paris()
            .with_ymd_and_hms(2026, 10, day, hour, minute, 0)
            .unwrap()
    }

    fn schedule(cadence: Cadence) -> Schedule {
        Schedule {
            cadence,
            at_minute: 9 * 60,
            weekday: 1,
            every_hours: 4,
        }
    }

    fn never(_: &str) -> bool {
        false
    }

    #[test]
    fn a_daily_slot_is_today_once_its_time_has_passed() {
        let daily = schedule(Cadence::Daily);
        assert_eq!(daily.latest_at_or_before(&at(7, 9, 30)), Some(at(7, 9, 0)));
        assert_eq!(daily.latest_at_or_before(&at(7, 8, 59)), Some(at(6, 9, 0)));
        assert_eq!(daily.next_after(&at(7, 9, 0)), Some(at(8, 9, 0)));
    }

    #[test]
    fn weekdays_skip_the_weekend_and_weekly_keeps_its_day() {
        let weekdays = schedule(Cadence::Weekdays);
        // Sunday the 11th at noon: the latest weekday slot is Friday's.
        assert_eq!(
            weekdays.latest_at_or_before(&at(11, 12, 0)),
            Some(at(9, 9, 0))
        );
        assert_eq!(weekdays.next_after(&at(9, 10, 0)), Some(at(12, 9, 0)));
        let weekly = schedule(Cadence::Weekly);
        assert_eq!(weekly.latest_at_or_before(&at(8, 12, 0)), Some(at(5, 9, 0)));
        assert_eq!(weekly.next_after(&at(8, 12, 0)), Some(at(12, 9, 0)));
    }

    #[test]
    fn hourly_and_every_count_from_the_day() {
        let hourly = Schedule {
            at_minute: 15,
            ..schedule(Cadence::Hourly)
        };
        assert_eq!(
            hourly.latest_at_or_before(&at(7, 13, 20)),
            Some(at(7, 13, 15))
        );
        assert_eq!(hourly.next_after(&at(7, 13, 20)), Some(at(7, 14, 15)));
        let every = Schedule {
            at_minute: 60,
            every_hours: 6,
            ..schedule(Cadence::Every)
        };
        // 1:00, 7:00, 13:00, 19:00.
        assert_eq!(every.latest_at_or_before(&at(7, 12, 0)), Some(at(7, 7, 0)));
        assert_eq!(every.next_after(&at(7, 19, 0)), Some(at(8, 1, 0)));
    }

    #[test]
    fn a_missed_week_is_one_late_run_not_seven() {
        let daily = schedule(Cadence::Daily);
        let since = at(1, 8, 0).with_timezone(&Utc);
        let due = due(&daily, since, &at(8, 12, 0), never, Role::Executor).unwrap();
        assert_eq!(due.slot, at(8, 9, 0).with_timezone(&Utc));
        assert!(due.late, "three hours past its slot");
        // Once that slot ran, nothing else is due until tomorrow: the six
        // older mornings perished.
        let key = slot_key(&due.slot);
        assert_eq!(
            super::due(
                &daily,
                since,
                &at(8, 12, 0),
                |ran| ran == key,
                Role::Executor
            ),
            None
        );
    }

    #[test]
    fn a_slot_on_time_is_not_late_and_nothing_runs_before_it_was_active() {
        let daily = schedule(Cadence::Daily);
        let on_time = due(
            &daily,
            at(1, 8, 0).with_timezone(&Utc),
            &at(7, 9, 2),
            never,
            Role::Executor,
        )
        .unwrap();
        assert!(!on_time.late);
        // Created (or resumed) at 14:00: this morning's slot is not owed.
        assert_eq!(
            due(
                &daily,
                at(7, 14, 0).with_timezone(&Utc),
                &at(7, 15, 0),
                never,
                Role::Executor
            ),
            None
        );
    }

    #[test]
    fn a_phone_leaves_the_slot_to_the_computer_for_a_while() {
        let daily = schedule(Cadence::Daily);
        let since = at(1, 8, 0).with_timezone(&Utc);
        assert_eq!(
            due(&daily, since, &at(7, 9, 20), never, Role::Fallback),
            None
        );
        let caught_up = due(&daily, since, &at(7, 9, 40), never, Role::Fallback).unwrap();
        assert!(caught_up.late, "a catch-up always says so");
    }

    #[test]
    fn slot_keys_are_the_same_whichever_zone_wrote_them() {
        let slot = at(7, 9, 0);
        let other = slot.with_timezone(&FixedOffset::west_opt(5 * 3600).unwrap());
        assert_eq!(
            slot_key(&slot.with_timezone(&Utc)),
            slot_key(&other.with_timezone(&Utc))
        );
        assert_eq!(slot_key(&slot.with_timezone(&Utc)), "2026-10-07T07:00:00Z");
    }

    #[test]
    fn cadences_read_back_what_they_write() {
        for cadence in [
            Cadence::Hourly,
            Cadence::Daily,
            Cadence::Weekdays,
            Cadence::Weekly,
            Cadence::Every,
        ] {
            assert_eq!(Cadence::parse(cadence.as_str()), Some(cadence));
        }
        assert_eq!(Cadence::parse("monthly"), None);
    }
}
