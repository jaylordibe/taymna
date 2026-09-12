# Security model

## Operator authentication

A single admin account per installation (V1 -- no multi-user, no RBAC
framework). Bootstrapped on first API startup from `ADMIN_EMAIL`/
`ADMIN_PASSWORD` env vars if no operator row exists yet -- see
[self-hosting.md](self-hosting.md). Passwords are hashed with argon2id.
Login issues a JWT (7-day expiry) that the web app stores client-side
(`localStorage`, not an httpOnly cookie) and sends as
`Authorization: Bearer <token>`.

**Why no cookies:** this is a LAN-facing tool primarily used from a phone
browser, often across origins/ports during self-hosted setups. A bearer
token in an `Authorization` header carries no ambient credential a
cross-site request could exploit, so there is no CSRF surface at all --
trading it for XSS as the residual risk, which is mitigated by Next.js's
default output escaping (this app renders no untrusted HTML) and by never
persisting anything more sensitive than the session token itself in
`localStorage`.

Login attempts are timing-safe (a failed lookup still runs a full
`argon2.verify` against a dummy hash, so a nonexistent email and a wrong
password take the same time) and rate-limited (`@nestjs/throttler`, 5/min
on `/auth/login`).

## Machine credentials

See [enrollment.md](enrollment.md) for the full flow. In short: every
machine has its own independent secret, generated at enrollment, stored
only as an argon2id hash, never shared across machines, and revocable
without affecting any other machine.

## Input validation

- Every REST DTO is validated with `class-validator` via a global
  `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true` -- unknown
  fields are rejected, not silently dropped or accepted).
- Every route param that names a database row (`machineId`, `sessionId`,
  `id`) goes through `ParseUUIDPipe`, and the one id that arrives inside a
  request body instead of a route param (the enrollment token's id half) is
  validated with `isUUID()` before it reaches a query. This exists because
  of a real bug found during development -- see the note in
  [enrollment.md](enrollment.md) -- and is backed by regression tests.
- The global exception filter also catches any Prisma-level validation
  error that slips through as defense-in-depth, mapping it to a clean `400`
  instead of leaking a database error message as a `500`.

## Transport and headers

- CORS restricted to `WEB_ORIGIN` (comma-separated allowlist).
- `helmet()` applied globally (CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, etc.).
- The web app additionally sets its own security headers
  (`next.config.ts`: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`) since it's a separate origin/process from the API.
- The agent's WebSocket connection uses WSS when the configured server URL
  is `https://`; the enrollment HTTP call uses `reqwest` with `rustls`
  (no OpenSSL system dependency).

## No arbitrary remote execution

This is a structural property of the protocol, not a policy the code
happens to follow: the agent's WebSocket message parser
(`agent/src/client.rs`) only knows how to deserialize three server->agent
message shapes (`session_state`, `heartbeat_ack`, `error`), none of which
carry a command, shell string, or file path. See
[protocol.md](protocol.md) for the full message catalogue.

The agent does invoke OS processes -- to lock the machine, and to show
expiry warnings -- but never with data that came off the wire. Every
string handed to a process is a compile-time constant in the agent or is
built from an integer the agent computed from timestamps; arguments are
passed as separate argv entries (or, on Windows, as a fixed command line
with a base64 payload), never through a shell. The one piece of
server-supplied data the warning path touches at all, the session id, is
used solely for an in-memory equality check. See
[expiry-warnings.md](expiry-warnings.md).

## Logging

Structured logging via `nestjs-pino`, with `Authorization` headers and
password/token/secret request-body fields redacted before they're ever
written to a log line (`app.module.ts`'s `redact` config) -- so a log dump
is never itself a credential leak.

## Secrets hygiene

- No secret is ever stored in plaintext: operator passwords, machine
  credentials, and enrollment tokens are all argon2id hashes at rest.
- `.env` files are gitignored everywhere in the repo (root, `api/`, `web/`);
  `.env.example` documents every variable without real values.
- The agent's local state file (which holds its machine credential) is
  written with `0600` permissions on Unix. Windows ACL hardening for that
  file is not implemented in V1 -- the practical protection is that the
  service runs as LocalSystem and the directory isn't writable by a
  standard user; see the note in `agent/src/storage.rs`.

## Known limitations (stated plainly, not buried)

- Single operator account, no audit log, no per-operator permissions --
  intentional V1 scope, not an oversight.
- The agent's platform-specific Windows and macOS enforcement code has not
  been device-verified in this project's development environment (no
  Windows/macOS test hardware was available) -- see
  [enforcement.md](enforcement.md) for exactly what was and wasn't
  verified.
- Taymna's threat model is "prevent casual/accidental override of a time
  limit," not "withstand a user with full local admin/root trying hard" --
  see the closing note in [offline-expiry.md](offline-expiry.md).
