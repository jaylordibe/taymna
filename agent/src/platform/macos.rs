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

use std::process::Command;

use tracing::{error, warn};

use super::Enforcement;

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
