# Platform enforcement

What "the machine becomes unavailable" means, precisely, on each OS --
including what it does *not* mean. Section 23 of the product brief asked
for this to be spelled out exactly rather than assumed; this document is
that answer, matching the actual code in `agent/src/platform/`.

## The one mechanism, three implementations

`agent/src/platform/mod.rs` defines a two-method trait:

```rust
pub trait Enforcement: Send + Sync {
    fn disable_usage(&self);
    fn enable_usage(&self);
}
```

`disable_usage()` locks the active interactive session. The agent's main
loop (`agent/src/main.rs`) calls it once per tick (~2 seconds) for as long
as the session should be blocked -- not once and done. This is the
**re-assertion loop**: if the user manually unlocks while the session is
still supposed to be blocked (or the agent just restarted into an
already-expired state), the next tick re-locks within ~2 seconds. There is
no account disabling, no credential revocation, and no anti-kill or stealth
behavior -- the agent is an admin-installed, visible service, consistent
with the product's brief. `enable_usage()` is intentionally close to a
no-op on every platform: Taymna never revokes OS credentials, so there is
nothing to "unlock" -- the machine becomes usable simply because
`disable_usage()` stops being called.

## Windows

**Mechanism:** the agent runs as a Windows service (LocalSystem), which
lives in session 0 -- isolated from any interactive desktop since Vista/
Server 2008 (Session 0 Isolation), a real security boundary, not a bug to
route around with an exploit. The documented, legitimate way a session-0
service reaches an interactive session is:

1. `WTSGetActiveConsoleSessionId()` -- find the session currently at the
   physical console.
2. Enable the `SE_TCB_NAME` ("Act as part of the operating system")
   privilege on the service's own token (LocalSystem is *assigned* this
   privilege but doesn't run with it *enabled* by default -- the code
   enables it explicitly via `AdjustTokenPrivileges` before the next step).
3. `WTSQueryUserToken()` -- obtain that session's user token.
4. `CreateProcessAsUserW()` -- launch `rundll32.exe user32.dll,LockWorkStation`
   *as that user, in that session*, targeting `winsta0\default` so it runs
   on the interactive desktop.

This is the same technique legitimate remote-session and parental-control
tools use to affect an interactive desktop from a service.

**Guarantees:** locks an already-unlocked interactive session within one
tick.

**Limitations:**
- Does not block a fresh logon at the Windows lock/login screen after a
  reboot -- there is no active console session to lock yet at that point.
- A user who knows their own Windows account password can always type it in
  and unlock; Taymna's re-assertion loop re-locks it, but doesn't prevent
  the unlock itself.
- Full login-blocking would require disabling the OS account
  (`net user <name> /active:no`) and re-enabling it when a session starts.
  This is deferred past V1 and documented here rather than silently
  unimplemented -- it needs a way to know which OS account corresponds to
  "the" user of a shared machine, which the current enrollment flow doesn't
  capture.
**Device-verified** on a real Windows 11 machine (2026-09-11, agent v0.1.3
installed as a LocalSystem service, server reached over the internet via an
ngrok tunnel): with no session the console locks and re-locks within ~2s of
signing back in; starting a session makes the machine usable immediately;
at expiry it locks again. That first real-hardware run found three genuine
gaps, all fixed -- none of them in the lock mechanism itself, all in getting
the process to run as a service at all, and each surfacing only as a bare
`sc.exe start` error 1053 with no other output:

- **No Service Control Manager handshake.** The agent had never called
  `StartServiceCtrlDispatcherW`, so SCM waited for a `SERVICE_RUNNING`
  status that never came. Fixed in `agent/src/main.rs`'s
  `windows_service_support` module (via the `windows-service` crate): when
  launched by SCM it registers a control handler, reports `SERVICE_RUNNING`,
  and reports `SERVICE_STOPPED` on Stop/Shutdown; launched any other way
  (interactively, `cargo run`, double-click) it runs in the foreground as
  before.
- **A dependency on `VCRUNTIME140.dll`.** The MSVC toolchain links the C
  runtime dynamically by default, and the Visual C++ Redistributable was not
  on the target machine, so the exe failed to load at all (exit code
  `-1073741515`, STATUS_DLL_NOT_FOUND) in every context -- it just fails
  *silently* as a service. Fixed by statically linking the runtime
  (`agent/.cargo/config.toml`); the binary now imports only DLLs that ship
  with Windows.
- **Environment variables don't reach a service.** `TAYMNA_STATE_DIR` set
  as a machine-wide variable is invisible to a service until reboot, because
  services inherit `services.exe`'s boot-time environment. The install
  procedure now sets it on the service's own registry key instead. A
  Windows service also has no console, so on this platform only the agent
  logs to `<TAYMNA_STATE_DIR>\agent.log` (plus `panic.log` /
  `service_dispatch.log` for failures during startup).

See [agent-install.md](agent-install.md) for the resulting procedure.

## Linux

**Mechanism:** the agent runs as a systemd service (root) and shells out to
`loginctl lock-sessions`, which talks to systemd-logind over D-Bus and asks
every session implementing the Lock/Unlock contract to lock itself. Shelling
out to the `loginctl` binary was chosen over a D-Bus client crate to keep
the dependency surface small; the correctness is identical either way.

**Guarantees:** locks an already-unlocked interactive session within one
tick, on any desktop environment that implements logind's lock contract.

**Limitations:**
- Requires systemd-logind, which is virtually universal on modern
  distributions, and a desktop environment that implements the Lock/Unlock
  signal. GNOME, KDE Plasma, and most major DEs do this out of the box;
  minimal window managers (i3, bare sway, etc.) need a logind-aware locker
  installed separately (e.g. `light-locker`). This is a real prerequisite
  to document for operators, not a silent failure -- if `loginctl` isn't
  present at all, the agent logs an error and keeps retrying every tick
  rather than crashing.
- Same reboot/login-screen and "user knows their own password" limitations
  as Windows, for the same underlying reason (locking isn't the same as
  revoking the ability to log in).
- Verified live during development: running the compiled agent (via Docker,
  which has no `loginctl` binary at all) against a real API showed the
  expected error-and-retry behavior while blocked, and showed the retry
  loop stop the instant a session became active and resume the instant it
  ended -- confirming the *decision logic* end-to-end. The actual OS-level
  lock call itself was not exercised against a real logind/desktop session
  in this environment.
- The Linux release binary is built as a fully static musl executable
  (`.github/workflows/release.yml`). Testing `install/install.sh` in a
  Debian 12 container turned up the reason: the earlier glibc build, made on
  the Ubuntu 24.04 runner, required glibc 2.39 and refused to start on
  anything older (`version 'GLIBC_2.39' not found`) -- the Linux twin of the
  Windows CRT dependency above. `install.sh` itself was verified in an
  Ubuntu 24.04 container against a live API: real download URL, install,
  version check, unit file, enrollment (server-confirmed), upgrade-keeps-
  enrollment, and `--reenroll`; the `systemctl` calls were captured by a
  shim rather than run on a real systemd host.

## macOS

**Mechanism:** the agent runs as a launchd daemon and shells out to
`osascript` to simulate the OS's own lock-screen keyboard shortcut
(Control+Command+Q) via System Events, rather than the traditional
`CGSession -suspend` trick -- which was evaluated and rejected because it
stopped working in macOS Big Sur and later. Simulating the real shortcut
keeps working across OS versions because it drives the same input path an
actual key press would.

**Guarantees:** locks an already-unlocked interactive session within one
tick, once Accessibility permission (below) is granted.

**Limitations:**
- Requires the daemon (or a small per-user login-item helper) to hold
  Accessibility permission (System Settings -> Privacy & Security ->
  Accessibility). macOS requires a human to grant this once during install
  -- it cannot be granted silently by the installer, and this is called out
  as an explicit manual step in [agent-install.md](agent-install.md), not
  hidden.
- Same reboot/login-window and "user knows their own password" limitations
  as the other two platforms.
- Like Windows, this code has not been run on a real Mac in this project's
  development environment; it's validated by the `macos-latest` CI build
  leg but not device-verified for actual lock behavior.

## Why "lock the screen" and not something stronger, for V1

All three platforms share the same two honest limitations: locking doesn't
block a not-yet-logged-in session at a fresh boot, and it can't stop someone
who legitimately knows their own OS password from unlocking. A stronger V1
would need to disable the OS account itself, which requires knowing which
specific OS account corresponds to "the" restricted user on a given
machine -- not something the current one-machine-one-record enrollment
model captures, and not something to bolt on without designing it properly
(wrong account = locked out the wrong person, or the operator themselves).
Documenting the gap honestly here was judged better than a half-built
account-disable feature with sharp edges.
