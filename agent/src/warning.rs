//! Expiry warnings: deciding *what, if anything, the user should be told*
//! as an active session runs down -- and nothing else.
//!
//! Two properties this module exists to keep true:
//!
//! 1. **Warnings are UX, enforcement is authoritative.** Nothing here can
//!    delay, prevent or extend expiry. `main.rs` deliberately runs
//!    `session::advance()` and the platform enforcement call *first* and
//!    only then asks this module what to show, and delivery happens on a
//!    separate thread whose failure or death is invisible to the loop.
//! 2. **It is decided locally, from the same numbers expiry uses.** The
//!    input is the session snapshot plus the `ClockGuard`-derived trusted
//!    "now" -- the identical pair `session::advance()` judges expiry from.
//!    There is no second timing authority, no server-scheduled warning, and
//!    no network dependency.
//!
//! The decision logic is pure (no I/O, no clock reads, no OS calls), which
//! is what makes the whole table of restart/extension/short-session cases
//! in `docs/expiry-warnings.md` testable deterministically below.

use chrono::{DateTime, Utc};

use crate::platform::{Notice, Urgency, UserNotifier};
use crate::session::{SessionSnapshot, SessionStatus};

/// Thresholds, in seconds remaining. Ordered most to least time left.
const TEN_MINUTES: i64 = 10 * 60;
const FIVE_MINUTES: i64 = 5 * 60;
const ONE_MINUTE: i64 = 60;
const FINAL: i64 = 30;

/// How long a gap between two evaluations still counts as "the agent was
/// watching". The tick is ~2 seconds, so anything beyond this means the
/// agent was not there to warn -- suspended, descheduled, or just started --
/// and it should announce where the session *is* rather than resume walking
/// a ladder it has already fallen off. Deliberately equal to the final
/// threshold: a gap that long can swallow the last warning whole.
const CONTINUITY_GAP: i64 = 30;

/// The warning levels, ordered by increasing urgency -- the derived `Ord`
/// is load-bearing: a level only fires if it is *more* urgent than the most
/// urgent one already fired for the current deadline, which is what both
/// deduplicates repeated ticks and stops a late/skipped tick from replaying
/// thresholds it has already passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    TenMinutes,
    FiveMinutes,
    OneMinute,
    Final,
}

/// What the platform layer should do about it. Deliberately a value, not a
/// call: `reconcile()` stays pure and testable, and delivery is somebody
/// else's (fallible, isolated) problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WarningEffect {
    /// A native OS notification in the interactive user's session.
    Notify(Notice),
    /// The prominent final warning, with the seconds left when it was
    /// decided (platforms that can count down live take it from here).
    ShowFinalWarning { remaining_secs: i64 },
    /// Take down a final warning that is (or may be) still on screen.
    DismissFinalWarning,
}

/// Identifies *the deadline currently being warned about*, not the session.
/// An extension keeps the session id and moves `expires_at`, which must
/// reset the warning lifecycle; a replacement session changes the id. Both
/// are a new key, and a new key means "start over".
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeadlineKey {
    session_id: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct ExpiryWarnings {
    /// The deadline the state below belongs to. `None` means there is
    /// nothing to warn about (no session, or it is no longer ACTIVE).
    key: Option<DeadlineKey>,
    /// Most urgent level already fired for `key`.
    fired: Option<Level>,
    /// When this deadline was last evaluated, or `None` for a deadline
    /// never evaluated yet. The gap to `now` is what separates "the agent
    /// has been counting down with the user" from "the agent has been away"
    /// -- see `arriving_late_level`.
    last_seen: Option<DateTime<Utc>>,
    /// Whether a final warning is believed to be on screen, so it can be
    /// taken down when the deadline changes or the session ends.
    final_visible: bool,
}

impl ExpiryWarnings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called once per enforcement tick, *after* enforcement has run.
    /// `now` must be the same trusted time `session::advance()` was given.
    pub fn reconcile(
        &mut self,
        session: Option<&SessionSnapshot>,
        now: DateTime<Utc>,
    ) -> Vec<WarningEffect> {
        let mut effects = Vec::new();

        // Only an ACTIVE session has a deadline worth warning about. A
        // session that ended, expired, was replaced, or was extended
        // produces a different key (or none) and resets everything.
        let key = session
            .filter(|s| s.status == SessionStatus::Active)
            .map(|s| DeadlineKey {
                session_id: s.id.clone(),
                expires_at: s.expires_at,
            });

        if key != self.key {
            self.dismiss_final(&mut effects);
            self.key = key;
            self.fired = None;
            self.last_seen = None;
        }

        let Some(deadline) = self.key.as_ref() else {
            return effects;
        };

        // Truncating toward zero is deliberate: 9m59.4s left reads as 599,
        // which crosses the 10-minute threshold slightly early rather than
        // slightly late. Expiry itself is unaffected -- it compares the
        // full-precision timestamps, not this.
        let remaining = (deadline.expires_at - now).num_seconds();
        let previous = self.last_seen.replace(now);

        if remaining <= 0 {
            // The deadline has passed: enforcement has already locked (or
            // is locking) this same tick. Warning about it now would be
            // obsolete noise -- e.g. a laptop that slept through expiry --
            // so the only thing left to do is clear any stale UI.
            self.dismiss_final(&mut effects);
            return effects;
        }

        // A first look at this deadline, a machine that just woke, a
        // process that just started: all the same thing as far as the user
        // is concerned -- nothing was shown while the agent was away.
        let arrived_late = previous.is_none_or(|last| (now - last).num_seconds() > CONTINUITY_GAP);
        let Some(level) = (if arrived_late {
            arriving_late_level(remaining)
        } else {
            level_for(remaining)
        }) else {
            return effects;
        };

        // Dedup + no replaying already-passed thresholds: only ever move
        // toward more urgent.
        if self.fired.is_some_and(|already| level <= already) {
            return effects;
        }
        self.fired = Some(level);

        match level {
            Level::Final => {
                self.final_visible = true;
                effects.push(WarningEffect::ShowFinalWarning {
                    remaining_secs: remaining,
                });
            }
            _ => effects.push(WarningEffect::Notify(notice_for(level, remaining))),
        }

        effects
    }

    fn dismiss_final(&mut self, effects: &mut Vec<WarningEffect>) {
        if self.final_visible {
            self.final_visible = false;
            effects.push(WarningEffect::DismissFinalWarning);
        }
    }
}

/// The level a *continuously running* agent crosses into at `remaining`.
fn level_for(remaining: i64) -> Option<Level> {
    match remaining {
        r if r <= FINAL => Some(Level::Final),
        r if r <= ONE_MINUTE => Some(Level::OneMinute),
        r if r <= FIVE_MINUTES => Some(Level::FiveMinutes),
        r if r <= TEN_MINUTES => Some(Level::TenMinutes),
        _ => None,
    }
}

/// The level for an evaluation that did not follow on from a recent one --
/// an agent restart, a machine waking from sleep, a session that starts
/// shorter than a threshold, or an extension landing inside one.
///
/// It is `level_for` with one deliberate exception: inside the last minute
/// the prominent final warning is shown straight away instead of a
/// transient "1 minute remaining" toast that would be superseded seconds
/// later. Arriving at 0:40 should look like the end of a session, not the
/// start of a countdown.
///
/// Note what it does *not* do: replay every threshold already passed.
/// Exactly one level fires, and `reconcile` marks it as the high-water mark
/// so the levels above it can never fire afterwards.
fn arriving_late_level(remaining: i64) -> Option<Level> {
    if remaining <= ONE_MINUTE {
        Some(Level::Final)
    } else {
        level_for(remaining)
    }
}

/// Copy for a threshold notification.
///
/// The headline states the time **actually** left, rounded to the nearest
/// minute, rather than the threshold's nominal name. On a continuous
/// countdown the two are the same ("10 minutes remaining" at the 10-minute
/// crossing); where they differ -- a 3-minute session, an agent restarting
/// with 4m30s left -- the honest number is the one worth showing, and it
/// removes any need to suppress "wrong" warnings for short sessions.
fn notice_for(level: Level, remaining: i64) -> Notice {
    let minutes = (remaining + 30) / 60; // nearest minute; never 0 here (remaining > 60)
    let title = format!(
        "{minutes} minute{} remaining",
        if minutes == 1 { "" } else { "s" }
    );

    let (body, urgency) = match level {
        Level::TenMinutes => (
            "Your Taymna session will end soon. Save your work before time runs out.",
            Urgency::Normal,
        ),
        Level::FiveMinutes => (
            "Save your work and sign out of your accounts before this computer locks.",
            Urgency::Normal,
        ),
        // The last routine notification before the prominent warning, so it
        // is the one worth raising on platforms that distinguish urgency.
        Level::OneMinute | Level::Final => (
            "Your session is about to end. Save your work and sign out now.",
            Urgency::Critical,
        ),
    };

    Notice {
        title,
        body,
        urgency,
    }
}

/// Hands one decided effect to the OS. Every platform implementation is
/// infallible by contract (it logs and returns), so nothing a notification
/// daemon, a missing binary or a locked-down desktop does can propagate
/// back into the enforcement loop.
pub fn apply(notifier: &dyn UserNotifier, effect: &WarningEffect) {
    match effect {
        WarningEffect::Notify(notice) => notifier.notify(notice),
        WarningEffect::ShowFinalWarning { remaining_secs } => {
            notifier.show_final_warning(*remaining_secs)
        }
        WarningEffect::DismissFinalWarning => notifier.dismiss_final_warning(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{advance, Desired};
    use chrono::{Duration, TimeZone};

    fn base() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap()
    }

    fn session(id: &str, expires_at: DateTime<Utc>) -> SessionSnapshot {
        SessionSnapshot {
            id: id.into(),
            started_at: expires_at - Duration::hours(1),
            expires_at,
            status: SessionStatus::Active,
            updated_at: expires_at - Duration::hours(1),
        }
    }

    /// `reconcile` at `expires_at - remaining`, which is how every test
    /// below expresses "the agent ticked with N seconds left".
    fn tick_at(
        warnings: &mut ExpiryWarnings,
        s: &SessionSnapshot,
        remaining: Duration,
    ) -> Vec<WarningEffect> {
        warnings.reconcile(Some(s), s.expires_at - remaining)
    }

    /// Drives the warnings the way the agent actually does: a tick every
    /// TICK_INTERVAL seconds, from `from` seconds remaining down to `to`.
    /// Several tests depend on this cadence rather than on isolated jumps,
    /// because continuity between ticks is itself part of the logic.
    fn count_down(
        warnings: &mut ExpiryWarnings,
        s: &SessionSnapshot,
        from: i64,
        to: i64,
    ) -> Vec<WarningEffect> {
        let mut collected = Vec::new();
        let mut remaining = from;
        while remaining >= to {
            collected
                .extend(warnings.reconcile(Some(s), s.expires_at - Duration::seconds(remaining)));
            remaining -= 2;
        }
        collected
    }

    fn titles(effects: &[WarningEffect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|e| match e {
                WarningEffect::Notify(n) => Some(n.title.clone()),
                _ => None,
            })
            .collect()
    }

    // 1. Normal countdown: 11m -> 10m -> 5m -> 1m -> final -> expiry.
    #[test]
    fn normal_countdown_fires_each_threshold_once_in_order() {
        let s = session("s1", base() + Duration::hours(2));
        let mut w = ExpiryWarnings::new();

        // One uninterrupted run from 11 minutes out to the deadline.
        let effects = count_down(&mut w, &s, 11 * 60, 0);

        assert_eq!(
            titles(&effects),
            [
                "10 minutes remaining",
                "5 minutes remaining",
                "1 minute remaining"
            ]
        );
        // ...and, around them, exactly one final warning shown and -- at
        // zero, where enforcement takes over -- taken down again.
        let non_notifications: Vec<_> = effects
            .iter()
            .filter(|e| !matches!(e, WarningEffect::Notify(_)))
            .collect();
        assert_eq!(
            non_notifications,
            [
                &WarningEffect::ShowFinalWarning { remaining_secs: 30 },
                &WarningEffect::DismissFinalWarning
            ]
        );
    }

    #[test]
    fn the_one_minute_warning_is_raised_in_urgency() {
        let s = session("s1", base() + Duration::hours(2));
        let mut w = ExpiryWarnings::new();

        let effects = count_down(&mut w, &s, 11 * 60, 32);
        match effects.last() {
            Some(WarningEffect::Notify(n)) => {
                assert_eq!(n.title, "1 minute remaining");
                assert_eq!(n.urgency, Urgency::Critical);
            }
            other => panic!("expected the 1-minute notification last, got {other:?}"),
        }
    }

    // 2. No duplicate warning on repeated ticks.
    #[test]
    fn a_threshold_fires_at_most_once_however_many_ticks_pass_inside_it() {
        let s = session("s1", base() + Duration::hours(2));
        let mut w = ExpiryWarnings::new();

        assert_eq!(tick_at(&mut w, &s, Duration::minutes(10)).len(), 1);
        // The ~2s enforcement loop keeps ticking through the whole window.
        for offset in (0..150).map(|i| Duration::seconds(600 - i * 2)) {
            assert!(
                tick_at(&mut w, &s, offset).is_empty(),
                "re-fired with {offset} left"
            );
        }
    }

    // 3. A tick that skips over a threshold still fires it.
    #[test]
    fn a_late_tick_that_jumps_past_a_threshold_still_fires_it() {
        let s = session("s1", base() + Duration::hours(2));
        let mut w = ExpiryWarnings::new();

        // An established countdown, already past the 10-minute warning.
        assert_eq!(
            titles(&count_down(&mut w, &s, 610, 303)),
            ["10 minutes remaining"]
        );

        // The loop is late and its next tick lands past 5:00 entirely.
        assert_eq!(
            titles(&tick_at(&mut w, &s, Duration::seconds(299))),
            ["5 minutes remaining"]
        );
    }

    // 4. Startup with 4m30s remaining: one appropriate warning, not a burst.
    #[test]
    fn starting_up_mid_window_warns_once_with_the_real_time_left() {
        let s = session("s1", base() + Duration::seconds(270));
        let mut w = ExpiryWarnings::new();

        // 4m30s rounds to the 5-minute copy, which is both the right
        // threshold and an honest headline.
        assert_eq!(
            titles(&tick_at(&mut w, &s, Duration::seconds(270))),
            ["5 minutes remaining"]
        );
        // ...and the 10-minute warning it already missed never appears.
        assert!(tick_at(&mut w, &s, Duration::seconds(268)).is_empty());
        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(30)),
            [WarningEffect::ShowFinalWarning { remaining_secs: 30 }]
        );
    }

    // 5. Startup with 40s remaining: the final warning only.
    #[test]
    fn starting_up_inside_the_last_minute_goes_straight_to_the_final_warning() {
        let s = session("s1", base() + Duration::seconds(40));
        let mut w = ExpiryWarnings::new();

        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(40)),
            [WarningEffect::ShowFinalWarning { remaining_secs: 40 }]
        );
        // Nothing else, all the way down -- not even the 30s crossing.
        for remaining in (1..40).rev() {
            assert!(tick_at(&mut w, &s, Duration::seconds(remaining)).is_empty());
        }
    }

    // 6. A short session must not produce a burst of missed warnings.
    #[test]
    fn a_three_minute_session_warns_once_honestly_then_counts_down() {
        let s = session("short", base() + Duration::minutes(3));
        let mut w = ExpiryWarnings::new();

        // The very first tick of a session shorter than both the 10- and
        // 5-minute thresholds: one true thing, not two stale ones.
        let first = tick_at(&mut w, &s, Duration::minutes(3));
        assert_eq!(titles(&first), ["3 minutes remaining"]);
        assert_eq!(first.len(), 1, "no 10m/5m burst: {first:?}");

        // From there the ladder continues normally to the deadline.
        let rest = count_down(&mut w, &s, 178, 0);
        assert_eq!(titles(&rest), ["1 minute remaining"]);
        assert!(rest.contains(&WarningEffect::ShowFinalWarning { remaining_secs: 30 }));
        assert_eq!(rest.last(), Some(&WarningEffect::DismissFinalWarning));
    }

    // 7. A 20-second session: the final warning, and nothing else.
    #[test]
    fn a_twenty_second_session_shows_only_the_final_warning() {
        let s = session("tiny", base() + Duration::seconds(20));
        let mut w = ExpiryWarnings::new();

        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(20)),
            [WarningEffect::ShowFinalWarning { remaining_secs: 20 }]
        );
        assert!(tick_at(&mut w, &s, Duration::seconds(10)).is_empty());
        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(0)),
            [WarningEffect::DismissFinalWarning]
        );
    }

    // 8. Extension after a warning: state reconciles against the NEW deadline.
    #[test]
    fn extending_resets_the_lifecycle_and_warns_again_on_the_new_deadline() {
        let s = session("s1", base() + Duration::minutes(5));
        let mut w = ExpiryWarnings::new();
        assert_eq!(
            titles(&tick_at(&mut w, &s, Duration::minutes(5))),
            ["5 minutes remaining"]
        );

        // Operator adds two hours: same session id, new expiresAt.
        let extended = SessionSnapshot {
            expires_at: s.expires_at + Duration::hours(2),
            ..s.clone()
        };
        assert!(tick_at(&mut w, &extended, Duration::hours(2)).is_empty());

        // The whole ladder is available again against the new deadline.
        assert_eq!(
            titles(&tick_at(&mut w, &extended, Duration::minutes(10))),
            ["10 minutes remaining"]
        );
        assert_eq!(
            titles(&tick_at(&mut w, &extended, Duration::minutes(5))),
            ["5 minutes remaining"]
        );
    }

    // 9. Extension while the final warning is on screen: it is taken down.
    #[test]
    fn extending_during_the_final_warning_dismisses_it() {
        let s = session("s1", base() + Duration::seconds(30));
        let mut w = ExpiryWarnings::new();
        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(30)),
            [WarningEffect::ShowFinalWarning { remaining_secs: 30 }]
        );

        let extended = SessionSnapshot {
            expires_at: s.expires_at + Duration::hours(1),
            ..s.clone()
        };
        assert_eq!(
            tick_at(&mut w, &extended, Duration::hours(1)),
            [WarningEffect::DismissFinalWarning]
        );
        // ...and it is not left believing something is still on screen.
        assert!(tick_at(&mut w, &extended, Duration::minutes(30)).is_empty());
    }

    // 10. Session ends early.
    #[test]
    fn a_session_ending_early_dismisses_the_final_warning_and_stops_warning() {
        let s = session("s1", base() + Duration::seconds(30));
        let mut w = ExpiryWarnings::new();
        let _ = tick_at(&mut w, &s, Duration::seconds(30));

        let ended = SessionSnapshot {
            status: SessionStatus::Ended,
            ..s.clone()
        };
        assert_eq!(
            w.reconcile(Some(&ended), base()),
            [WarningEffect::DismissFinalWarning]
        );
        // The server may also just report "no session at all".
        assert!(w.reconcile(None, base()).is_empty());
        assert!(w.reconcile(None, base() + Duration::minutes(1)).is_empty());
    }

    // 11. A different session replaces the current one.
    #[test]
    fn a_replacement_session_starts_a_fresh_warning_lifecycle() {
        let first = session("first", base() + Duration::minutes(5));
        let mut w = ExpiryWarnings::new();
        assert_eq!(
            titles(&tick_at(&mut w, &first, Duration::minutes(5))),
            ["5 minutes remaining"]
        );

        // Same deadline instant, different session: still a new lifecycle.
        let second = session("second", first.expires_at);
        assert_eq!(
            titles(&tick_at(&mut w, &second, Duration::minutes(4))),
            ["4 minutes remaining"]
        );
    }

    // 12. Duplicate / repeated session_state for the same deadline.
    #[test]
    fn a_repeated_session_state_for_the_same_deadline_does_not_re_warn() {
        let s = session("s1", base() + Duration::minutes(10));
        let mut w = ExpiryWarnings::new();
        assert_eq!(tick_at(&mut w, &s, Duration::minutes(10)).len(), 1);

        // A reconnect re-push carrying the same session (new updatedAt, same
        // id and expiresAt) is the same deadline -- nothing to re-announce.
        let repushed = SessionSnapshot {
            updated_at: s.updated_at + Duration::minutes(1),
            ..s.clone()
        };
        assert!(tick_at(&mut w, &repushed, Duration::minutes(9)).is_empty());
    }

    // 13. Waking / restarting after expiry: lock, no obsolete warning.
    #[test]
    fn waking_after_expiry_warns_about_nothing_and_still_expires() {
        let mut s = session("s1", base() + Duration::minutes(8));
        let mut w = ExpiryWarnings::new();

        // Slept for ten minutes with eight left: enforcement runs first and
        // transitions the session locally...
        let woke_at = s.expires_at + Duration::minutes(2);
        let mut held = Some(s.clone());
        assert_eq!(advance(&mut held, woke_at), Desired::Blocked);
        assert_eq!(held.as_ref().unwrap().status, SessionStatus::Expired);

        // ...and the warning layer has nothing to say about it.
        assert!(w.reconcile(held.as_ref(), woke_at).is_empty());

        // Even fed a still-ACTIVE snapshot whose deadline has passed (the
        // ordering enforcement guarantees, asserted anyway), it stays quiet.
        s.status = SessionStatus::Active;
        assert!(ExpiryWarnings::new()
            .reconcile(Some(&s), woke_at)
            .is_empty());
    }

    // 14. Waking with under a minute legitimately left.
    #[test]
    fn waking_inside_the_last_minute_shows_the_final_warning_for_the_real_time_left() {
        let s = session("s1", base() + Duration::minutes(8));
        let mut w = ExpiryWarnings::new();
        assert_eq!(
            titles(&tick_at(&mut w, &s, Duration::minutes(8))),
            ["8 minutes remaining"]
        );

        // Slept through 5m and 1m; wakes with 40s left. One warning, the
        // most urgent one that is still true -- not a "1 minute remaining"
        // toast that the final warning would supersede ten seconds later.
        assert_eq!(
            tick_at(&mut w, &s, Duration::seconds(40)),
            [WarningEffect::ShowFinalWarning { remaining_secs: 40 }]
        );
        assert!(tick_at(&mut w, &s, Duration::seconds(20)).is_empty());
    }

    // 15. A notification implementation that delivers nothing at all must
    //     not change expiry, enforcement, or the decisions that follow.
    #[test]
    fn a_notifier_that_fails_every_call_changes_nothing_about_expiry() {
        struct AlwaysFails;
        impl UserNotifier for AlwaysFails {
            // Real implementations log and return on every OS error; this
            // stands in for "every one of those paths was taken".
            fn notify(&self, _notice: &Notice) {}
            fn show_final_warning(&self, _remaining_secs: i64) {}
            fn dismiss_final_warning(&self) {}
        }

        let s = session("s1", base() + Duration::minutes(11));
        let mut w = ExpiryWarnings::new();
        let mut held = Some(s.clone());

        for remaining in [660, 600, 300, 60, 30, 10] {
            let now = s.expires_at - Duration::seconds(remaining);
            assert_eq!(advance(&mut held, now), Desired::Allowed);
            for effect in w.reconcile(held.as_ref(), now) {
                apply(&AlwaysFails, &effect);
            }
        }

        // Still blocked exactly at expires_at, warnings or no warnings.
        assert_eq!(advance(&mut held, s.expires_at), Desired::Blocked);
        assert_eq!(held.unwrap().status, SessionStatus::Expired);
    }

    #[test]
    fn headlines_round_to_the_nearest_minute() {
        assert_eq!(
            notice_for(Level::TenMinutes, 600).title,
            "10 minutes remaining"
        );
        assert_eq!(
            notice_for(Level::FiveMinutes, 299).title,
            "5 minutes remaining"
        );
        assert_eq!(
            notice_for(Level::FiveMinutes, 270).title,
            "5 minutes remaining"
        );
        assert_eq!(
            notice_for(Level::FiveMinutes, 180).title,
            "3 minutes remaining"
        );
        assert_eq!(notice_for(Level::OneMinute, 61).title, "1 minute remaining");
    }

    #[test]
    fn thresholds_map_to_the_expected_levels() {
        assert_eq!(level_for(601), None);
        assert_eq!(level_for(600), Some(Level::TenMinutes));
        assert_eq!(level_for(301), Some(Level::TenMinutes));
        assert_eq!(level_for(300), Some(Level::FiveMinutes));
        assert_eq!(level_for(61), Some(Level::FiveMinutes));
        assert_eq!(level_for(60), Some(Level::OneMinute));
        assert_eq!(level_for(31), Some(Level::OneMinute));
        assert_eq!(level_for(30), Some(Level::Final));
        assert_eq!(level_for(1), Some(Level::Final));

        // Arriving late differs only inside the last minute.
        assert_eq!(arriving_late_level(601), None);
        assert_eq!(arriving_late_level(600), Some(Level::TenMinutes));
        assert_eq!(arriving_late_level(61), Some(Level::FiveMinutes));
        assert_eq!(arriving_late_level(60), Some(Level::Final));
        assert_eq!(arriving_late_level(31), Some(Level::Final));
    }
}
