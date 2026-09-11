//! Windows enforcement: lock the active console session from a
//! session-0-isolated service.
//!
//! Guarantees and limitations are documented in detail in
//! docs/enforcement.md; summarized here:
//!
//! - Windows services run in session 0, which has no desktop and cannot
//!   call `LockWorkStation()` directly -- that's Session 0 Isolation,
//!   introduced in Vista/Server 2008 as a security boundary, not a bug to
//!   work around with an exploit. The documented, legitimate way around it
//!   is: find the active console session (`WTSGetActiveConsoleSessionId`),
//!   get that session's user token (`WTSQueryUserToken`), and launch a
//!   process *as that user, in that session* (`CreateProcessAsUserW`) which
//!   then calls `LockWorkStation()` on its own (interactive) desktop. This
//!   is the same technique legitimate remote-session and parental-control
//!   tools use; it requires the service to run as LocalSystem with the
//!   SE_TCB_NAME ("Act as part of the operating system") privilege enabled,
//!   which this module enables explicitly before calling WTSQueryUserToken
//!   (LocalSystem is assigned the privilege but does not run with it
//!   enabled by default).
//! - Only locks an already-unlocked session. It does not block a fresh
//!   logon at the Windows lock/login screen after a reboot, and a user who
//!   knows their own Windows account password can always unlock -- full
//!   login-blocking would require disabling the OS account
//!   (`net user <name> /active:no`), which is deferred to a future version
//!   and documented here rather than silently unimplemented.
//! - This file only compiles on Windows and was written against the
//!   documented Win32 APIs; it has not been compiled or run on a real
//!   Windows machine in this development environment (no Windows host was
//!   available). It is expected to be validated by the `windows-latest` CI
//!   matrix job (see .github/workflows/agent.yml) -- treat it as reviewed
//!   but not yet device-verified.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

use tracing::warn;
use windows::core::{Result as WinResult, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    SE_TCB_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTUPINFOW,
};

use super::Enforcement;

/// No active console session (e.g. nobody logged in yet). Documented return
/// value of WTSGetActiveConsoleSessionId.
const NO_ACTIVE_SESSION: u32 = 0xFFFFFFFF;

pub struct WindowsEnforcement;

impl WindowsEnforcement {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsEnforcement {
    fn default() -> Self {
        Self::new()
    }
}

impl Enforcement for WindowsEnforcement {
    fn disable_usage(&self) {
        if let Err(err) = lock_active_console_session() {
            warn!(?err, "failed to lock the active Windows session");
        }
    }

    fn enable_usage(&self) {
        // Intentional no-op -- see the Enforcement trait doc comment.
    }
}

fn lock_active_console_session() -> WinResult<()> {
    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == NO_ACTIVE_SESSION {
            // Nobody is logged in at the console (e.g. sitting at the logon
            // screen already) -- nothing to lock.
            return Ok(());
        }

        enable_se_tcb_privilege()?;

        let mut token = HANDLE::default();
        WTSQueryUserToken(session_id, &mut token)?;
        let result = run_lock_workstation_as_user(token);
        let _ = CloseHandle(token);
        result
    }
}

/// LocalSystem is *assigned* SE_TCB_NAME but does not run with it enabled
/// by default; WTSQueryUserToken requires it to be enabled for the calling
/// process's token, not merely assigned.
unsafe fn enable_se_tcb_privilege() -> WinResult<()> {
    let mut token = HANDLE::default();
    OpenProcessToken(
        GetCurrentProcess(),
        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
        &mut token,
    )?;

    let mut luid = LUID::default();
    LookupPrivilegeValueW(None, SE_TCB_NAME, &mut luid)?;

    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };

    let result = AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None);
    let _ = CloseHandle(token);
    result
}

unsafe fn run_lock_workstation_as_user(token: HANDLE) -> WinResult<()> {
    let mut command_line =
        wide_null(r"C:\Windows\System32\rundll32.exe user32.dll,LockWorkStation");
    let mut desktop = wide_null(r"winsta0\default");

    let mut startup_info = STARTUPINFOW::default();
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup_info.lpDesktop = PWSTR(desktop.as_mut_ptr());

    let mut process_information = PROCESS_INFORMATION::default();

    CreateProcessAsUserW(
        token,
        PWSTR::null(),
        PWSTR(command_line.as_mut_ptr()),
        None,
        None,
        false,
        CREATE_UNICODE_ENVIRONMENT,
        None::<*const c_void>,
        PWSTR::null(),
        &startup_info,
        &mut process_information,
    )?;

    let _ = CloseHandle(process_information.hProcess);
    let _ = CloseHandle(process_information.hThread);
    Ok(())
}

fn wide_null(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
