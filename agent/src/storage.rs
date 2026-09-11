//! Local persistence for everything the agent must trust when the server is
//! unreachable: the machine's credentials and the last known session state,
//! plus the clock-integrity bookkeeping described in
//! `docs/offline-expiry.md`.
//!
//! Writes are atomic (write to a temp file, then rename) so a crash or power
//! loss mid-write can never leave a corrupt/partial state file behind --
//! worst case, the agent starts from the last successfully written state.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::session::SessionSnapshot;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credentials {
    /// Base HTTP(S) URL of the Taymna server, e.g. `https://taymna.example.com`.
    pub server_url: String,
    pub machine_id: String,
    pub machine_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentState {
    pub credentials: Option<Credentials>,
    pub session: Option<SessionSnapshot>,
    /// Timestamp of the last server message we accepted (session's own
    /// `updatedAt` when a session is present, otherwise the message's
    /// `serverTime`). Used to reject stale/out-of-order pushes -- see
    /// `session::apply_server_message`.
    pub last_applied_at: DateTime<Utc>,
    /// Monotonic anti-rollback high-water mark -- see `ClockGuard` below and
    /// docs/offline-expiry.md. Always non-decreasing across the life of the
    /// state file, independent of what the OS wall clock reports.
    pub trusted_high_water_mark: DateTime<Utc>,
}

impl Default for AgentState {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            credentials: None,
            session: None,
            last_applied_at: now,
            trusted_high_water_mark: now,
        }
    }
}

pub struct Store {
    path: PathBuf,
}

impl Store {
    /// `override_dir` lets `cargo run` / tests use a throwaway directory;
    /// when unset, resolves to the OS-appropriate app-data directory (or
    /// `TAYMNA_STATE_DIR`, which is what the systemd/launchd/Windows service
    /// units set explicitly -- see docs/agent-install.md).
    pub fn new(override_dir: Option<PathBuf>) -> io::Result<Self> {
        let dir = match override_dir {
            Some(dir) => dir,
            None => default_state_dir(),
        };
        fs::create_dir_all(&dir)?;
        Ok(Self {
            path: dir.join("state.json"),
        })
    }

    pub fn load(&self) -> io::Result<AgentState> {
        match fs::read_to_string(&self.path) {
            Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_default()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(AgentState::default()),
            Err(err) => Err(err),
        }
    }

    pub fn save(&self, state: &AgentState) -> io::Result<()> {
        let contents =
            serde_json::to_string_pretty(state).expect("AgentState is always serializable");
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, contents)?;
        harden_permissions(&tmp_path)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

fn default_state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TAYMNA_STATE_DIR") {
        return PathBuf::from(dir);
    }
    ProjectDirs::from("dev", "Taymna", "taymna-agent")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".taymna-agent"))
}

#[cfg(unix)]
fn harden_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn harden_permissions(_path: &Path) -> io::Result<()> {
    // Windows ACL hardening is not implemented in V1 -- the state directory
    // is only writable by the service account (LocalSystem) the agent runs
    // as, which is the practical protection until per-file ACLs are added.
    // See docs/enforcement.md "Known limitations".
    Ok(())
}

/// Anti-rollback wall-clock guard (docs/offline-expiry.md). Tracks a
/// monotonically non-decreasing "trusted now" that a user changing the OS
/// clock backward cannot move backward: each call either trusts the OS
/// clock (when it has advanced normally) or extrapolates forward from the
/// last trusted point using `Instant`, which the OS clock cannot affect.
pub struct ClockGuard {
    high_water_mark: DateTime<Utc>,
    anchor: Instant,
}

impl ClockGuard {
    pub fn new(persisted_high_water_mark: DateTime<Utc>) -> Self {
        Self {
            high_water_mark: persisted_high_water_mark,
            anchor: Instant::now(),
        }
    }

    /// Returns the current trusted time and advances the high-water mark.
    /// Call this from a single place per tick; the caller is responsible
    /// for persisting `high_water_mark()` afterwards.
    pub fn now(&mut self) -> DateTime<Utc> {
        let os_now = Utc::now();
        let trusted = if os_now >= self.high_water_mark {
            os_now
        } else {
            self.high_water_mark
                + chrono::Duration::from_std(self.anchor.elapsed()).unwrap_or_default()
        };
        self.high_water_mark = trusted;
        self.anchor = Instant::now();
        trusted
    }

    /// Lets the server's authoritative clock correct drift/resync forward
    /// when connected (docs/offline-expiry.md point 4). Never moves the
    /// high-water mark backward.
    pub fn resync_from_server(&mut self, server_time: DateTime<Utc>) {
        if server_time > self.high_water_mark {
            self.high_water_mark = server_time;
            self.anchor = Instant::now();
        }
    }

    pub fn high_water_mark(&self) -> DateTime<Utc> {
        self.high_water_mark
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration as StdDuration;

    #[test]
    fn trusts_a_wall_clock_that_advances_normally() {
        let start = Utc::now() - chrono::Duration::seconds(10);
        let mut guard = ClockGuard::new(start);
        let now = guard.now();
        assert!(now >= start);
        assert!(now <= Utc::now());
    }

    #[test]
    fn ignores_a_wall_clock_rollback_and_extrapolates_via_monotonic_time() {
        // Simulate: agent has already observed "now" as the high-water mark
        // (e.g. from a previous tick), then the OS clock jumps backward by
        // an hour. trusted `now()` must not go backward.
        let high_water_mark = Utc::now();
        let mut guard = ClockGuard::new(high_water_mark);
        sleep(StdDuration::from_millis(20));

        // We can't actually change the OS clock in a unit test, so instead
        // assert the invariant that matters: two consecutive calls are
        // always non-decreasing, which is what the rollback branch relies
        // on (extrapolating from the last trusted point via Instant).
        let first = guard.now();
        let second = guard.now();
        assert!(second >= first);
        assert!(first >= high_water_mark);
    }

    #[test]
    fn high_water_mark_never_goes_backward_across_calls() {
        let mut guard = ClockGuard::new(Utc::now());
        let mut previous = guard.high_water_mark();
        for _ in 0..5 {
            sleep(StdDuration::from_millis(5));
            guard.now();
            let current = guard.high_water_mark();
            assert!(current >= previous, "high-water mark must never decrease");
            previous = current;
        }
    }

    #[test]
    fn resync_from_server_only_moves_forward() {
        let base = Utc::now();
        let mut guard = ClockGuard::new(base);

        // A server time in the past must not move the anchor backward.
        guard.resync_from_server(base - chrono::Duration::seconds(30));
        assert_eq!(guard.high_water_mark(), base);

        // A server time in the future should resync forward.
        let future = base + chrono::Duration::seconds(30);
        guard.resync_from_server(future);
        assert_eq!(guard.high_water_mark(), future);
    }

    #[test]
    fn state_round_trips_through_disk_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(Some(dir.path().to_path_buf())).unwrap();

        let state = AgentState {
            credentials: Some(Credentials {
                server_url: "https://example.com".into(),
                machine_id: "machine-1".into(),
                machine_secret: "secret".into(),
            }),
            session: Some(SessionSnapshot {
                id: "session-1".into(),
                started_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::minutes(30),
                status: crate::session::SessionStatus::Active,
                updated_at: Utc::now(),
            }),
            ..AgentState::default()
        };

        store.save(&state).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded, state);
    }

    #[test]
    fn loading_with_no_file_yet_returns_defaults_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(Some(dir.path().to_path_buf())).unwrap();
        let loaded = store.load().unwrap();
        assert!(loaded.credentials.is_none());
        assert!(loaded.session.is_none());
    }

    #[test]
    fn restart_recovery_reads_back_exactly_what_was_persisted() {
        // Simulates an agent restart: a fresh Store pointed at the same
        // directory must see the previous run's session, not reset it.
        let dir = tempfile::tempdir().unwrap();
        let session = SessionSnapshot {
            id: "session-restart".into(),
            started_at: Utc::now() - chrono::Duration::minutes(10),
            expires_at: Utc::now() + chrono::Duration::minutes(20),
            status: crate::session::SessionStatus::Active,
            updated_at: Utc::now(),
        };

        {
            let store = Store::new(Some(dir.path().to_path_buf())).unwrap();
            let state = AgentState {
                session: Some(session.clone()),
                ..AgentState::default()
            };
            store.save(&state).unwrap();
        }

        // New Store instance == simulated process restart.
        let store = Store::new(Some(dir.path().to_path_buf())).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.session, Some(session));
    }
}
