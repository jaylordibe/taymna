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
  token. Use it if a machine's credential may have leaked, or to take a
  machine out of service without deleting its history.
- **Remove machine** deletes the machine along with its sessions and tokens
  (after a confirmation). Any live agent is disconnected first. The agent
  software on that machine keeps running until you uninstall it (stop and
  delete the service), but it can never reconnect.

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

1. DNS: point `taymna.example.com` and `api.taymna.example.com` (A/AAAA
   records) at the VPS. Open ports 80 and 443 in its firewall; 3000 and
   3001 should *not* be reachable from the internet (either firewall them,
   or change the `ports:` lines in `docker-compose.yml` to
   `"127.0.0.1:3000:3000"` / `"127.0.0.1:3001:3000"` so they bind to
   localhost only).
2. `.env` on the VPS:
   ```
   WEB_ORIGIN=https://taymna.example.com
   NEXT_PUBLIC_API_URL=https://api.taymna.example.com
   NEXT_PUBLIC_AGENT_SERVER_URL=https://api.taymna.example.com
   ```
   then `docker compose up -d --build` (the `NEXT_PUBLIC_*` values are
   baked into the web build).
3. Install Caddy on the VPS and use this `/etc/caddy/Caddyfile`:
   ```
   taymna.example.com {
       reverse_proxy 127.0.0.1:3001
   }

   api.taymna.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
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

## Data

Everything lives in the `postgres-data` named volume Docker Compose
creates. Back it up like any Postgres database
(`docker compose exec postgres pg_dump -U <user> <db>`) if you care about
it -- there's no separate backup mechanism built into Taymna itself in V1.
