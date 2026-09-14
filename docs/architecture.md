# Architecture

Taymna is three small services around one domain concept: a **Machine** can
have at most one **Session** active at a time. Everything else in the system
exists to enforce that idea reliably, including when parts of it are offline.

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
                    |   API (NestJS)            |
                    |   - REST (machines,       |
                    |     sessions, auth)       |
                    |   - WebSocket gateway      |
                    |   - 30s expiry sweep       |
                    +-------------+------------+
                                   |
                              Postgres
                                   |
                    +--------------------------+
                    |   API (same process)      |
                    +-------------+------------+
                                   |
                    WSS (machine credential, outbound from agent)
                                   |
              +--------------------+--------------------+
              |                    |                     |
     +----------------+  +----------------+   +----------------+
     | Rust agent      |  | Rust agent      |   | Rust agent      |
     | (Windows PC)     |  | (Linux PC)      |   | (macOS laptop)  |
     +----------------+  +----------------+   +----------------+
```

Agents always dial **out** to the server over WSS; nothing ever connects
inbound to a controlled machine, so a LAN deployment and a VPS deployment
use the exact same architecture -- the only difference is which hostname the
server is reachable at (see [self-hosting.md](self-hosting.md)).

## Components

| Component | Stack | Responsibility |
|---|---|---|
| `api/` | NestJS 12, Prisma 7 (driver adapters, no Rust query engine), Postgres | Source of truth for machines/sessions/operators, REST API, WebSocket gateway, the one background job (expiry sweep) |
| `web/` | Next.js 16, React 19, Tailwind v4, React Query | Operator dashboard and usage report, installable PWA, mobile-first |
| `agent/` | Rust, tokio, tokio-tungstenite | Runs on the controlled machine: enrolls once, holds the WS connection, enforces expiry locally even when offline, and warns the user before it does |

## Repository layout

```
taymna/
├── api/          NestJS + Prisma
├── web/          Next.js PWA
├── agent/        Rust cross-platform agent
├── docs/         this directory
├── docker-compose.yml
├── .env.example
└── LICENSE       Apache-2.0
```

No shared `packages/` workspace: the handful of types both `api/` and `web/`
need (machine/session shapes, WS message envelope) are small enough (~40
lines) to duplicate rather than add monorepo tooling for.

## Domain model

```
Machine 1 ──< Session   (at most one ACTIVE Session per Machine, enforced
                          by a Postgres partial unique index, not just app
                          logic -- see docs/self-hosting.md's data section
                          and prisma/migrations/*_one_active_session_per_machine)
Machine 1 ──< EnrollmentToken   (one-time, short-lived, hashed)
Operator                         (single admin account for V1)
```

A `Machine` is not just a row -- it stands for a physical computer running a
privileged, locally-enforcing agent. So its **removal is a lifecycle
transition, not a delete**: the agent is asked to relinquish control and only
after it acknowledges is the row destroyed, so a removed machine can never be
left orphaned and enforcing. See
[enrollment.md](enrollment.md#decommissioning-a-machine).

`remaining_time` is never stored -- it's always `expiresAt - now`, computed
client-side by both the web dashboard and the agent. See
[offline-expiry.md](offline-expiry.md) for how the agent computes "now"
without trusting the OS clock unconditionally,
[protocol.md](protocol.md) for the exact WebSocket messages that carry
`expiresAt` to the agent, and [expiry-warnings.md](expiry-warnings.md) for
how the agent turns that same subtraction into the warnings a user sees
before the machine locks -- with nothing scheduled server-side.

## What Taymna deliberately does not have

Café/gaming/developer/education "modes", a policy engine, RBAC beyond one
operator role, a job queue (the expiry sweep is a single in-process cron),
Redis, Electron, or any form of remote command execution -- the agent only
ever receives session-state facts over its WebSocket connection, never a
command to run. See the project brief for the full list of intentional
non-goals.
