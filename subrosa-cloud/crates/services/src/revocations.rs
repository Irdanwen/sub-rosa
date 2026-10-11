//! The Carpe Diem revocation outbox, delivered (ADR 0069).
//!
//! A revocation that does not get through stays on its row and is asked again,
//! forever, on a backoff that stops growing at six hours. Retrying quietly is
//! right for an outage and wrong for a refusal that never ends: from 4 October
//! 2026 every revocation was answered 404 for a week and the only trace was a
//! warning per attempt that said nothing about why. So each failure now names
//! its status, and once revocations have been failing for about a day the
//! service says so at ERROR, once a day, until they go through.
use super::Service;
use chrono::{DateTime, TimeDelta, Utc};
use subrosa_domain::{Result, RevocationBacklog};

/// How many revocations one maintenance tick delivers.
const REVOCATIONS_PER_TICK: i64 = 50;
/// The alarm repeats at most this often while revocations stay stuck.
const ALARM_EVERY_HOURS: i64 = 24;

/// Whether the stuck-revocation alarm may go off at `now`, given when it last
/// did in this process.
fn alarm_due(last: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    match last {
        None => true,
        Some(last) => now - last >= TimeDelta::hours(ALARM_EVERY_HOURS),
    }
}

impl Service {
    /// Delivers due revocations. A failure stays in the outbox with its
    /// backoff; nothing here can block the rest of maintenance.
    pub(crate) async fn deliver_revocations(&self) -> Result<()> {
        let Some(partner) = &self.carpe_diem else {
            return Ok(());
        };
        let mut failed = false;
        for revocation in self
            .repository
            .claim_revocations(REVOCATIONS_PER_TICK)
            .await?
        {
            match partner.revoke(&revocation).await {
                Ok(()) => self.repository.revocation_delivered(revocation.id).await?,
                Err(failure) => {
                    failed = true;
                    tracing::warn!(
                        attempts = revocation.attempts + 1,
                        failure = %failure,
                        "Carpe Diem revocation will be retried"
                    );
                    self.repository
                        .revocation_failed(revocation.id, &failure.to_string())
                        .await?;
                }
            }
        }
        if failed {
            self.alarm_if_stuck(Utc::now()).await?;
        }
        Ok(())
    }

    /// Logs one ERROR when revocations have been failing for about a day, and
    /// no more than once a day after that. Returns whether it did.
    pub async fn alarm_if_stuck(&self, now: DateTime<Utc>) -> Result<bool> {
        let backlog = self.repository.revocation_backlog().await?;
        if backlog.stuck == 0 {
            return Ok(false);
        }
        {
            let Ok(mut last) = self.revocation_alarm.lock() else {
                return Ok(false);
            };
            if !alarm_due(*last, now) {
                return Ok(false);
            }
            *last = Some(now);
        }
        tracing::error!(
            pending = backlog.pending,
            stuck = backlog.stuck,
            oldest = ?backlog.oldest,
            last_failure = backlog.last_error.as_deref().unwrap_or_default(),
            "Carpe Diem has refused revocations for about a day; keys that should be dead may still work. \
             An http 404 means the operator has no partner configured (PARTNERS_JSON)."
        );
        Ok(true)
    }

    /// The undelivered part of the outbox, as readiness reports it.
    pub async fn revocation_backlog(&self) -> Result<RevocationBacklog> {
        self.repository.revocation_backlog().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alarm_goes_off_at_most_once_a_day() {
        let now = Utc::now();
        assert!(alarm_due(None, now));
        assert!(!alarm_due(Some(now), now));
        assert!(!alarm_due(Some(now - TimeDelta::hours(23)), now));
        assert!(alarm_due(Some(now - TimeDelta::hours(24)), now));
        assert!(alarm_due(Some(now - TimeDelta::days(3)), now));
    }
}
