//! Platform enforcement boundary. Every OS difference lives behind this
//! trait; nothing above it (session.rs, client.rs, main.rs) knows or cares
//! which OS it's running on. See docs/enforcement.md for the exact
//! guarantees and limitations of each implementation -- they are
//! deliberately not identical across platforms, because the underlying OS
//! capabilities are not identical.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{WindowsEnforcement as PlatformEnforcement, WindowsNotifier as PlatformNotifier};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{LinuxEnforcement as PlatformEnforcement, LinuxNotifier as PlatformNotifier};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{MacosEnforcement as PlatformEnforcement, MacosNotifier as PlatformNotifier};

/// The only thing the rest of the agent is allowed to ask the OS to do.
/// Deliberately NOT a generic command-execution interface -- see
/// docs/enforcement.md and the product brief's explicit prohibition on the
/// agent accepting arbitrary remote commands.
pub trait Enforcement: Send + Sync {
    /// Ensure the machine is not usable right now. Called repeatedly (every
    /// tick) while no active Taymna session exists, so it must be safe and
    /// cheap to call when the machine is already locked.
    fn disable_usage(&self);

    /// Called once when a valid session becomes active. On every supported
    /// platform this is a no-op beyond logging: Taymna never revokes OS
    /// credentials, so there is nothing to "unlock" -- the machine becomes
    /// usable simply because disable_usage() stops being called. Kept as a
    /// trait method for symmetry and so a future platform with a real
    /// unlock primitive (e.g. re-enabling a disabled OS account) has
    /// somewhere to put it.
    fn enable_usage(&self);
}

pub fn current() -> PlatformEnforcement {
    PlatformEnforcement::new()
}

/// Product name, as it appears to the user in a notification.
pub const APP_NAME: &str = "Taymna";

pub const FINAL_WARNING_HEADLINE: &str = "SESSION ENDING";
pub const FINAL_WARNING_BODY: &str = "Save your work and sign out of your accounts. This computer will lock when the timer reaches zero.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Normal,
    /// Mapped to whatever "this one matters" means natively -- a critical
    /// libnotify urgency, a warning-styled toast -- and silently downgraded
    /// to Normal where the platform has no such concept.
    Critical,
}

/// One user-facing notification. Both fields are produced by the agent
/// itself (`warning::notice_for`): `body` is a compile-time constant and
/// `title` is built from a locally computed integer. Nothing a server sends
/// reaches this struct, which is what keeps the OS invocations below made
/// entirely of data the agent controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: &'static str,
    pub urgency: Urgency,
}

/// Showing the interactive user something, from a process that is a system
/// service with no desktop of its own.
///
/// Separate from `Enforcement` on purpose. Enforcement is the security-
/// critical half and its two methods are the *only* things the agent may
/// ask the OS to do about usage; this is the cosmetic half, and the
/// difference should stay visible in the type system. Every method is
/// infallible by contract: implementations log their own failures and
/// return, because a notification that could not be delivered must never
/// become an enforcement problem (docs/expiry-warnings.md).
pub trait UserNotifier {
    /// A normal native notification. Fire-and-forget.
    fn notify(&self, notice: &Notice);

    /// The prominent final warning, `remaining_secs` from now. Replaces any
    /// final warning already on screen.
    fn show_final_warning(&self, remaining_secs: i64);

    /// Take down a final warning if one is still up. Safe to call when
    /// there is none, and when the user already dismissed it.
    fn dismiss_final_warning(&self);
}

pub fn notifier() -> PlatformNotifier {
    PlatformNotifier::new()
}
