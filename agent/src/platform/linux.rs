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

use tracing::{error, warn};

use super::Enforcement;

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
