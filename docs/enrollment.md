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
