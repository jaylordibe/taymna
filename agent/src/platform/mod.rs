//! Platform enforcement boundary. Every OS difference lives behind this
//! trait; nothing above it (session.rs, client.rs, main.rs) knows or cares
//! which OS it's running on. See docs/enforcement.md for the exact
//! guarantees and limitations of each implementation -- they are
//! deliberately not identical across platforms, because the underlying OS
//! capabilities are not identical.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WindowsEnforcement as PlatformEnforcement;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::LinuxEnforcement as PlatformEnforcement;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacosEnforcement as PlatformEnforcement;

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
