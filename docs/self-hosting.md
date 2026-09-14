# Self-hosting

Target experience:

```bash
git clone https://github.com/<you>/taymna.git
cd taymna
cp .env.example .env
$EDITOR .env
docker compose up -d
```

## Prerequisites

- Docker and Docker Compose (the `docker compose` plugin, not the standalone
  `docker-compose` v1 binary).
- A machine to run the server on: your LAN (a home server, NAS, always-on
  PC) or a VPS -- the compose stack is identical either way. Agents always
  dial **out** to the server over WSS, so nothing needs inbound port
  forwarding to the machines you're controlling; only the server itself
  needs its ports reachable by the browsers and agents that will talk to
  it.

## Environment variables

Copy `.env.example` to `.env` and fill it in. Every variable is documented
inline in that file; the two that trip people up:

- **`WEB_ORIGIN`** and **`NEXT_PUBLIC_API_URL`** must agree with each other
  and with how you'll actually *reach* the two services -- not the
  Docker-internal service names. On a LAN, that's typically your server's
  LAN IP: `WEB_ORIGIN=http://192.168.1.50:3001` and
  `NEXT_PUBLIC_API_URL=http://192.168.1.50:3000`. On a VPS behind a reverse
  proxy with TLS, use the real hostnames:
  `WEB_ORIGIN=https://taymna.example.com`,
  `NEXT_PUBLIC_API_URL=https://api.taymna.example.com`.
- **`NEXT_PUBLIC_API_URL` is baked into the web app at build time**
  (Next.js inlines `NEXT_PUBLIC_*` vars into the client bundle). Changing it
  later requires `docker compose build web` again, not just a restart --
  `docker-compose.yml` passes it as a build arg for exactly this reason.

- **`NEXT_PUBLIC_AGENT_SERVER_URL`** (optional) is the address the *agents*
  use to reach the API, and is what the dashboard puts in the install
  commands it shows you. Set it when that differs from
  `NEXT_PUBLIC_API_URL` -- typically while the dashboard is on
  `localhost`/LAN and agents come in through a tunnel or public hostname
  (`https://abc.ngrok-free.app`, `https://api.example.com`). Leave it empty
  to use `NEXT_PUBLIC_API_URL`. Also baked in at build time.

Generate `JWT_SECRET` with `openssl rand -base64 48`. Set a real
`ADMIN_PASSWORD` before first boot -- it's only read once, to create the
initial operator account.

## First startup

```bash
docker compose up -d
docker compose ps   # wait for postgres and api to report "healthy"
```

On first boot, the `api` container runs `prisma migrate deploy` (applies
the schema) and then, on its own first startup, creates the initial
operator account from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if none exists yet --
this only happens once; on every later restart it's a no-op. Upgrading
Taymna later is the same command (`docker compose up -d --build`):
migrations are idempotent and only apply what's new.

Open `http://<web-origin>` (or your domain) in a browser and sign in with
`ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Enrolling a machine

1. In the dashboard, click **Add machine**, name it, pick its platform.
2. Copy the one-line install command it shows you. It's pre-filled with the
   server address (`NEXT_PUBLIC_AGENT_SERVER_URL`, see above) and a token
   that is single-use and expires in 15 minutes.
3. Run it on the target machine -- PowerShell as Administrator on Windows,
   a terminal on Linux/macOS. It downloads the agent, registers it as a
   system service, enrolls, starts it, and confirms it connected (see
   [agent-install.md](agent-install.md) for what it does and how to do it
   by hand).
4. The machine shows **Online** in the dashboard within seconds. With no
   session active it is locked from that moment on -- start a session to
   make it usable.

Need a fresh token later (expired, or re-enrolling after the server address
changed)? Click **Installation command** on the machine's card.

## Revoking and removing machines

On each machine's card:

- **Revoke credential** disconnects the agent and invalidates its saved
  credential; it can't reconnect until it's enrolled again with a fresh
  token. Use it if a machine's credential may have leaked. Note that revoking
  does **not** stop an installed agent enforcing locally, and a revoked machine
  can no longer be cleanly removed (it can't reconnect to be told to) -- so
  prefer **Remove machine** while the machine is still managed.
- **Remove machine** (after a confirmation) starts a coordinated removal, not
  an immediate delete. Taymna tells the agent to relinquish control; the agent
  stops enforcing and acknowledges, and only then is the machine deleted (with
  its sessions and tokens) and dropped from the dashboard. This is what
  prevents the machine being left locked with no way to recover it through
  Taymna.
  - If the machine is **online**, this takes a moment; the card shows
    *Removing…* and then disappears.
  - If it is **offline**, the card shows *Waiting for this machine* and stays
    there until the agent next connects, at which point the removal completes
    automatically -- no queue, no polling.
  - A machine that was **never enrolled**, or whose credential was already
    revoked, has no agent to coordinate with and is removed immediately.

  After removal the computer behaves as un-enrolled: the agent stays installed
  but inert (a reboot does not resume enforcement), and you enroll it again
  through the normal flow with a fresh token. See
  [enrollment.md](enrollment.md#decommissioning-a-machine), including how to
  recover a machine orphaned by an older Taymna version.

## Starting, extending, and ending a session

From the dashboard: pick a preset duration (30 min / 1 hour / 2 hours /
4 hours / 8 hours) or a custom number of minutes and tap **Start session**.
While a session is active, **+30 min** / **+1 hour** extend it, and
**End session** ends it immediately -- the agent enforces the change within
one tick (~2 seconds), whether it's online right now or catches up the next
time it reconnects (see [offline-expiry.md](offline-expiry.md)).

## Exposing it on the internet (VPS with TLS)

The compose stack is the same on a VPS; what changes is that a reverse
proxy with TLS sits in front of it. This matters beyond security: browsers
only allow the dashboard to be **installed as an app** (home-screen icon,
full-screen, no browser chrome) over HTTPS, and agents should talk to the
API over `wss://`. [Caddy](https://caddyserver.com) is the least-effort
choice because it obtains and renews certificates itself.

The step-by-step version of this, from a blank Ubuntu server (firewall,
Docker, swap, Caddy, backups, troubleshooting), is
[deploy-ubuntu-vps.md](deploy-ubuntu-vps.md). The essentials:

1. DNS: point `taymna.example.com` and `api.taymna.example.com` (A/AAAA
   records) at the VPS. Open ports 80 and 443 in its firewall. The api/web
   host ports should *not* be reachable from the internet -- set
   `BIND_ADDRESS=127.0.0.1` in `.env` so they're published on localhost
   only -- and on a server that already runs other apps, move them off the
   default 3000/3001 with `API_PORT`/`WEB_PORT`.
2. `.env` on the VPS:
   ```
   BIND_ADDRESS=127.0.0.1
   API_PORT=48100
   WEB_PORT=48101
   WEB_ORIGIN=https://taymna.example.com
   NEXT_PUBLIC_API_URL=https://api.taymna.example.com
   NEXT_PUBLIC_AGENT_SERVER_URL=https://api.taymna.example.com
   ```
   then `docker compose up -d --build` (the `NEXT_PUBLIC_*` values are
   baked into the web build).
3. Install Caddy on the VPS and use this `/etc/caddy/Caddyfile`:
   ```
   taymna.example.com {
       reverse_proxy 127.0.0.1:48101
   }

   api.taymna.example.com {
       reverse_proxy 127.0.0.1:48100
   }
   ```
   (the two ports being whatever you set `WEB_PORT`/`API_PORT` to), then
   `systemctl reload caddy`. Caddy provisions Let's Encrypt certificates on
   first request and proxies WebSockets without extra configuration.
4. Sign in at `https://taymna.example.com`. On a phone, "Add to Home
   Screen" (iOS Safari) or the install prompt (Android Chrome) now installs
   it as an app. New machines get install commands pointing at
   `https://api.taymna.example.com`; machines enrolled earlier against a
   different address need a fresh token and a re-enroll
   ([agent-install.md](agent-install.md), "server URL changes").

## Stopping and upgrading

```bash
docker compose down          # stop; the Postgres volume is preserved
docker compose down -v       # stop AND delete all data -- irreversible
git pull
docker compose up -d --build # upgrade: rebuild images, re-run migrations
```

The migration that adds the machine-decommission lifecycle is additive and
nullable, so it is safe to apply to a live database: every existing machine
keeps working exactly as before (they default to managed).

**Upgrade the server before relying on clean removal, then upgrade agents.**
An agent that predates this feature does not understand the removal
instruction and will not acknowledge it -- so if you *Remove* such a machine it
safely stays in *Waiting for this machine* and keeps enforcing normally
(never orphaned) until you upgrade its agent, at which point the removal
completes. In other words, a machine can only be cleanly removed once its agent
is new enough; the server never deletes a machine's row until an agent has
acknowledged, so no rollout order can strand one.

## Data

Everything lives in the `postgres-data` named volume Docker Compose
creates. Back it up like any Postgres database
(`docker compose exec postgres pg_dump -U <user> <db>`) if you care about
it -- there's no separate backup mechanism built into Taymna itself in V1.
