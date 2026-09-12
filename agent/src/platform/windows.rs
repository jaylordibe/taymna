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
use std::sync::Mutex;

use tracing::warn;
use windows::core::{Result as WinResult, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    SE_TCB_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, TerminateProcess,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
};

use super::{
    Enforcement, Notice, Urgency, UserNotifier, APP_NAME, FINAL_WARNING_BODY,
    FINAL_WARNING_HEADLINE,
};

/// No active console session (e.g. nobody logged in yet). Documented return
/// value of WTSGetActiveConsoleSessionId.
const NO_ACTIVE_SESSION: u32 = 0xFFFFFFFF;

const LOCK_COMMAND_LINE: &str = r"C:\Windows\System32\rundll32.exe user32.dll,LockWorkStation";
const POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

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
        match spawn_in_console_session(LOCK_COMMAND_LINE) {
            // Nothing to wait for: rundll32 locks and exits on its own.
            Ok(Some(process)) => unsafe {
                let _ = CloseHandle(process);
            },
            Ok(None) => {}
            Err(err) => warn!(?err, "failed to lock the active Windows session"),
        }
    }

    fn enable_usage(&self) {
        // Intentional no-op -- see the Enforcement trait doc comment.
    }
}

/// Launches `command_line` as the user at the physical console, on their
/// interactive desktop -- the one privileged operation this module knows how
/// to do, used both to lock the session and to put an expiry warning on
/// screen. `Ok(None)` means nobody is logged in at the console, which is not
/// a failure. The returned process handle belongs to the caller.
///
/// `command_line` is always one of this file's own constants (with, for a
/// warning, a base64 payload this file built); nothing from the server has a
/// path here -- see the module header and docs/security.md.
fn spawn_in_console_session(command_line: &str) -> WinResult<Option<HANDLE>> {
    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == NO_ACTIVE_SESSION {
            // Nobody is logged in at the console (e.g. sitting at the logon
            // screen already) -- nothing to lock, nobody to warn.
            return Ok(None);
        }

        enable_se_tcb_privilege()?;

        let mut token = HANDLE::default();
        WTSQueryUserToken(session_id, &mut token)?;
        let result = create_process_as_user(token, command_line);
        let _ = CloseHandle(token);
        result.map(Some)
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

unsafe fn create_process_as_user(token: HANDLE, command_line: &str) -> WinResult<HANDLE> {
    let mut command_line = wide_null(command_line);
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

    let _ = CloseHandle(process_information.hThread);
    Ok(process_information.hProcess)
}

fn wide_null(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Windows expiry warnings, shown on the interactive desktop from session 0.
///
/// This reuses `spawn_in_console_session()` -- the same
/// `WTSQueryUserToken` + `CreateProcessAsUserW` route the lock already
/// takes, and the reason no new privileged mechanism is introduced here.
/// The launched process is Windows' own PowerShell, which draws either a
/// balloon/toast notification (10, 5 and 1 minute) or a small always-on-top
/// countdown window (the final warning). No new runtime ships with the
/// agent for this; both are `System.Windows.Forms`, which is part of
/// Windows.
///
/// The script is handed over with `-EncodedCommand`, i.e. base64 of its
/// UTF-16LE text. That is not obfuscation: it removes command-line quoting
/// from the picture entirely, so the *structure* of the script is fixed at
/// compile time and the only things that vary are a title and an integer
/// the agent itself produced.
///
/// Reviewed against the documented APIs but, unlike the lock path, not yet
/// exercised on real Windows hardware (docs/expiry-warnings.md).
pub struct WindowsNotifier {
    /// Process handle of the countdown window, kept so an extension can
    /// take it off the screen. Stored as an `isize` rather than a `HANDLE`
    /// because the notifier is shared, and a raw pointer newtype is not.
    final_warning: Mutex<Option<isize>>,
}

impl WindowsNotifier {
    pub fn new() -> Self {
        Self {
            final_warning: Mutex::new(None),
        }
    }
}

impl Default for WindowsNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl UserNotifier for WindowsNotifier {
    fn notify(&self, notice: &Notice) {
        let script = BALLOON_SCRIPT
            .replace("%%TITLE%%", &powershell_string(&notice.title))
            .replace("%%BODY%%", &powershell_string(notice.body))
            .replace(
                "%%ICON%%",
                match notice.urgency {
                    Urgency::Normal => "Info",
                    Urgency::Critical => "Warning",
                },
            );

        match run_powershell(&script) {
            // The balloon outlives the handle; nothing here waits for it.
            Ok(Some(process)) => unsafe {
                let _ = CloseHandle(process);
            },
            Ok(None) => {}
            Err(err) => warn!(?err, "could not show an expiry notification"),
        }
    }

    fn show_final_warning(&self, remaining_secs: i64) {
        self.dismiss_final_warning();

        let script = FINAL_WARNING_SCRIPT
            .replace("%%SECONDS%%", &remaining_secs.clamp(1, 600).to_string())
            .replace("%%BRAND%%", &powershell_string(APP_NAME))
            .replace("%%HEADLINE%%", &powershell_string(FINAL_WARNING_HEADLINE))
            .replace("%%BODY%%", &powershell_string(FINAL_WARNING_BODY));

        match run_powershell(&script) {
            Ok(Some(process)) => *lock(&self.final_warning) = Some(process.0 as isize),
            Ok(None) => {}
            Err(err) => warn!(?err, "could not show the final expiry warning"),
        }
    }

    fn dismiss_final_warning(&self) {
        let Some(process) = lock(&self.final_warning).take() else {
            return;
        };
        let process = HANDLE(process as *mut c_void);
        unsafe {
            // Already exited if the user dismissed it or it counted itself
            // out; terminating a finished process is a harmless no-op.
            let _ = TerminateProcess(process, 0);
            let _ = CloseHandle(process);
        }
    }
}

fn run_powershell(script: &str) -> WinResult<Option<HANDLE>> {
    let command_line = format!(
        "{POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}",
        base64(&utf16le(script))
    );
    spawn_in_console_session(&command_line)
}

/// A PowerShell single-quoted string literal, in which the only character
/// with any meaning is `'` itself. Every caller passes a constant or an
/// agent-generated headline; this is what makes that structurally true
/// rather than merely currently true.
fn powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn utf16le(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

/// Standard base64, as `-EncodedCommand` expects. Hand-rolled because
/// pulling a crate in for twelve lines used on one platform is a worse
/// trade than the twelve lines.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let block = u32::from(chunk[0]) << 16
            | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        let sextet = |shift: u32| ALPHABET[(block >> shift) as usize & 0x3f] as char;
        encoded.push(sextet(18));
        encoded.push(sextet(12));
        encoded.push(if chunk.len() > 1 { sextet(6) } else { '=' });
        encoded.push(if chunk.len() > 2 { sextet(0) } else { '=' });
    }
    encoded
}

/// A poisoned mutex would mean a previous call panicked mid-update -- worth
/// neither a panic nor losing the handle needed to dismiss the window.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A tray balloon, which Windows 10/11 render as a normal toast. Chosen
/// over the `Windows.UI.Notifications` toast API because that one needs a
/// registered AppUserModelID (i.e. an installed Store-style app) to be
/// reliable, and Taymna installs a service, not an app.
const BALLOON_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Information
$tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::%%ICON%%
$tray.BalloonTipTitle = %%TITLE%%
$tray.BalloonTipText = %%BODY%%
$tray.Visible = $true
$tray.ShowBalloonTip(15000)
Start-Sleep -Seconds 12
$tray.Visible = $false
$tray.Dispose()
"#;

/// The prominent final warning: a small, calm, always-on-top window with a
/// live mm:ss countdown and a Dismiss button -- and deliberately nothing
/// else. There is no snooze, no "add time", no way to cancel expiry;
/// dismissing it hides a window, it does not touch the session.
///
/// The countdown runs off a monotonic `Stopwatch` seeded with the seconds
/// the agent computed, not off the local wall clock, so moving the clock
/// cannot make the displayed number disagree with what enforcement will do.
const FINAL_WARNING_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$total = %%SECONDS%%
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 300)
$form.BackColor = [System.Drawing.Color]::FromArgb(15, 16, 19)
$form.TopMost = $true
$form.ShowInTaskbar = $false

function New-Line($text, $size, $style, $color, $top, $height) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Font = New-Object System.Drawing.Font('Segoe UI', $size, $style)
  $label.ForeColor = $color
  $label.AutoSize = $false
  $label.TextAlign = 'MiddleCenter'
  $label.SetBounds(24, $top, 472, $height)
  return $label
}

$bold = [System.Drawing.FontStyle]::Bold
$brand = New-Line %%BRAND%% 10 $bold ([System.Drawing.Color]::FromArgb(132, 138, 150)) 30 22
$clock = New-Line '' 48 $bold ([System.Drawing.Color]::FromArgb(245, 246, 248)) 58 84
$headline = New-Line %%HEADLINE%% 12 $bold ([System.Drawing.Color]::FromArgb(232, 178, 92)) 148 24
$body = New-Line %%BODY%% 10 ([System.Drawing.FontStyle]::Regular) ([System.Drawing.Color]::FromArgb(168, 174, 186)) 176 48
foreach ($line in $brand, $clock, $headline, $body) { $form.Controls.Add($line) }

$dismiss = New-Object System.Windows.Forms.Button
$dismiss.Text = 'Dismiss'
$dismiss.FlatStyle = 'Flat'
$dismiss.FlatAppearance.BorderSize = 0
$dismiss.BackColor = [System.Drawing.Color]::FromArgb(32, 34, 40)
$dismiss.ForeColor = [System.Drawing.Color]::FromArgb(226, 229, 234)
$dismiss.SetBounds(200, 236, 120, 34)
$dismiss.Add_Click({ $form.Close() })
$form.Controls.Add($dismiss)

$render = {
  $left = $total - [int][System.Math]::Floor($elapsed.Elapsed.TotalSeconds)
  if ($left -le 0) { $form.Close() }
  else { $clock.Text = '{0:00}:{1:00}' -f [System.Math]::Floor($left / 60), ($left % 60) }
}
& $render

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick($render)
$timer.Start()
[void]$form.ShowDialog()
$timer.Stop()
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_test_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn scripts_are_encoded_as_utf16le_base64_like_powershell_expects() {
        // 'A' -> 0x41 0x00, which is what -EncodedCommand decodes back.
        assert_eq!(utf16le("A"), vec![0x41, 0x00]);
        assert_eq!(base64(&utf16le("A")), "QQA=");
    }

    #[test]
    fn powershell_literals_cannot_be_broken_out_of() {
        assert_eq!(
            powershell_string("5 minutes remaining"),
            "'5 minutes remaining'"
        );
        assert_eq!(powershell_string("it's"), "'it''s'");
        assert_eq!(
            powershell_string("'; Start-Process calc; '"),
            "'''; Start-Process calc; '''"
        );
    }

    #[test]
    fn every_placeholder_is_substituted() {
        let notice = Notice {
            title: "5 minutes remaining".into(),
            body: "Save your work.",
            urgency: Urgency::Normal,
        };
        let balloon = BALLOON_SCRIPT
            .replace("%%TITLE%%", &powershell_string(&notice.title))
            .replace("%%BODY%%", &powershell_string(notice.body))
            .replace("%%ICON%%", "Info");
        assert!(!balloon.contains("%%"), "{balloon}");

        let final_warning = FINAL_WARNING_SCRIPT
            .replace("%%SECONDS%%", "30")
            .replace("%%BRAND%%", &powershell_string(APP_NAME))
            .replace("%%HEADLINE%%", &powershell_string(FINAL_WARNING_HEADLINE))
            .replace("%%BODY%%", &powershell_string(FINAL_WARNING_BODY));
        assert!(!final_warning.contains("%%"), "{final_warning}");
    }
}
