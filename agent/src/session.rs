//! Pure session state machine: no I/O, no clock reads beyond what's passed
//! in, no OS calls. This is deliberate -- it is what
//! `docs/offline-expiry.md`'s guarantees actually rest on, and it's the
//! part of the agent that can be exercised exhaustively in unit tests
//! without a real OS session to lock.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SessionStatus {
    Active,
    Expired,
    Ended,
}

/// `rename_all = "camelCase"` makes this struct double as both the on-disk
/// persistence format and the wire shape of the server's `session_state`
/// payload (see client.rs) -- one struct, no duplicate DTO to keep in sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub status: SessionStatus,
    /// The session row's `updatedAt` from the server. Used only for
    /// stale-message rejection, not for expiry math (expiry always uses
    /// `expires_at` compared against the locally trusted clock).
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired {
    /// The machine should be usable.
    Allowed,
    /// The machine should not be usable (no session, ended, or expired).
    Blocked,
}

/// Applies an incoming `session_state` push, rejecting it if it's not newer
/// than the last message we accepted (protects against a stale/reordered
/// message replacing newer local state -- see docs/protocol.md). Returns
/// `true` if the message was applied.
///
/// `message_time` is the session's `updatedAt` when `incoming` is `Some`,
/// or the message's `serverTime` when the server is reporting no active
/// session (`incoming` is `None`) -- both are supplied by the caller since
/// this function has no notion of "the current server time".
pub fn apply_server_message(
    current_session: &mut Option<SessionSnapshot>,
    last_applied_at: &mut DateTime<Utc>,
    incoming: Option<SessionSnapshot>,
    message_time: DateTime<Utc>,
) -> bool {
    if message_time <= *last_applied_at {
        return false;
    }
    *current_session = incoming;
    *last_applied_at = message_time;
    true
}

/// One tick of local enforcement: if the session is `Active` but its
/// `expires_at` has passed according to `trusted_now`, transitions it to
/// `Expired` locally (the source of truth for *this* transition is the
/// agent's own clock, not a server message -- that's the whole point of
/// offline expiry). Returns what the platform layer should currently
/// guarantee.
pub fn advance(session: &mut Option<SessionSnapshot>, trusted_now: DateTime<Utc>) -> Desired {
    if let Some(s) = session {
        if s.status == SessionStatus::Active && trusted_now >= s.expires_at {
            s.status = SessionStatus::Expired;
        }
    }

    match session {
        Some(s) if s.status == SessionStatus::Active && trusted_now < s.expires_at => {
            Desired::Allowed
        }
        _ => Desired::Blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn snapshot(
        status: SessionStatus,
        expires_in: Duration,
        updated_at: DateTime<Utc>,
    ) -> SessionSnapshot {
        SessionSnapshot {
            id: "session-1".into(),
            started_at: Utc::now() - Duration::minutes(1),
            expires_at: Utc::now() + expires_in,
            status,
            updated_at,
        }
    }

    #[test]
    fn no_session_is_blocked() {
        let mut session = None;
        assert_eq!(advance(&mut session, Utc::now()), Desired::Blocked);
    }

    #[test]
    fn active_session_before_expiry_is_allowed() {
        let mut session = Some(snapshot(
            SessionStatus::Active,
            Duration::minutes(10),
            Utc::now(),
        ));
        assert_eq!(advance(&mut session, Utc::now()), Desired::Allowed);
    }

    #[test]
    fn active_session_past_expiry_becomes_locally_expired_and_blocked() {
        let mut session = Some(snapshot(
            SessionStatus::Active,
            Duration::seconds(-1),
            Utc::now(),
        ));
        let desired = advance(&mut session, Utc::now());
        assert_eq!(desired, Desired::Blocked);
        assert_eq!(session.unwrap().status, SessionStatus::Expired);
    }

    #[test]
    fn ended_session_is_blocked() {
        let mut session = Some(snapshot(
            SessionStatus::Ended,
            Duration::minutes(10),
            Utc::now(),
        ));
        assert_eq!(advance(&mut session, Utc::now()), Desired::Blocked);
    }

    #[test]
    fn disconnected_expiry_with_no_server_messages_still_blocks_at_expires_at() {
        // The whole point of local enforcement: no server messages arrive
        // at all between session start and expiry, yet advance() still
        // transitions to Blocked once trusted_now passes expires_at.
        let started = Utc::now();
        let mut session = Some(SessionSnapshot {
            id: "s".into(),
            started_at: started,
            expires_at: started + Duration::minutes(30),
            status: SessionStatus::Active,
            updated_at: started,
        });

        assert_eq!(
            advance(&mut session, started + Duration::minutes(29)),
            Desired::Allowed
        );
        assert_eq!(
            advance(&mut session, started + Duration::minutes(31)),
            Desired::Blocked
        );
    }

    #[test]
    fn restarting_with_a_persisted_active_session_does_not_reset_the_timer() {
        // Simulates loading a previously-persisted session after an agent
        // restart: advance() must judge it purely from expires_at, with no
        // notion of "session just started" -- restarting cannot grant time.
        let started_long_ago = Utc::now() - Duration::hours(1);
        let mut session = Some(SessionSnapshot {
            id: "s".into(),
            started_at: started_long_ago,
            expires_at: started_long_ago + Duration::minutes(30),
            status: SessionStatus::Active,
            updated_at: started_long_ago,
        });

        assert_eq!(advance(&mut session, Utc::now()), Desired::Blocked);
    }

    #[test]
    fn extending_a_session_pushes_expiry_out() {
        let started = Utc::now();
        let mut session = Some(SessionSnapshot {
            id: "s".into(),
            started_at: started,
            expires_at: started + Duration::minutes(5),
            status: SessionStatus::Active,
            updated_at: started,
        });
        assert_eq!(
            advance(&mut session, started + Duration::minutes(6)),
            Desired::Blocked
        );

        // Server pushes an extension (later updated_at, later expires_at).
        let mut last_applied_at = started;
        let extended = SessionSnapshot {
            expires_at: started + Duration::minutes(20),
            updated_at: started + Duration::minutes(6),
            status: SessionStatus::Active,
            ..session.clone().unwrap()
        };
        let extended_updated_at = extended.updated_at;
        apply_server_message(
            &mut session,
            &mut last_applied_at,
            Some(extended),
            extended_updated_at,
        );

        assert_eq!(
            advance(&mut session, started + Duration::minutes(10)),
            Desired::Allowed
        );
    }

    #[test]
    fn stale_message_is_rejected_and_does_not_replace_newer_local_state() {
        let base = Utc::now();
        let mut session = Some(snapshot(SessionStatus::Active, Duration::minutes(30), base));
        let mut last_applied_at = base;

        // A message that is OLDER than what we already applied must be ignored.
        let stale = snapshot(
            SessionStatus::Ended,
            Duration::minutes(30),
            base - Duration::seconds(5),
        );
        let applied = apply_server_message(
            &mut session,
            &mut last_applied_at,
            Some(stale),
            base - Duration::seconds(5),
        );

        assert!(!applied);
        assert_eq!(session.unwrap().status, SessionStatus::Active);
    }

    #[test]
    fn newer_message_reporting_no_active_session_is_applied() {
        let base = Utc::now();
        let mut session = Some(snapshot(SessionStatus::Active, Duration::minutes(30), base));
        let mut last_applied_at = base;

        let server_time = base + Duration::seconds(5);
        let applied = apply_server_message(&mut session, &mut last_applied_at, None, server_time);

        assert!(applied);
        assert!(session.is_none());
        assert_eq!(last_applied_at, server_time);
    }

    #[test]
    fn reconciliation_after_reconnect_prefers_the_servers_view_when_newer() {
        // Agent was offline, locally marked the session Expired. On
        // reconnect the server (which independently expired it too, but
        // recorded a slightly different -- newer -- updatedAt from its own
        // sweep) pushes its view; it should win because it's newer.
        let base = Utc::now();
        let mut session = Some(snapshot(
            SessionStatus::Expired,
            Duration::minutes(-5),
            base,
        ));
        let mut last_applied_at = base;

        let servers_view = snapshot(
            SessionStatus::Expired,
            Duration::minutes(-5),
            base + Duration::seconds(1),
        );
        let msg_time = servers_view.updated_at;
        let applied = apply_server_message(
            &mut session,
            &mut last_applied_at,
            Some(servers_view),
            msg_time,
        );

        assert!(applied);
        assert_eq!(session.unwrap().status, SessionStatus::Expired);
    }
}
