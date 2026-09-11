# Deploying on an Ubuntu VPS

A complete walkthrough from a fresh Ubuntu server to a Taymna server that
browsers and agents reach over HTTPS. Verified against the layout in
`docker-compose.yml`; assumes Ubuntu 22.04 or 24.04.

Names used throughout -- replace with yours:

| | This guide | Meaning |
|---|---|---|
| Dashboard hostname | `taymna.example.com` | what you open in a browser / install on a phone |
| API hostname | `api.taymna.example.com` | what agents connect to |
| API host port | `48100` | `API_PORT` in `.env` |
| Web host port | `48101` | `WEB_PORT` in `.env` |
| Compose project | `taymna` | pinned in `docker-compose.yml`; network `taymna_default`, containers `taymna-api`, `taymna-web`, `taymna-postgres` |

## What you end up with

A reverse proxy is the only thing on the public interface; it terminates
TLS for both hostnames and passes WebSockets through. Postgres is never
published on the host. Agents on the controlled machines dial out to
`api.taymna.example.com` over `wss://`; nothing on those machines needs an
open port.

Proxy installed **on the host** (Caddy or nginx as a system service):

```
Internet ──443──> proxy on the VPS host
                    ├── taymna.example.com     ──> 127.0.0.1:48101  ──> taymna-web:3000
                    └── api.taymna.example.com ──> 127.0.0.1:48100  ──> taymna-api:3000
                                                                            └── taymna-postgres (internal only)
```

Proxy running **as a Docker container** (nginx in compose, fronting several
dockerised apps):

```
Internet ──443──> nginx container ── joined to network taymna_default ──┬── taymna-web:3000
                                                                        └── taymna-api:3000
                                                                              └── taymna-postgres
```

In the first layout the containers are published on localhost ports 48100
and 48101 -- high, uncommon numbers chosen so they don't collide with the
Node/Next defaults (3000/3001) other apps on the same server are likely
using. In the second, nginx talks to the containers by name and the host
ports are not used at all (they're still published on localhost, harmlessly).

## Prerequisites

- A VPS with **2 GB RAM** recommended (1 GB works with swap -- see below;
  the one-time `next build` is the memory-hungry step). Any x86-64 or
  arm64 VPS is fine: images are built from source on the server.
- Ubuntu 22.04 or 24.04 with SSH access.
- Two DNS records (A/AAAA) pointing at the VPS's IP: `taymna.example.com`
  and `api.taymna.example.com`. Create these first; certificates can't be
  issued until they resolve.

Everything below is run over SSH on the VPS.

## 1. Basic server hardening

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

Only SSH, HTTP and HTTPS are reachable from outside. Ports 48100/48101 are
never opened: the compose stack binds them to localhost.

If the VPS has 1 GB of RAM, add swap before building:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Install Docker

Docker's official repository (not Ubuntu's older `docker.io` package).
Skip this if the server already runs Docker.

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

Log out and back in so the `docker` group applies, then check
`docker compose version`. Docker starts on boot, and every Taymna container
has `restart: unless-stopped`, so the stack comes back after a reboot on its
own.

## 3. Get Taymna and configure it

```bash
git clone https://github.com/jaylordibe/taymna.git
cd taymna
cp .env.example .env
nano .env
```

First confirm 48100 and 48101 are free. See what's already listening:

```bash
sudo ss -tlnp | awk 'NR==1 || /LISTEN/' | sort -k4
```

If either appears in that list, pick other numbers in the 40000–60000 range
and use them in place of 48100/48101 everywhere below (they're only ever
reached from the proxy on the same machine, so the value is arbitrary).

Then set these (every variable is explained inline in the file):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | a random password (`openssl rand -hex 16`) |
| `DATABASE_URL` | must contain that same password |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | your dashboard login; only read on first boot |
| `BIND_ADDRESS` | `127.0.0.1` |
| `API_PORT` | `48100` |
| `WEB_PORT` | `48101` |
| `WEB_ORIGIN` | `https://taymna.example.com` |
| `NEXT_PUBLIC_API_URL` | `https://api.taymna.example.com` |
| `NEXT_PUBLIC_AGENT_SERVER_URL` | `https://api.taymna.example.com` |

`BIND_ADDRESS=127.0.0.1` keeps the two ports off the public interface;
`API_PORT`/`WEB_PORT` are only the host side (inside the containers the
services always listen on 3000). The two `NEXT_PUBLIC_*` values are baked
into the web image at build time -- changing them later means
`docker compose up -d --build`, not just a restart.

## 4. Start the stack

```bash
docker compose up -d --build
docker compose ps
```

The first build takes a few minutes. Wait until `taymna-postgres` and
`taymna-api` show `healthy`, then confirm from the VPS itself:

```bash
curl -s http://127.0.0.1:48100/health/ready                          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:48101/     # 200
```

If `docker compose up` fails with `Bind for 127.0.0.1:48100 failed: port is
already allocated`, that port is taken after all -- pick another, change
`.env`, run `docker compose up -d` again.

On first boot the `api` container applies the database migrations and
creates the admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## 5. Put a reverse proxy with TLS in front

Pick the one section that matches your server: **5a** Caddy on the host,
**5b** nginx on the host, **5c** nginx running as a Docker container.

### 5a. Caddy on the host

If Caddy isn't installed yet:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

**Add** these two site blocks to `/etc/caddy/Caddyfile`, alongside any sites
already in it (a Caddyfile is just a list of site blocks). On a fresh
install, replace the placeholder `:80` block with them:

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

Caddy requests certificates for both names on the first visit (needs the
DNS records live and port 80 open) and proxies WebSockets without any extra
configuration.

### 5b. nginx on the host

Ubuntu's nginx includes `/etc/nginx/conf.d/*.conf` inside the `http` block,
so three files there are all that's needed. WebSockets need the
`Upgrade`/`Connection` headers and `proxy_http_version 1.1`; the
`Connection` value comes from a `map`, which must be defined exactly
**once** in the whole config -- so it gets its own shared file rather than
living in each site's file. If one of your other sites already defines
`$connection_upgrade` (`grep -r connection_upgrade /etc/nginx/`), skip that
file and reuse the variable.

`/etc/nginx/conf.d/00-websocket-upgrade.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

`/etc/nginx/conf.d/taymna-web.conf`:

```nginx
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
```

`/etc/nginx/conf.d/taymna-api.conf`:

```nginx
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
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d taymna.example.com -d api.taymna.example.com
```

certbot rewrites both server blocks for HTTPS and installs a renewal timer.

### 5c. nginx running as a Docker container

Inside a container, `127.0.0.1` is the nginx container itself, not the host
-- `proxy_pass http://127.0.0.1:48100` would get a 502. Instead, put nginx
on Taymna's Docker network and proxy to the containers **by name**:
`taymna-web:3000` and `taymna-api:3000` (the compose file pins these names
and the network name `taymna_default`).

**Join the network.** In the compose file that runs nginx, add `taymna` to
the service's networks and declare it as external. With a typical setup
where the service is `webserver` on its own `cicd-network`:

```yaml
services:
  webserver:
    image: nginx
    container_name: webserver
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./conf/sites-available:/etc/nginx/conf.d
    networks:
      - cicd-network
      - taymna          # added
networks:
  cicd-network:
    driver: bridge
  taymna:               # added
    external: true
    name: taymna_default
```

Start Taymna first (step 4) so the network exists, then `docker compose up -d`
in the nginx project and confirm the names resolve from inside nginx:

```bash
docker exec webserver getent hosts taymna-api taymna-web
```

(Quick alternative that's lost when the nginx container is recreated:
`docker network connect taymna_default webserver`.)

**Config files** go on the host side of the volume that's mounted at
`/etc/nginx/conf.d` (`./conf/sites-available/` in the example above) --
files created with `docker exec` inside the container disappear on
recreate. The official `nginx` image includes `conf.d/*.conf` in the `http`
block, and its `nginx.conf` isn't mounted here, so the `map` goes in
`conf.d` too. Same three files as 5b, with two differences: the upstreams
are container names, and a `resolver` line makes nginx re-resolve them --
otherwise it caches the container IP at startup and serves 502s after every
`docker compose up -d --build` on the Taymna side until it's reloaded.

`conf.d/00-websocket-upgrade.conf` (skip if another site of yours already
defines `$connection_upgrade`):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

`conf.d/taymna-web.conf`:

```nginx
server {
    listen 80;
    server_name taymna.example.com;

    resolver 127.0.0.11 valid=10s;      # Docker's embedded DNS
    set $upstream http://taymna-web:3000;

    location / {
        proxy_pass $upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`conf.d/taymna-api.conf`:

```nginx
server {
    listen 80;
    server_name api.taymna.example.com;

    resolver 127.0.0.11 valid=10s;
    set $upstream http://taymna-api:3000;

    location / {
        proxy_pass $upstream;
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
docker exec webserver nginx -t && docker exec webserver nginx -s reload
```

**TLS:** `certbot --nginx` on the host doesn't apply to a containerised
nginx. Use whatever your existing sites use (a certbot/acme companion
container, certificates mounted into nginx, ...): give these two server
blocks the same `listen 443 ssl;` and `ssl_certificate`/`ssl_certificate_key`
lines as one of your working sites, and add the two hostnames to that
certificate setup.

### Verify (all layouts)

```bash
curl -s https://api.taymna.example.com/health/live                       # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://taymna.example.com/    # 200
```

## 6. First use

1. Open `https://taymna.example.com` and sign in with `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`.
2. On a phone, install it as an app: iOS Safari → Share → **Add to Home
   Screen**; Android Chrome → the install prompt or ⋮ → **Install app**.
   (Only offered over HTTPS -- one reason for step 5.)
3. **Add machine**, then run the install command it shows on that machine
   ([agent-install.md](agent-install.md)). It points agents at
   `https://api.taymna.example.com` automatically.

Machines enrolled earlier against a different address (a tunnel, a LAN IP)
need a fresh token and a re-enroll -- see "server URL changes" in
[agent-install.md](agent-install.md).

## Day-to-day operations

**Logs**

```bash
docker compose logs -f api             # or web, postgres (run in ~/taymna)
sudo journalctl -u caddy -f            # 5a
sudo tail -f /var/log/nginx/error.log  # 5b
docker logs -f webserver               # 5c
```

**Upgrade** (migrations are applied automatically on start):

```bash
cd ~/taymna && git pull && docker compose up -d --build
```

**Backup** -- everything is in the Postgres volume:

```bash
docker compose exec -T postgres pg_dump -U taymna taymna | gzip > "taymna-$(date +%F).sql.gz"
```

A nightly cron line for that (`crontab -e`; create `~/backups` first):

```
0 3 * * * cd $HOME/taymna && docker compose exec -T postgres pg_dump -U taymna taymna | gzip > $HOME/backups/taymna-$(date +\%F).sql.gz
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

- **Certificate errors** -- the DNS records don't resolve to this VPS yet,
  or port 80 is blocked (Let's Encrypt validates over HTTP).
  `sudo journalctl -u caddy -n 50` / `docker logs webserver` says which.
- **502 from the proxy** -- a container isn't up (`docker compose ps`,
  `docker compose logs api`); with 5c, also check the names resolve
  (`docker exec webserver getent hosts taymna-api`) and that the
  `resolver` line is present, or nginx is still holding a stale IP from
  before a rebuild (`docker exec webserver nginx -s reload`).
- **`unknown "connection_upgrade" variable` from `nginx -t`** -- the `map`
  file is missing (or lives outside the `http` context). `duplicate
  variable` means it's defined twice -- keep one.
- **Dashboard loads but every action fails / "Couldn't load machines"** --
  `WEB_ORIGIN` doesn't match the dashboard's real address (the API refuses
  cross-origin requests from anywhere else), or `NEXT_PUBLIC_API_URL` was
  changed without rebuilding the web image. Check `docker compose logs api`
  for CORS errors, fix `.env`, `docker compose up -d --build`.
- **Machines show Online, but sessions don't start/stop on them, or a
  machine flips offline every minute** -- WebSockets aren't getting
  through the proxy: missing `Upgrade`/`Connection` headers or
  `proxy_http_version 1.1` (5b/5c), or a short `proxy_read_timeout`.
- **A machine never shows Online** -- on that machine, the installer's
  output (or its log, see [agent-install.md](agent-install.md)) says
  whether it can't resolve/reach `api.taymna.example.com` or was rejected.
  From the VPS, `docker compose logs api | grep -i machine` shows
  authentication attempts.
- **Out of memory during `docker compose up --build`** -- add swap (step 1)
  or use a 2 GB VPS; the Next.js build is the only heavy step.
