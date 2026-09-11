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
2. Copy the enrollment command it shows you:
   `taymna-agent enroll --server <api-url> --token <token>`.
3. Run that command on the target machine after installing the agent
   binary there (see [agent-install.md](agent-install.md) for building/
   downloading it and registering it as a system service). The token is
   single-use and expires in 15 minutes.
4. Install the agent as a service (systemd/Windows Service/launchd -- see
   [agent-install.md](agent-install.md)) so it survives reboots.
5. The machine should show **Online** in the dashboard within ~20 seconds
   (its first heartbeat).

## Starting, extending, and ending a session

From the dashboard: pick a preset duration (30 min / 1 hour / 2 hours /
4 hours / 8 hours) or a custom number of minutes and tap **Start session**.
While a session is active, **+30 min** / **+1 hour** extend it, and
**End session** ends it immediately -- the agent enforces the change within
one tick (~2 seconds), whether it's online right now or catches up the next
time it reconnects (see [offline-expiry.md](offline-expiry.md)).

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
