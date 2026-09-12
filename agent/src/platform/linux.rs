//! Linux enforcement: lock the active graphical session via systemd-logind.
//!
//! Guarantees and limitations are documented in detail in
//! docs/enforcement.md; summarized here:
//!
//! - Requires systemd-logind (virtually universal on modern distros) and a
//!   desktop environment that implements the logind Lock/Unlock D-Bus
//!   signal. GNOME, KDE Plasma, and most major DEs do this out of the box;
//!   minimal window managers (i3, sway without a locker, etc.) need a
//!   logind-aware screen locker installed separately (e.g. `light-locker`)
//!   -- documented as a prerequisite, not silently unsupported.
//! - Only locks an already-unlocked interactive session. It does not block
//!   a fresh login at the greeter/login-screen after a reboot, and it
//!   cannot stop a user who knows their own OS account password from
//!   unlocking -- Taymna's local re-assertion loop (see main.rs) re-locks
//!   within one tick (~2s) if that happens while the session should be
//!   blocked.
//! - Runs `loginctl lock-sessions` by shelling out to the `loginctl` binary
//!   (talks to logind over D-Bus under the hood) rather than depending on a
//!   D-Bus client crate, keeping the dependency surface small.

use std::process::Command;
use std::sync::Mutex;

use tracing::{error, warn};

use super::{
    Enforcement, Notice, Urgency, UserNotifier, APP_NAME, FINAL_WARNING_BODY,
    FINAL_WARNING_HEADLINE,
};

pub struct LinuxEnforcement;

impl LinuxEnforcement {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LinuxEnforcement {
    fn default() -> Self {
        Self::new()
    }
}

impl Enforcement for LinuxEnforcement {
    fn disable_usage(&self) {
        match Command::new("loginctl").arg("lock-sessions").status() {
            Ok(status) if status.success() => {}
            Ok(status) => warn!(?status, "loginctl lock-sessions exited non-zero"),
            Err(err) => error!(%err, "failed to run loginctl -- is systemd-logind installed?"),
        }
    }

    fn enable_usage(&self) {
        // Intentional no-op -- see the Enforcement trait doc comment.
    }
}

/// Linux expiry warnings: hand them to the desktop user's own notification
/// daemon over their session D-Bus.
///
/// The problem to solve is the same one `disable_usage()` has, from the
/// other direction: the agent is a systemd system service running as root
/// with no desktop, no session bus and no `DISPLAY`, while the notification
/// daemon lives in the logged-in user's session. The route taken here:
///
/// 1. Ask logind which session is the active graphical one, and who owns it
///    (`loginctl`, the same source of truth already used for locking). No
///    guessing at `DISPLAY=:0` or "uid 1000 is the user".
/// 2. Drop to that user with `runuser` and point `DBUS_SESSION_BUS_ADDRESS`
///    at their well-known bus socket (`/run/user/<uid>/bus`), then run
///    `notify-send`. Nothing here needs an X11/Wayland display: the
///    notification is a D-Bus method call, not a window.
///
/// Every argument is either a compile-time constant, an integer the agent
/// computed, or a username/uid read from logind -- and all of them are
/// passed as separate argv entries to an exec'd binary, never through a
/// shell. There is no path by which server-supplied data reaches any of it.
///
/// Limitations, documented in docs/expiry-warnings.md rather than hidden:
/// `notify-send` (libnotify) and a running notification daemon are required
/// -- the same shape of prerequisite as a logind-aware screen locker -- and
/// the final warning is a high-urgency notification, not a live countdown
/// window, because drawing one would mean shipping a GUI toolkit into an
/// agent whose whole point is being small.
pub struct LinuxNotifier {
    /// libnotify id of the final warning currently on screen, so it can be
    /// closed again if the session is extended or ends early.
    final_warning: Mutex<Option<u32>>,
}

struct DesktopSession {
    user: String,
    uid: u32,
}

impl LinuxNotifier {
    pub fn new() -> Self {
        Self {
            final_warning: Mutex::new(None),
        }
    }
}

impl Default for LinuxNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl UserNotifier for LinuxNotifier {
    fn notify(&self, notice: &Notice) {
        let urgency = match notice.urgency {
            Urgency::Normal => "normal",
            Urgency::Critical => "critical",
        };
        let _ = notify_send(
            &["--urgency", urgency, "--expire-time", "15000"],
            &notice.title,
            notice.body,
        );
    }

    fn show_final_warning(&self, remaining_secs: i64) {
        self.dismiss_final_warning();

        // Expiring the notification exactly when the session does means a
        // stale final warning can never outlive the thing it is warning
        // about, even if this process is killed before it can close it.
        let expire_ms = (remaining_secs.clamp(1, 600) * 1000).to_string();
        let body = format!(
            "{} seconds remaining. {}",
            remaining_secs.max(0),
            FINAL_WARNING_BODY
        );

        match notify_send(
            &[
                "--urgency",
                "critical",
                "--expire-time",
                &expire_ms,
                "--print-id",
            ],
            FINAL_WARNING_HEADLINE,
            &body,
        ) {
            Some(id) => *lock(&self.final_warning) = Some(id),
            None => warn!("could not show the final expiry warning"),
        }
    }

    fn dismiss_final_warning(&self) {
        let Some(id) = lock(&self.final_warning).take() else {
            return;
        };
        let Some(session) = active_desktop_session() else {
            return;
        };
        // libnotify has no "close" CLI, so this is the same D-Bus call
        // notify-send itself makes, one method along.
        let _ = run_as_desktop_user(
            &session,
            "gdbus",
            &[
                "call",
                "--session",
                "--dest",
                "org.freedesktop.Notifications",
                "--object-path",
                "/org/freedesktop/Notifications",
                "--method",
                "org.freedesktop.Notifications.CloseNotification",
                &id.to_string(),
            ],
        );
    }
}

/// Runs `notify-send` as the desktop user. Returns the notification id when
/// `--print-id` was passed and it could be parsed.
fn notify_send(options: &[&str], title: &str, body: &str) -> Option<u32> {
    let session = active_desktop_session()?;

    let mut args: Vec<&str> = vec!["--app-name", APP_NAME];
    args.extend_from_slice(options);
    args.push(title);
    args.push(body);

    let output = run_as_desktop_user(&session, "notify-send", &args)?;
    // Without --print-id there is no id to report, which is not a failure --
    // only show_final_warning() has anything to do with one.
    String::from_utf8_lossy(&output).trim().parse().ok()
}

fn run_as_desktop_user(session: &DesktopSession, program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("runuser")
        .arg("-u")
        .arg(&session.user)
        .arg("--")
        .arg(program)
        .args(args)
        // runuser keeps the environment (it is not a login shell), so this
        // is what actually lands the D-Bus call on the user's session bus.
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path=/run/user/{}/bus", session.uid),
        )
        .env("XDG_RUNTIME_DIR", format!("/run/user/{}", session.uid))
        .output();

    match output {
        Ok(out) if out.status.success() => Some(out.stdout),
        Ok(out) => {
            warn!(
                program,
                status = ?out.status,
                stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                "could not show a desktop notification"
            );
            None
        }
        Err(err) => {
            warn!(%err, program, "could not run the notification helper -- is libnotify (notify-send) installed?");
            None
        }
    }
}

/// The active graphical session and the user who owns it, straight from
/// logind. `show-session -p` prints stable `KEY=value` lines on every
/// systemd version, unlike the columns of `list-sessions`, so only the
/// session id (always the first column) is taken positionally.
fn active_desktop_session() -> Option<DesktopSession> {
    let listed = Command::new("loginctl")
        .args(["list-sessions", "--no-legend"])
        .output()
        .ok()?;
    if !listed.status.success() {
        return None;
    }
    let listed = String::from_utf8_lossy(&listed.stdout).into_owned();

    for id in listed.lines().filter_map(|l| l.split_whitespace().next()) {
        let properties = Command::new("loginctl")
            .args([
                "show-session",
                id,
                "-p",
                "Active",
                "-p",
                "Type",
                "-p",
                "Name",
                "-p",
                "User",
            ])
            .output()
            .ok()?;
        if !properties.status.success() {
            continue;
        }

        let properties = String::from_utf8_lossy(&properties.stdout).into_owned();
        let get = |key: &str| {
            properties
                .lines()
                .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
                .map(str::to_owned)
        };

        let is_graphical = matches!(get("Type").as_deref(), Some("x11" | "wayland" | "mir"));
        if get("Active").as_deref() == Some("yes") && is_graphical {
            return Some(DesktopSession {
                user: get("Name")?,
                uid: get("User")?.parse().ok()?,
            });
        }
    }
    None
}

/// A poisoned mutex here would mean a previous call panicked mid-update.
/// That is worth neither a panic nor losing the ability to dismiss a
/// warning, so the value is taken back either way.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
