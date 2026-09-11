# Deploying on an Ubuntu VPS

A complete walkthrough from a fresh Ubuntu server to a Taymna server that
browsers and agents reach over HTTPS. Verified against the layout in
`docker-compose.yml`; assumes Ubuntu 22.04 or 24.04.

## What you end up with

```
Internet ──443──> reverse proxy with TLS (Caddy or nginx, on the VPS host)
                    ├── taymna.example.com     ──> 127.0.0.1:<WEB_PORT>  web (Next.js)
                    └── api.taymna.example.com ──> 127.0.0.1:<API_PORT>  api (NestJS)
                                                                          └── postgres (internal only)
```

Docker Compose runs the three containers published on localhost only, on
two host ports you choose (`API_PORT`/`WEB_PORT`); the reverse proxy is the
only thing listening on the public interface. This guide uses **48100** and
**48101** -- high, uncommon numbers that won't collide with the Node/Next
defaults (3000/3001) other apps on the same server are likely using.
Postgres is never published on the host at all. Agents on the controlled
machines dial out to `api.taymna.example.com` over `wss://`; nothing on
those machines needs an open port.

If the server already runs other sites behind Caddy or nginx, you keep that
proxy and just add two entries to it (step 5 covers both).

## Prerequisites

- A VPS with **2 GB RAM** recommended (1 GB works with swap -- see below;
  the one-time `next build` is the memory-hungry step). Any x86-64 or
  arm64 VPS is fine: images are built from source on the server.
- Ubuntu 22.04 or 24.04 with SSH access.
- A domain with two DNS records pointing at the VPS's IP -- e.g.
  `taymna.example.com` (dashboard) and `api.taymna.example.com` (API).
  Create these first; Caddy can't issue certificates until they resolve.

Everything below is run over SSH on the VPS. Replace the two hostnames with
yours throughout.

## 1. Basic server hardening

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --version >/dev/null && sudo ufw --force enable
sudo ufw status
```

Only SSH, HTTP and HTTPS are reachable from outside. The api/web host ports
(48100/48101 below) are never opened: the compose stack binds them to
localhost, and Postgres isn't published on the host at all.

If the VPS has 1 GB of RAM, add swap before building:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Install Docker

Docker's official repository (not Ubuntu's older `docker.io` package):

```bash
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in so the `docker` group applies, then check:

```bash
docker compose version
```

Docker starts on boot, and every Taymna container has
`restart: unless-stopped`, so the stack comes back up after a reboot on its
own.

## 3. Get Taymna and configure it

```bash
git clone https://github.com/jaylordibe/taymna.git
cd taymna
cp .env.example .env
nano .env
```

First pick two free host ports. See what's already listening:

```bash
sudo ss -tlnp | awk 'NR==1 || /LISTEN/' | sort -k4
```

Anything in that list is taken. `48100`/`48101` are used below; if either
appears, pick other numbers in the 40000–60000 range (they're only ever
reached from the proxy on the same machine, so the value is arbitrary).

Then set these (every variable is explained inline in the file):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | a random password (`openssl rand -hex 16`) |
| `DATABASE_URL` | must contain that same password |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | your dashboard login; only read on first boot |
| `BIND_ADDRESS` | `127.0.0.1` |
| `API_PORT` | `48100` (or your free port) |
| `WEB_PORT` | `48101` (or your free port) |
| `WEB_ORIGIN` | `https://taymna.example.com` |
| `NEXT_PUBLIC_API_URL` | `https://api.taymna.example.com` |
| `NEXT_PUBLIC_AGENT_SERVER_URL` | `https://api.taymna.example.com` |

`BIND_ADDRESS=127.0.0.1` keeps the two ports off the public interface;
`API_PORT`/`WEB_PORT` are only the host side (inside the containers the
services always listen on 3000, so nothing else needs to change). The two
`NEXT_PUBLIC_*` values are baked into the web image at build time --
changing them later means `docker compose up -d --build`, not just a
restart.

## 4. Start the stack

```bash
docker compose up -d --build
docker compose ps
```

The first build takes a few minutes. Wait until `postgres` and `api` show
`healthy`, then confirm from the VPS itself:

```bash
curl -s http://127.0.0.1:48100/health/ready     # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:48101/   # 200
```

If `docker compose up` fails with `Bind for 127.0.0.1:48100 failed: port is
already allocated`, that port is taken after all -- pick another, change
`.env`, run `docker compose up -d` again.

On first boot the `api` container applies the database migrations and
creates the admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## 5. Put a reverse proxy with TLS in front

Two things matter for whichever proxy you use: it terminates TLS for both
hostnames, and it passes WebSocket upgrades through (the agents' and
dashboard's live connections are at `/ws`). Pick the section that matches
the server.

### Caddy (recommended; also if Caddy already serves your other sites)

If Caddy isn't installed yet:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

**Add** these two site blocks to `/etc/caddy/Caddyfile` -- alongside any
sites already in it, don't replace them (a Caddyfile is just a list of site
blocks). On a fresh install, replace the placeholder `:80` block with them:

```
taymna.example.com {
    reverse_proxy 127.0.0.1:48101
}

api.taymna.example.com {
    reverse_proxy 127.0.0.1:48100
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy requests certificates for both names on the first visit (this needs
the DNS records live and port 80 open) and proxies WebSockets without any
extra configuration.

### nginx (if that's what already fronts the server)

Create `/etc/nginx/sites-available/taymna` -- the `Upgrade`/`Connection`
headers and `proxy_http_version 1.1` are what let WebSockets through:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name taymna.example.com;
    location / {
        proxy_pass http://127.0.0.1:48101;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}

server {
    listen 80;
    server_name api.taymna.example.com;
    location / {
        proxy_pass http://127.0.0.1:48100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;   # keep idle WebSocket connections open
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/taymna /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d taymna.example.com -d api.taymna.example.com
```

certbot rewrites both server blocks for HTTPS and installs a renewal timer.

### Verify

```bash
curl -s https://api.taymna.example.com/health/live   # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://taymna.example.com/   # 200
```

## 6. First use

1. Open `https://taymna.example.com` and sign in with `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`.
2. On a phone, install it as an app: iOS Safari → Share → **Add to Home
   Screen**; Android Chrome → the install prompt or ⋮ → **Install app**.
   (This is only offered over HTTPS, which is one reason for step 5.)
3. **Add machine**, then run the install command it shows on that machine
   ([agent-install.md](agent-install.md)). It points agents at
   `https://api.taymna.example.com` automatically.

Machines enrolled earlier against a different address (a tunnel, a LAN IP)
need a fresh token and a re-enroll -- see "server URL changes" in
[agent-install.md](agent-install.md).

## Day-to-day operations

**Logs**

```bash
docker compose logs -f api        # or web, postgres
sudo journalctl -u caddy -f
```

**Upgrade** (migrations are applied automatically on start):

```bash
cd ~/taymna && git pull && docker compose up -d --build
```

**Backup** -- everything is in the Postgres volume:

```bash
docker compose exec -T postgres pg_dump -U taymna taymna | gzip > "taymna-$(date +%F).sql.gz"
```

A nightly cron line for that (`crontab -e`):

```
0 3 * * * cd /home/$USER/taymna && docker compose exec -T postgres pg_dump -U taymna taymna | gzip > /home/$USER/backups/taymna-$(date +\%F).sql.gz
```

**Restore** into an empty stack:

```bash
docker compose down -v && docker compose up -d postgres
sleep 5
gunzip -c taymna-2026-09-11.sql.gz | docker compose exec -T postgres psql -U taymna taymna
docker compose up -d
```

**Change a setting**: edit `.env`, then `docker compose up -d` (or
`--build` if a `NEXT_PUBLIC_*` value changed).

## Troubleshooting

- **Caddy shows certificate errors** -- the DNS records don't resolve to
  this VPS yet, or port 80 is blocked (Let's Encrypt validates over HTTP).
  `sudo journalctl -u caddy -n 50` says which.
- **Dashboard loads but every action fails / "Couldn't load machines"** --
  `WEB_ORIGIN` doesn't match the dashboard's real address (the API refuses
  cross-origin requests from anywhere else), or `NEXT_PUBLIC_API_URL` was
  changed without rebuilding the web image. Check `docker compose logs api`
  for CORS errors, fix `.env`, `docker compose up -d --build`.
- **502 from Caddy** -- a container isn't up: `docker compose ps`,
  `docker compose logs api`.
- **A machine never shows Online** -- on that machine, the installer's
  output (or its log, see [agent-install.md](agent-install.md)) says
  whether it can't resolve/reach `api.taymna.example.com` or was rejected.
  From the VPS, `docker compose logs api | grep -i machine` shows
  authentication attempts.
- **Out of memory during `docker compose up --build`** -- add swap (step 1)
  or use a 2 GB VPS; the Next.js build is the only heavy step.
