//! macOS enforcement: lock the screen by simulating the built-in
//! Control+Command+Q shortcut via System Events.
//!
//! Guarantees and limitations are documented in detail in
//! docs/enforcement.md; summarized here:
//!
//! - `CGSession -suspend` (the traditional CLI lock trick) was evaluated
//!   and rejected: it stopped working in macOS Big Sur and later. Instead
//!   this simulates the OS's own lock-screen keyboard shortcut through
//!   System Events, which keeps working across OS versions because it
//!   drives the same input path a real key press would.
//! - Requires the launchd daemon (or a small per-user login-item helper) to
//!   hold Accessibility permission (System Settings -> Privacy & Security
//!   -> Accessibility). macOS requires a human to grant this once during
//!   install -- it cannot be granted silently -- and this is called out as
//!   a manual install step in docs/agent-install.md, not hidden.
//! - Only locks an already-unlocked interactive session; same reboot/login-
//!   window and "user knows their own password" limitations as the other
//!   two platforms. Taymna's local re-assertion loop re-locks within one
//!   tick if the user unlocks while the session should be blocked.

use std::process::{Child, Command};
use std::sync::Mutex;

use tracing::{error, warn};

use super::{
    Enforcement, Notice, UserNotifier, APP_NAME, FINAL_WARNING_BODY, FINAL_WARNING_HEADLINE,
};

const LOCK_SCRIPT: &str =
    r#"tell application "System Events" to keystroke "q" using {control down, command down}"#;

pub struct MacosEnforcement;

impl MacosEnforcement {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacosEnforcement {
    fn default() -> Self {
        Self::new()
    }
}

impl Enforcement for MacosEnforcement {
    fn disable_usage(&self) {
        match Command::new("osascript").arg("-e").arg(LOCK_SCRIPT).status() {
            Ok(status) if status.success() => {}
            Ok(status) => warn!(
                ?status,
                "osascript lock command exited non-zero -- has Accessibility permission been granted?"
            ),
            Err(err) => error!(%err, "failed to run osascript"),
        }
    }

    fn enable_usage(&self) {
        // Intentional no-op -- see the Enforcement trait doc comment.
    }
}

/// macOS expiry warnings: Notification Center and a caution alert, shown in
/// the console user's GUI session.
///
/// A launchd *daemon* runs in the system bootstrap context, where there is
/// no window server connection and nothing it draws would ever appear. The
/// supported route into the logged-in user's context is `launchctl asuser
/// <uid> <command>`, and the uid of that user is the owner of `/dev/console`
/// -- read here directly with `stat(2)` rather than by shelling out. If
/// nobody is logged in at the GUI, the owner is root and there is (rightly)
/// nothing to show.
///
/// The script text is assembled from compile-time constants and integers the
/// agent computed, then passed as a single `-e` argument to an exec'd
/// `osascript`; no shell is involved and no server-supplied data reaches it.
/// `applescript_string()` quotes the literals anyway, so a future caller
/// cannot accidentally make text structural.
///
/// Limitations, documented in docs/expiry-warnings.md: notifications posted
/// through `osascript` are attributed to the script runner rather than to a
/// registered "Taymna" app (Taymna ships no .app bundle), so the user may
/// have to allow them once in Notification Center, and Do Not Disturb can
/// suppress them -- the alert used for the final warning is not affected.
/// The final warning shows the seconds left at the moment it appears and
/// closes itself at expiry; it does not tick down.
pub struct MacosNotifier {
    /// The `osascript` process drawing the final alert. It blocks for as
    /// long as the alert is up, so killing it is how the alert is taken
    /// down again after an extension.
    final_warning: Mutex<Option<Child>>,
}

impl MacosNotifier {
    pub fn new() -> Self {
        Self {
            final_warning: Mutex::new(None),
        }
    }
}

impl Default for MacosNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl UserNotifier for MacosNotifier {
    fn notify(&self, notice: &Notice) {
        // Notification Center exposes no urgency to a script, so
        // `notice.urgency` has no mapping here -- the copy carries it.
        let script = format!(
            "display notification {} with title {} subtitle {}",
            applescript_string(notice.body),
            applescript_string(&notice.title),
            applescript_string(APP_NAME),
        );
        match spawn_osascript(&script) {
            // Posting a notification returns immediately, so this both
            // reaps the child (no zombies over a long uptime) and is the
            // only place a failure is visible: `launchctl asuser` reports
            // "Operation not permitted" rather than failing to spawn when
            // the agent is not running with the privileges a daemon has.
            Some(mut child) => match child.wait() {
                Ok(status) if status.success() => {}
                Ok(status) => warn!(?status, "osascript could not post an expiry notification"),
                Err(err) => warn!(%err, "could not wait for osascript"),
            },
            None => warn!("could not post an expiry notification"),
        }
    }

    fn show_final_warning(&self, remaining_secs: i64) {
        self.dismiss_final_warning();

        let seconds = remaining_secs.clamp(1, 600);
        // `giving up after` guarantees the alert cannot outlive the session
        // even if this process never gets to dismiss it.
        let script = format!(
            "display alert {} message {} as critical buttons {{\"Dismiss\"}} default button \"Dismiss\" giving up after {}",
            applescript_string(FINAL_WARNING_HEADLINE),
            applescript_string(&format!(
                "{seconds} seconds remaining.\n\n{FINAL_WARNING_BODY}"
            )),
            seconds,
        );

        match spawn_osascript(&script) {
            Some(child) => *lock(&self.final_warning) = Some(child),
            None => warn!("could not show the final expiry warning"),
        }
    }

    fn dismiss_final_warning(&self) {
        let Some(mut child) = lock(&self.final_warning).take() else {
            return;
        };
        // Already gone if the user clicked Dismiss or it gave up by itself.
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Runs one AppleScript in the console user's GUI session.
fn spawn_osascript(script: &str) -> Option<Child> {
    let uid = console_user_uid()?;
    match Command::new("launchctl")
        .arg("asuser")
        .arg(uid.to_string())
        .arg("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .spawn()
    {
        Ok(child) => Some(child),
        Err(err) => {
            warn!(%err, "could not run osascript in the console user's session");
            None
        }
    }
}

/// The uid of the user currently logged in at the GUI, or `None` when that
/// is nobody (login window: `/dev/console` is owned by root).
fn console_user_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/dev/console").ok()?.uid();
    (uid != 0).then_some(uid)
}

/// An AppleScript string literal. Everything passed in today is a constant
/// or an integer; escaping is belt and braces so that stays safe if it ever
/// isn't.
fn applescript_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', r"\\")
            .replace('"', "\\\"")
            // AppleScript understands the two-character escape, not a raw
            // newline inside a literal.
            .replace('\n', "\\n")
    )
}

/// A poisoned mutex would mean a previous call panicked mid-update -- worth
/// neither a panic nor losing the handle needed to dismiss an alert.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
