# Offline expiry and clock integrity

The single most important invariant in Taymna:

> A session that started at 10:00 and expires at 18:00 must make the machine
> unavailable at 18:00 **even if the server has been unreachable since
> 10:01**, and restarting the agent must never reset or extend that.

This document is the exact strategy, in the actual implementation
(`agent/src/storage.rs`, `agent/src/session.rs`), not just the intent.

## Source of truth: absolute timestamps, never a countdown

The agent persists `expiresAt` (an absolute point in time) and recomputes
`remaining = expiresAt - now` on every check. It never persists or
decrements a countdown. This alone rules out an entire class of bugs where a
missed tick, a slow restart, or a suspended process would silently grant
extra time.

Everything the agent needs to survive a restart or a server outage lives in
one small JSON file, written atomically (temp file + rename, so a crash
mid-write can't corrupt it):

```json
{
  "credentials": { "serverUrl": "...", "machineId": "...", "machineSecret": "..." },
  "session": { "id": "...", "startedAt": "...", "expiresAt": "...", "status": "ACTIVE", "updatedAt": "..." },
  "lastAppliedAt": "...",
  "trustedHighWaterMark": "..."
}
```

## The clock-tampering problem

If the agent simply trusted `SystemTime::now()`, a user could set the OS
clock backward and the session would never appear to expire. Taymna doesn't
solve this with NTP verification or a consensus protocol -- both are
disproportionate for a local session-control tool -- it solves it with a
**monotonic anti-rollback guard** (`storage::ClockGuard`):

1. The guard tracks a `trusted_high_water_mark`: the greatest wall-clock
   time it has ever legitimately observed, persisted to disk.
2. On every check (every ~2 seconds), it reads the real OS wall clock. If
   that reading is **at or after** the high-water mark, it's trusted
   outright and becomes the new high-water mark.
3. If the OS clock reads **before** the high-water mark -- the only way
   that can happen is the clock moving backward -- the guard does not trust
   it. Instead it extrapolates forward from the high-water mark using
   `std::time::Instant`, a monotonic clock the OS clock setting cannot
   affect, and that extrapolated value becomes the new high-water mark.
4. When connected, the server's own `serverTime` (present in every message)
   is authoritative and resyncs the high-water mark forward, correcting any
   drift -- but a `resync` is only ever allowed to move the mark **forward**.

Because step 3 always advances the persisted high-water mark (not just the
in-memory value), this holds up across a restart during sustained clock
rollback too: a freshly-started agent loads the last persisted high-water
mark and continues extrapolating from there, rather than resetting to
"trust whatever the tampered clock says now."

### What this does and doesn't guarantee

- **Guaranteed:** rolling the clock back at any point while the agent is
  installed cannot extend a session, whether the agent is running at that
  exact moment or not (the next tick, or the next startup, re-derives
  "now" from the persisted high-water mark, never from the tampered
  reading).
- **Not attempted:** detecting a clock that's been advanced. Moving the
  clock *forward* only makes a session expire sooner, which is not a way to
  gain unauthorized time, so it isn't treated as an attack.
- **Narrow honest gap:** the very first `ClockGuard::now()` call after an
  agent restart has, at most, a couple of seconds of imprecision (the tick
  interval) before the next check re-derives a fresh value -- not a
  meaningful window in practice.

## Reconciliation

The agent never asks the server "what's my session state" beyond its normal
`heartbeat`; the server pushes `session_state` on every connect (including
every reconnect) and every session change. Reconciliation is exactly the
stale-message rule from [protocol.md](protocol.md): a pushed message is
only applied if its timestamp is newer than the last one the agent
accepted. This means:

- **Server was down, session naturally expired locally while dark:** the
  agent has already transitioned to `Expired` and enforced it locally by
  the time the server comes back; the server's own 30-second sweep will
  have independently marked it `EXPIRED` too, and the reconnect push
  confirms the same state -- no conflict.
- **Agent was down, an operator started/extended/ended a session on the
  server in the meantime:** the very next `session_state` push (on
  reconnect) carries the current truth and is applied immediately, since
  its timestamp is newer than anything the agent locally knew.

## What's explicitly out of scope for V1

Multi-machine clock skew compensation via NTP polling, tamper-evident
storage for the state file itself (a user with local admin/root access can
delete it -- see [enforcement.md](enforcement.md) for the parallel
limitation on locking), and detecting VM snapshot/rollback tricks
specifically. All of these are real techniques a sufficiently motivated
user could pursue; Taymna's threat model is "prevent casual/accidental
override," not "survive a user with full local admin trying hard," which
matches the product's actual use cases (family/workplace time limits, not
a security boundary against a hostile machine owner).
