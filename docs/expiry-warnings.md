# Expiry warnings

A shared computer that locks with no warning is a bad shared computer. The
agent tells the person using it that their session is running out — at ten
minutes, five minutes, one minute, and again in the last thirty seconds —
and then locks exactly when it always would have.

Everything here is **UX**. Nothing in it can move, delay, or prevent
expiry. That distinction is the point of this document.

## Warnings are local, and so is everything they depend on

The agent already knows the only two things a warning needs:

```
remaining = session.expiresAt - trusted_now
```

`expiresAt` is the absolute deadline it persists anyway, and `trusted_now`
is the `ClockGuard` reading (see [offline-expiry.md](offline-expiry.md))
that expiry enforcement itself is judged from — the same call, on the same
tick. So:

- Nothing is scheduled on the server. No new message type, no new command,
  no change to the [protocol](protocol.md).
- No polling, no queue, no Redis, no timers beyond the ~2 second loop the
  agent already runs.
- **Warnings work with the server unreachable**, for the same reason expiry
  does: the deadline is already on disk.
- There is no second timing authority to drift out of sync with, because
  there is no second timing authority.

`agent/src/warning.rs` holds the decision (pure, no I/O, no clock reads);
`agent/src/platform/*.rs` holds the delivery.

## Thresholds

| Remaining | What the user sees |
|---|---|
| 10 minutes | Native notification — *"10 minutes remaining"* / "Your Taymna session will end soon. Save your work before time runs out." |
| 5 minutes | Native notification — *"5 minutes remaining"* / "Save your work and sign out of your accounts before this computer locks." |
| 1 minute | Native notification, raised urgency — *"1 minute remaining"* / "Your session is about to end. Save your work and sign out now." |
| 30 seconds | Prominent final warning — *SESSION ENDING* / "Save your work and sign out of your accounts. This computer will lock when the timer reaches zero." |
| 0 | The existing lock. Unchanged. |

The headline states the time **actually** left, rounded to the nearest
minute, not the threshold's nominal name. On an uninterrupted countdown
they are the same thing; where they differ — a three-minute session, an
agent starting up with 4m30s left — the honest number is the one shown.
This is why short sessions need no special-casing: a three-minute session
gets *"3 minutes remaining"*, once.

The final warning can be acknowledged and dismissed. Dismissing it closes a
window; it does not pause, snooze, extend, or cancel anything. There is no
button that does. Adding time stays where it already was: the operator's
dashboard.

## Which warning fires, and when

Warnings are keyed to a **deadline**, `(session id, expiresAt)` — not to a
session, because an extension keeps the session and moves the deadline.

Within one deadline, a level fires only if it is *more urgent* than the most
urgent level already fired. That one rule gives three properties at once:

- **No duplicates.** The ~2 second loop re-evaluates constantly; each
  threshold still fires exactly once.
- **A skipped threshold still fires.** A tick delayed from 5m03s to 4m59s
  crosses 5:00 without ever observing it; the 5-minute warning fires
  anyway. There is no equality check anywhere.
- **Missed thresholds are never replayed.** Only one level ever fires per
  evaluation, and it becomes the high-water mark.

When an evaluation does *not* follow on from a recent one — a first look at
a deadline, a process that just started, a machine that just woke, any gap
longer than 30 seconds — the agent announces where the session *is* rather
than resuming a ladder it has fallen off. That means exactly one warning,
for the time actually left, with one deliberate exception: arriving inside
the last minute goes straight to the final warning, because a *"1 minute
remaining"* toast that the countdown supersedes ten seconds later helps
nobody.

| Situation | What happens |
|---|---|
| Session started with 2 hours | Nothing until 10 minutes left, then the full ladder. |
| Agent restarts with 4m30s left | One notification: *"5 minutes remaining"*. Not the 10-minute one it missed. |
| Agent restarts with 40s left | The final warning only. |
| New 3-minute session | One notification: *"3 minutes remaining"*, then 1 minute, then the final warning. No 10m/5m burst. |
| New 20-second session | The final warning only. |
| Laptop sleeps 10 minutes with 8 left | Wakes **after** `expiresAt`: locks immediately, says nothing. Obsolete warnings are never shown. |
| Laptop wakes with 40s left | The final warning, counting the real 40 seconds. |
| Operator extends during the 5-minute warning | New deadline ⇒ new lifecycle. The ladder is available again against the new `expiresAt`. |
| Operator extends while the final warning is up | It is taken off the screen, and the lifecycle resets. |
| Session ends early, or is replaced | Any final warning is taken down; nothing further is announced for the old deadline. |
| Reconnect re-pushes the same session | Same deadline ⇒ nothing re-announced. Stale-message protection is untouched. |
| Agent restarts after expiry | Locks. Says nothing. |

Warning state is held **in memory only**. Nothing is persisted for it, and
nothing needs to be: the deadline on disk is enough to re-derive the right
warning after a restart, and re-showing one notification is a far better
failure mode than a persisted flag that suppresses a warning the user never
actually saw. `state.json` is unchanged.

## Per-platform behaviour

The agent is a system service on every platform — Windows LocalSystem,
systemd as root, a launchd daemon — none of which has a desktop of its own.
Each platform therefore has to *reach into* the interactive user's session,
and each does it with the mechanism that platform actually supports.

### Windows

Reuses the exact route the lock already takes, and introduces no new
privileged mechanism: `WTSGetActiveConsoleSessionId` →
`WTSQueryUserToken` → `CreateProcessAsUserW` onto `winsta0\default`
([enforcement.md](enforcement.md) has the detail). The launched process is
Windows' own PowerShell, drawing either:

- **10/5/1 minute:** a tray balloon, which Windows 10 and 11 render as a
  normal toast. Chosen over the `Windows.UI.Notifications` toast API
  because that needs a registered AppUserModelID — i.e. an installed
  Store-style app — and Taymna installs a service, not an app.
- **30 seconds:** a small, always-on-top window with a **live mm:ss
  countdown**, the headline, the body copy, and a Dismiss button. Its
  countdown runs off a monotonic `Stopwatch` seeded with the seconds the
  agent computed, not off the local wall clock, so moving the clock cannot
  make the displayed number disagree with what enforcement will do.

The script is passed with `-EncodedCommand` (base64 of UTF-16LE). That is
not obfuscation — it removes command-line quoting from the picture, so the
*structure* of the script is fixed at compile time and the only things that
vary are a title and an integer the agent produced.

**Not device-verified.** The lock path has been run on real Windows 11
hardware; this warning path has not. CI's `windows-latest` leg compiles it
and runs its unit tests, but nothing has yet drawn the window on a real
desktop.

### Linux

`loginctl` names the active graphical session and its owner (the same
source of truth the lock uses — no guessing at `DISPLAY=:0` or "uid 1000 is
the user"), then `runuser` drops to that user with
`DBUS_SESSION_BUS_ADDRESS` pointed at `/run/user/<uid>/bus` and runs
`notify-send`. Nothing needs an X11 or Wayland display: a notification is a
D-Bus method call, not a window, so this works the same under both.

- **10/5/1 minute:** a notification, `--urgency critical` for the last one.
- **30 seconds:** a critical notification that expires exactly when the
  session does, so a stale warning can never outlive what it is warning
  about. If the session is extended or ends first, the agent closes it via
  `org.freedesktop.Notifications.CloseNotification`.

**Limitation:** there is no live countdown on Linux. Drawing one would mean
shipping a GUI toolkit inside an agent whose whole point is being one small
static binary, which is not a trade worth making for thirty seconds of
clock. **Prerequisite:** `notify-send` (libnotify) and a running
notification daemon — the same shape of requirement as the logind-aware
screen locker the lock already needs.

**Not device-verified**, for the same reason the Linux lock call isn't: no
real desktop session was available in this project's development
environment.

### macOS

A launchd daemon runs in the system bootstrap context, where nothing it
draws would ever appear. The supported route into the GUI session is
`launchctl asuser <uid>`, and that uid is the owner of `/dev/console`, read
directly with `stat(2)`. If nobody is logged in at the GUI, there is
correctly nothing to show.

- **10/5/1 minute:** a Notification Center notification via `osascript`.
- **30 seconds:** a caution alert with a Dismiss button, which gives itself
  up at expiry and which the agent closes early if the session is extended.

**Limitations:** no live countdown (same reasoning as Linux — the alert
shows the seconds left when it appears). Notifications posted through
`osascript` are attributed to the script runner rather than to a registered
"Taymna" app, since Taymna ships no `.app` bundle, so a user may have to
allow them once in Notification Center, and Do Not Disturb can suppress
them — the final alert is not affected.

**Not device-verified**; like the macOS lock, this is reviewed code that CI
builds but no real Mac has run.

## A warning failure can never affect enforcement

This is structural, not a matter of being careful:

1. The enforcement tick computes the trusted time, decides
   allowed/blocked, and **calls the platform lock first**. Only then does it
   ask the warning module what to show.
2. What comes back is a *value*, not a call. The decision layer performs no
   I/O and touches no OS.
3. Those values go over a channel to a thread of their own. Delivering a
   warning means launching a process in somebody else's desktop session,
   which can block for seconds, fail, or panic — and none of it happens on
   the loop that locks the machine. If that thread dies, sends stop being
   delivered and nothing else changes.
4. Every platform implementation is infallible by contract: it logs its own
   failure and returns. A missing `notify-send`, a locked-down desktop, a
   user at the login screen with nobody to notify — all of it is a log line.

`agent/src/warning.rs` has a test that runs a full countdown through a
notifier whose every call delivers nothing, and asserts the session still
expires at exactly `expiresAt`.

Every decision is logged at `info` level as `expiry warning effect=...`
before it is handed over, and every delivery failure is logged by the
platform that hit it — so "it locked with no warning" is answerable from
the agent log alone: either the decision isn't there (a logic question) or
it is and delivery failed (a desktop/permission question).

## Security

Warnings add no new remote surface and change no existing guarantee.

- No new message types, so the server still cannot ask an agent to do
  anything. The [protocol](protocol.md) is byte-for-byte unchanged.
- **No session or server data reaches any OS invocation.** Every string
  handed to the OS is either a compile-time constant in the agent or built
  from an integer the agent computed from timestamps. A session id, for
  example, is used only as part of an in-memory identity comparison; it is
  never rendered, logged to the desktop, or passed to a process.
- Nothing goes through a shell. Arguments are separate argv entries on an
  exec'd binary (Linux, macOS) or a fixed command line whose payload is
  base64 (Windows). The quoting/escaping helpers on each platform are
  belt-and-braces on top of that, and are unit-tested against
  break-out attempts.
- No new privileged mechanism: Windows reuses the console-session launch
  the lock already performs; Linux and macOS use the documented
  service-to-user-session tools (`runuser` + the user's session bus,
  `launchctl asuser`).
- No local HTTP server, no browser, no Electron, no new runtime, and no new
  Rust dependency — `Cargo.toml` is unchanged.
