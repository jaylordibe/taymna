#!/usr/bin/env bash
# Taymna agent installer for Linux (systemd) and macOS (launchd).
#
#   curl -fsSL https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.sh | sudo bash
#
# Downloads the latest release binary, installs it as a root system service,
# enrolls the machine, and starts it. Prompts for the server URL and an
# enrollment token, or reads them from TAYMNA_SERVER / TAYMNA_TOKEN:
#
#   curl -fsSL <url> | sudo TAYMNA_SERVER=https://taymna.example.com TAYMNA_TOKEN=... bash
#
# Re-running upgrades the binary and keeps the existing enrollment unless a
# token is given. `--reenroll` skips the download and only re-enrolls (for a
# changed server URL). Options (when run from a file): --server, --token,
# --version <tag>, --reenroll.
set -euo pipefail

REPO="jaylordibe/taymna"
INSTALL_PATH="/usr/local/bin/taymna-agent"
STATE_DIR="/var/lib/taymna-agent"
SERVER="${TAYMNA_SERVER:-}"
TOKEN="${TAYMNA_TOKEN:-}"
VERSION="${TAYMNA_VERSION:-latest}"
REENROLL=0

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --reenroll) REENROLL=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root, e.g.: curl -fsSL <url> | sudo bash"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Linux:x86_64) ASSET="taymna-agent-linux-x86_64" ;;
  Darwin:arm64) ASSET="taymna-agent-macos-arm64" ;;
  *) die "no prebuilt binary for $OS/$ARCH -- see docs/agent-install.md to build from source" ;;
esac

# When piped into bash, stdin is the script itself; prompts must use the
# terminal directly. With no terminal at all, require the env vars.
prompt() {
  local var="$1" text="$2" value=""
  if ! { read -r -p "$text: " value < /dev/tty; } 2>/dev/null; then
    die "no terminal to prompt on -- set TAYMNA_SERVER and TAYMNA_TOKEN"
  fi
  [ -n "$value" ] || die "$text is required"
  printf -v "$var" '%s' "$value"
}

stop_service() {
  case "$OS" in
    Linux) systemctl stop taymna-agent 2>/dev/null || true ;;
    Darwin) launchctl bootout system/dev.taymna.agent 2>/dev/null || true ;;
  esac
}

install_binary() {
  local url tmp
  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/$REPO/releases/latest/download/$ASSET"
  else
    url="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  fi
  log "Downloading $url"
  tmp="$(mktemp)"
  # Expanded now, deliberately: the trap runs at exit, outside this
  # function's scope, where the local variable no longer exists.
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" EXIT
  curl -fsSL -o "$tmp" "$url" || die "download failed -- check the release exists and the machine has internet access"
  stop_service
  mkdir -p "$(dirname "$INSTALL_PATH")"
  install -m 755 "$tmp" "$INSTALL_PATH"
  if [ "$OS" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
  fi
  # Must be an explicit check: a failure inside "$(...)" in a log line would
  # not stop the script, and a binary that can't even print its version
  # would otherwise be registered as a service that silently never starts.
  local version
  version="$("$INSTALL_PATH" --version)" || die "$INSTALL_PATH does not run on this system (see the output above)"
  log "Installed $INSTALL_PATH ($version)"
}

write_service_definition() {
  case "$OS" in
    Linux)
      log "Writing /etc/systemd/system/taymna-agent.service"
      cat > /etc/systemd/system/taymna-agent.service <<EOF
[Unit]
Description=Taymna agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_PATH run
StateDirectory=taymna-agent
Environment=TAYMNA_STATE_DIR=$STATE_DIR
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
      ;;
    Darwin)
      log "Writing /Library/LaunchDaemons/dev.taymna.agent.plist"
      cat > /Library/LaunchDaemons/dev.taymna.agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.taymna.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_PATH</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAYMNA_STATE_DIR</key><string>$STATE_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/taymna-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/taymna-agent.log</string>
</dict>
</plist>
EOF
      chown root:wheel /Library/LaunchDaemons/dev.taymna.agent.plist
      chmod 644 /Library/LaunchDaemons/dev.taymna.agent.plist
      ;;
  esac
}

# Fail before touching anything if the URL or token is obviously wrong --
# each check names the specific mistake rather than leaving it to a raw
# HTTP error at the very end.
validate_inputs() {
  local body
  case "$SERVER" in
    http://*|https://*) ;;
    *) die "server URL must start with http:// or https:// (got: $SERVER)" ;;
  esac
  SERVER="${SERVER%/}"

  log "Checking $SERVER"
  if ! body="$(curl -fsS --max-time 10 "$SERVER/health/live" 2>&1)"; then
    die "cannot reach $SERVER ($body)
  - Is the Taymna API running, and reachable from this machine (tunnel up, firewall, VPN)?
  - The URL must be the API address (the one agents connect to), not the web dashboard."
  fi
  case "$body" in
    *'"status":"ok"'*) ;;
    *) die "$SERVER responded, but not like the Taymna API (got: ${body:0:80})
  - Use the API address (e.g. https://host:3000), not the web dashboard (port 3001)." ;;
  esac

  if ! [[ "$TOKEN" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}$ ]]; then
    die "that doesn't look like an enrollment token (expected <uuid>.<secret>, got: ${TOKEN:0:40}...)
  - Paste only the token from the dashboard's Installation command, not the whole command."
  fi
}

collect_inputs() {
  [ -n "$SERVER" ] || prompt SERVER "Server URL (e.g. https://taymna.example.com)"
  [ -n "$TOKEN" ] || prompt TOKEN "Enrollment token (from the dashboard)"
  validate_inputs
}

enroll() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  log "Enrolling with $SERVER"
  if ! TAYMNA_STATE_DIR="$STATE_DIR" "$INSTALL_PATH" enroll --server "$SERVER" --token "$TOKEN"; then
    die "enrollment failed (see the server's reason above)
  - Tokens are single-use and expire 15 minutes after being issued.
  - Get a fresh one from the machine's Installation command on the dashboard and re-run this installer."
  fi
}

start_service() {
  log "Starting the service"
  # Remember where the logs end now, so verification only reads lines from
  # this start -- not a "connected" line left over from an earlier run.
  START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
  MAC_LOG_LINES="$(wc -l < /var/log/taymna-agent.log 2>/dev/null || echo 0)"
  case "$OS" in
    Linux)
      systemctl enable --now taymna-agent
      sleep 2
      systemctl --no-pager --lines=5 status taymna-agent || true
      ;;
    Darwin)
      launchctl bootstrap system /Library/LaunchDaemons/dev.taymna.agent.plist
      sleep 2
      launchctl print system/dev.taymna.agent 2>/dev/null | sed -n '1,6p' || true
      ;;
  esac
}

# Log lines written since start_service() ran (empty if none are readable).
recent_logs() {
  case "$OS" in
    Linux)
      if command -v journalctl >/dev/null 2>&1; then
        journalctl -u taymna-agent --since "$START_TS" --no-pager 2>/dev/null || true
      fi
      ;;
    Darwin) tail -n "+$((MAC_LOG_LINES + 1))" /var/log/taymna-agent.log 2>/dev/null || true ;;
  esac
}

# Don't declare success on the strength of "the service started": confirm
# the agent actually reached the server, and if it didn't, show why. This
# is what catches a stale enrollment (revoked credential, reset server,
# wrong address) that a plain start would sit on forever.
verify_running() {
  local logs=""
  for _ in $(seq 1 15); do
    if [ "$OS" = "Linux" ] && command -v journalctl >/dev/null 2>&1 && ! systemctl is-active --quiet taymna-agent; then
      recent_logs | tail -n 15 >&2
      die "the service is not running (last log lines above) -- fix the cause and re-run this installer"
    fi
    logs="$(recent_logs)"
    case "$logs" in
      *"connected to Taymna server"*) log "Connected to the server."; return 0 ;;
    esac
    sleep 1
  done
  if [ -z "$logs" ]; then
    log "Could not confirm the connection (no logs readable here) -- the dashboard should show this machine Online within a minute"
    return 0
  fi
  printf '%s\n' "$logs" | tail -n 15 >&2
  die "the service is running but did not connect within 15 seconds (last log lines above)
  - An unauthorized/401 error means the saved enrollment is stale (credential revoked, server reset, wrong server): re-run with a fresh token.
  - A connection error means the server URL isn't reachable from this machine."
}

NEED_ENROLL=0
if [ "$REENROLL" -eq 1 ] || [ -n "$TOKEN" ] || ! grep -qs '"machine_secret"' "$STATE_DIR/state.json"; then
  NEED_ENROLL=1
elif [ -n "$SERVER" ]; then
  # Enrolled already, but for a different server than the one given now:
  # keeping the old enrollment would leave the agent trying the wrong
  # address forever, so treat this as a re-enroll (which needs a token).
  SAVED_SERVER="$(sed -n 's/.*"server_url": *"\([^"]*\)".*/\1/p' "$STATE_DIR/state.json" | head -n1)"
  if [ "${SAVED_SERVER%/}" != "${SERVER%/}" ]; then
    log "Existing enrollment is for $SAVED_SERVER, not $SERVER -- re-enrolling (a fresh token is required)"
    NEED_ENROLL=1
  fi
fi
# Prompt and validate first, so a wrong URL or token stops the run before
# anything on the machine has been changed.
if [ "$NEED_ENROLL" -eq 1 ]; then
  collect_inputs
fi

if [ "$REENROLL" -eq 1 ]; then
  [ -x "$INSTALL_PATH" ] || die "$INSTALL_PATH is not installed yet -- run without --reenroll first"
  stop_service
  enroll
else
  install_binary
  write_service_definition
  if [ "$NEED_ENROLL" -eq 1 ]; then
    enroll
  else
    log "Already enrolled -- keeping the existing enrollment (pass a token or --reenroll to change it)"
  fi
fi

start_service
verify_running

log "Done. The machine should now show as Online on the dashboard."
case "$OS" in
  Linux) log "Logs: journalctl -u taymna-agent -f" ;;
  Darwin)
    log "Logs: tail -f /var/log/taymna-agent.log"
    log "Required once: System Settings -> Privacy & Security -> Accessibility -> allow taymna-agent (locking fails until then)"
    ;;
esac
