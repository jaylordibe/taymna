# Enrollment

How an installed agent gets associated with a `Machine` record, and how it
authenticates afterward.

## The `<id>.<secret>` shape

Both the one-time enrollment token and the long-lived machine credential use
the same shape: a database row's `id` (a UUID, safe to expose, not secret)
followed by a `.` and a random secret whose **hash** (argon2id) is the only
thing ever stored. This lets the server look the row up efficiently by `id`
(an indexed primary-key lookup) and then verify the secret against that
row's hash -- rather than scanning every unexpired token trying to match a
password-style credential with no efficient lookup key. The WebSocket
gateway's `Authorization: Machine <id>.<secret>` header uses the identical
pattern for the ongoing machine credential.

## Flow

1. An operator creates a machine (name + platform) from the dashboard.
   `POST /machines` creates the `Machine` row **and**, in the same call,
   issues a one-time enrollment token: a random 32-byte secret, hashed and
   stored on a new `EnrollmentToken` row with a 15-minute expiry. The
   plaintext token (`<enrollmentTokenId>.<secret>`) is returned exactly
   once, in that response.
2. The dashboard shows the exact command to run on the target machine:
   ```
   taymna-agent enroll --server <api-url> --token <token>
   ```
3. The agent POSTs `{ "token": "..." }` to `POST /machines/enroll` (public,
   rate-limited: 10 requests/minute). The server:
   - splits the token, rejects anything that isn't a well-formed UUID id
     (see the note on input validation below),
   - looks up the `EnrollmentToken` by id, verifies it's unused, unexpired,
     and that the secret matches its hash,
   - marks it used (single-use -- a second redemption attempt with the same
     token fails),
   - generates a fresh **machine secret**, stores only its argon2id hash on
     the `Machine` row, and returns `{ machineId, machineSecret }` --
     shown/stored exactly once.
4. The agent persists `{ serverUrl, machineId, machineSecret }` to its local
   state file (`0600` permissions on Unix -- see
   [offline-expiry.md](offline-expiry.md) for the rest of that file's
   contents) and uses the credential for every subsequent WebSocket
   connection.

## Properties this gives you

- **No shared/global agent secret anywhere.** Every machine's credential is
  independent; compromising one machine's secret does not expose any other
  machine or the operator account.
- **Tokens are single-use and short-lived.** A token intercepted after
  redemption is worthless; one that's never used expires in 15 minutes.
- **Revocation is immediate.** `DELETE /machines/:id/credential` nulls the
  stored hash and closes any live WebSocket connection for that machine
  (close code `4001`). The agent will retry and fail every reconnect until
  re-enrolled with a fresh token (`POST /machines/:id/enrollment-tokens`).
- **Nothing is ever stored in plaintext.** Not the enrollment token, not the
  machine secret, not the operator's password -- all argon2id hashes.

## Decommissioning a machine

Removing a machine is **not** a database delete. A `Machine` row represents a
physical computer running a privileged, locally-enforcing agent; deleting the
row while that agent is installed and enforcing would strand it -- its
server-side identity gone, the agent still locking the machine every couple of
seconds from its persisted state, and unable to reconnect (its credential no
longer authenticates). The machine ends up locked with no way to recover it
through Taymna. Removal is therefore an explicit, acknowledged lifecycle
hand-off in which the agent relinquishes control *before* its identity is
destroyed.

### Lifecycle

```
MANAGED  ──remove requested──▶  PENDING DECOMMISSION  ──agent ack──▶  removed
```

- **MANAGED** — the normal state (`decommissionRequestedAt` is null). Every
  existing machine is here.
- **PENDING DECOMMISSION** — an operator clicked *Remove machine*. The server
  sets `decommissionRequestedAt` and tells the connected agent to relinquish
  control (a `decommission` message; see [protocol.md](protocol.md)). Crucially
  the **row and its credential stay valid**, so the agent can still
  authenticate and be told -- if it is offline, the machine simply waits here
  until it next connects.
- **removed** — the agent has acknowledged that it durably un-enrolled and
  stopped enforcing (`decommission_ack`). Only now does the server delete the
  row (cascading its sessions and tokens), which permanently invalidates the
  old credential, and close the agent's socket with code `4003`.

A machine with **no usable credential** -- never enrolled, or credential
already revoked -- has no agent that can authenticate to be told anything, so
there is no live agent to strand: it is deleted directly.

### What the agent does

On receiving an authenticated `decommission`, the agent, **in this order**:

1. writes `decommissioned: true` (and clears its session) to its local state
   file, atomically, so the fact is durable;
2. dismisses any expiry warning/countdown on screen and stops warning;
3. stops enforcing -- it never calls the OS lock again (it does **not** unlock
   anything: if the screen is already locked the user signs in normally with
   their own OS password);
4. only then sends `decommission_ack`.

The persist-before-ack ordering is deliberate: if the process crashes, the
machine reboots, or the network drops in the gap between accepting and the ack
reaching the server, the agent that comes back up reads `decommissioned: true`
and stays **inert** -- it never resumes enforcement, and it safely re-delivers
the ack on its next connect. A decommissioned agent is left installed but
un-enrolled and non-enforcing; a service restart or reboot does not resurrect
enforcement. Re-enrolling (below) is what makes it managed again.

### Re-enrolling a decommissioned computer

A decommissioned computer is enrolled again through the **normal** process:
create a machine on the dashboard and run the installer with the fresh token.
This produces a brand-new machine identity; the old row (and credential) are
gone and cannot be reused or resurrected. The agent's `enroll` command clears
the local `decommissioned` flag and any stale session, so the machine starts
clean and managed.

### Recovering an orphaned agent (legacy)

Older Taymna versions removed a machine by deleting the row outright, which
could leave an agent orphaned: still installed and enforcing, but with a
server identity that no longer exists, so it can neither be told to stop nor
reconnect. The current acknowledged removal makes this state unreachable
through normal use, but a computer orphaned by an **older** version (or by an
unclean uninstall) is recovered with **local administrative control of the
machine** -- which is the correct trust boundary; there is deliberately no
network-accessible backdoor for this.

- **Windows**: boot into Safe Mode if you cannot reach the desktop, then stop
  and disable the service, e.g. `sc stop TaymnaAgent` and
  `sc config TaymnaAgent start= disabled` (or remove it with `sc delete
  TaymnaAgent`). Then re-run the installer to re-enroll cleanly, or uninstall.
- **Linux (systemd)**: `sudo systemctl disable --now taymna-agent`. Re-run the
  installer to re-enroll, or remove `/etc/systemd/system/taymna-agent.service`
  and `/var/lib/taymna-agent` to uninstall.
- **macOS (launchd)**: `sudo launchctl bootout system/dev.taymna.agent`. Re-run
  the installer to re-enroll, or remove
  `/Library/LaunchDaemons/dev.taymna.agent.plist` and `/var/lib/taymna-agent`.

The lock itself is only Taymna re-locking an interactive session; once the
service is stopped, signing in with the computer's own OS password works
normally (Taymna never touches OS authentication -- see
[enforcement.md](enforcement.md)).

## A real bug this shape caught (and fixed)

Machine/token ids are stored as native Postgres `uuid` columns. Early in
development, a malformed id reaching a Prisma query (e.g. a mistyped token,
or a machine id typo in a URL) surfaced as a raw
`invalid input syntax for type uuid` driver error, which an earlier version
of the API let escape as an uncaught `500`. Fixed by validating the id shape
before it ever reaches a query (`ParseUUIDPipe` on REST route params,
`isUUID()` checks in the enrollment/machine-credential service code) plus a
defense-in-depth catch in the global exception filter for anything that
still slips through. Regression tests for both paths live in
`api/test/session-lifecycle.e2e-spec.ts`.
