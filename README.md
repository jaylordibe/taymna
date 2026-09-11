# Taymna

Open-source, self-hosted timed computer control.

"Taymna" is inspired by "time na" -- a familiar Filipino/Cebuano expression
conveying that it is time, or time is up.

Set how long a computer can be used, extend the time when needed, and
automatically make it unavailable when the session expires.

## Architecture

```
                         Phone / laptop (browser)
                                   |
                          HTTPS + WSS (LAN or VPS)
                                   |
                    +--------------------------+
                    |   Web (Next.js, PWA)      |
                    +--------------------------+
                                   |
                          HTTPS + WSS (JWT bearer)
                                   |
                    +--------------------------+
                    |   API (NestJS + Prisma)   |
                    +-------------+------------+
                                   |
                              Postgres
                                   |
                    WSS (machine credential, outbound from agent)
                                   |
              +--------------------+--------------------+
     +----------------+   +----------------+   +----------------+
     | Rust agent      |   | Rust agent      |   | Rust agent      |
     | (Windows)        |   | (Linux)         |   | (macOS)         |
     +----------------+   +----------------+   +----------------+
```

Agents always dial **out**; no inbound port-forwarding to controlled
machines is ever required, on a LAN or behind a VPS. Full details:
[docs/architecture.md](docs/architecture.md).

## Screenshots

_(placeholder -- add dashboard screenshots here once you've deployed it)_

## Quick start

```bash
git clone https://github.com/<you>/taymna.git
cd taymna
cp .env.example .env
$EDITOR .env   # at minimum: JWT_SECRET, ADMIN_PASSWORD, WEB_ORIGIN, NEXT_PUBLIC_API_URL
docker compose up -d
```

Then open the web origin you configured, sign in with `ADMIN_EMAIL` /
`ADMIN_PASSWORD`, add a machine, and install the agent on it. Full
walkthrough: [docs/self-hosting.md](docs/self-hosting.md).

## Agent setup

The agent is a single Rust binary that enrolls once and then runs as a
native OS service. Development doesn't require installing a service:

```bash
cd agent
cargo run -- enroll --server https://your-taymna-server --token <token>
cargo run
```

Installing it as a systemd service / Windows Service / launchd daemon for
always-on use: [docs/agent-install.md](docs/agent-install.md).

## Development

Each app runs independently against its own dev tooling:

```bash
# API (needs a local Postgres -- see docker-compose.yml for the shape, or run
# `docker run -e POSTGRES_USER=taymna -e POSTGRES_PASSWORD=... -e POSTGRES_DB=taymna -p 5432:5432 postgres:17-alpine`)
cd api
cp .env.example .env   # or hand-write one pointing at your local Postgres
npm install
npm run db:migrate:dev
npm run start:dev

# Web
cd web
npm install
npm run dev

# Agent
cd agent
cargo run
```

Test/lint/build commands per app:

| | lint | typecheck | test | build |
|---|---|---|---|---|
| `api/` | `npm run lint` | `npm run typecheck` | `npm test` + `npm run test:e2e` | `npm run build` |
| `web/` | `npm run lint` | `npm run typecheck` | `npm test` | `npm run build` |
| `agent/` | `cargo fmt --check` | -- | `cargo test` | `cargo build` |, plus `cargo clippy --all-targets -- -D warnings`

## Self-hosting

[docs/self-hosting.md](docs/self-hosting.md) -- prerequisites, environment
variables (and the two that trip people up), first startup, enrolling a
machine, starting/extending/ending sessions, stopping and upgrading.

## Security model

[docs/security.md](docs/security.md) -- operator auth, machine credentials,
input validation, transport, logging, and known limitations stated
plainly.

## Platform support / status

| OS | Enforcement mechanism | Status |
|---|---|---|
| Windows | Service (LocalSystem) locks the active console session via `WTSQueryUserToken` + `CreateProcessAsUserW` | Implemented against documented Win32 APIs; not device-verified (no Windows host in development) |
| Linux | systemd service; `loginctl lock-sessions` via systemd-logind | Implemented and exercised live (error/retry and start/stop behavior confirmed end-to-end); real lock call not exercised against a live desktop session in development |
| macOS | launchd daemon; simulates the OS lock shortcut via System Events (requires Accessibility permission, granted once during install) | Implemented against documented APIs; not device-verified (no macOS host in development) |

Every platform shares the same honest limitation: locking the screen
doesn't block a not-yet-logged-in session at a fresh boot, and can't stop
someone who already knows their own OS password from unlocking (Taymna's
re-assertion loop re-locks within ~2 seconds if that happens while the
session should be blocked). Full detail: [docs/enforcement.md](docs/enforcement.md).

## Other documentation

- [docs/protocol.md](docs/protocol.md) -- the WebSocket protocol, message by message
- [docs/enrollment.md](docs/enrollment.md) -- how an agent gets associated with a machine
- [docs/offline-expiry.md](docs/offline-expiry.md) -- the clock-integrity strategy behind "a session expires even if the server is unreachable"

## Contributing

This is a young project; issues and PRs are welcome. Before sending a PR:
run the lint/typecheck/test/build commands for whichever app(s) you
touched (table above), and for anything touching the WebSocket protocol,
session state machine, or platform enforcement, please read
[docs/protocol.md](docs/protocol.md), [docs/offline-expiry.md](docs/offline-expiry.md),
and [docs/enforcement.md](docs/enforcement.md) first -- those documents
describe real invariants the tests depend on, not just style preferences.

## License

[Apache License 2.0](LICENSE).
