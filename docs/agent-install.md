# Agent installation

The agent is a single binary. Installing it on a machine you want to
control is: download the prebuilt file for that OS, put it in place, register
it as a system service, enroll it once with a token from the dashboard, and
start it. The install scripts below do all of that in one command; the manual
steps further down are the same procedure spelled out, for reference or for
doing it by hand.

## Quick install (one command)

First get an enrollment token: in the dashboard, add the machine (or click
**Installation command** on an existing one). The script asks for the server
URL (the address your agents reach the API at, e.g.
`https://taymna.example.com`) and that token.

**Windows** -- in PowerShell opened with "Run as administrator":

```powershell
irm https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.ps1 | iex
```

**Linux (systemd) or macOS (Apple Silicon)**:

```bash
curl -fsSL https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.sh | sudo bash
```

Each script first checks the inputs -- that the URL answers as the Taymna
API at `/health/live` (not, say, the web dashboard's address) and that the
token has the expected `<uuid>.<secret>` shape -- and stops with a specific
message before changing anything if either is wrong. It then downloads the
latest release, installs the binary, registers the system service (with the
state directory, restart policy, and -- on Windows -- the quoted path and
per-service environment described below), enrolls, starts the service, and
prints its status and last log lines. If the server rejects the token
(single-use, expires 15 minutes after being issued), it says so and tells
you to get a fresh one and re-run.

Non-interactive use (several machines, or no terminal to prompt on): set
`TAYMNA_SERVER` and `TAYMNA_TOKEN` in the environment instead --
`sudo TAYMNA_SERVER=https://... TAYMNA_TOKEN=... bash` on Linux/macOS, or
`$env:TAYMNA_SERVER = '...'; $env:TAYMNA_TOKEN = '...'` before the `irm`
line on Windows. `TAYMNA_VERSION=v0.1.3` pins a release.

Re-running is always safe and is the way to repair a broken or half-finished
install: every step re-asserts its result (binary replaced, service
definition rewritten, startup type, quoted path and per-service environment
re-applied, stray agent processes stopped), and the script only reports
success after seeing the agent's own "connected to Taymna server" log line
-- if the service starts but can't connect (stale credential after a server
reset, wrong address, unreachable server), it shows the last log lines and
says which of those it looks like. Re-running the same command later
**upgrades** the binary and keeps the existing enrollment; if you pass a
different `TAYMNA_SERVER` than the one it was enrolled with, it notices and
requires a fresh token. If the **server URL changes** (new tunnel address,
moved to a VPS), get a fresh token and re-enroll without re-downloading:

```powershell
$env:TAYMNA_TOKEN = '<token>'; $env:TAYMNA_SERVER = 'https://new-address'; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.ps1))) -Reenroll
```

```bash
curl -fsSL https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.sh | sudo TAYMNA_SERVER=https://new-address TAYMNA_TOKEN=<token> bash -s -- --reenroll
```

These are ordinary `curl | bash` / `irm | iex` installers: you're running a
script fetched from this repository as root/Administrator. Both scripts are
short and live at stable URLs (`install/install.sh`, `install/install.ps1`)
if you'd rather read them first or run them from a local copy.

The macOS step that can't be scripted: after installing, grant the agent
Accessibility permission (System Settings -> Privacy & Security ->
Accessibility) or locking will fail until you do.

## Versions, upgrades and rollback

**The git tag is the version.** Pushing `v0.2.0` builds the agent for all
three platforms and publishes a GitHub Release under that tag; the version
is stamped into the binary from the tag itself, so there is no second copy
in the repository to remember to bump. `agent/Cargo.toml` deliberately
stays at `0.0.0-dev`, which is exactly what a locally built binary should
report: it didn't come from a release.

That makes `--version` a real answer rather than a constant:

```bash
taymna-agent --version          # e.g. "taymna-agent 0.2.0"
```

Run it on a machine after upgrading to confirm the new binary actually
landed. On Windows: `& 'C:\Program Files\Taymna\taymna-agent.exe' --version`.

To **upgrade**, re-run the installer — it keeps the existing enrollment, so
no token is needed. To **roll back** (or pin), name the release:

```bash
curl -fsSL https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.sh | sudo bash -s -- --version v0.1.3
```

```powershell
$env:TAYMNA_VERSION = 'v0.1.3'; irm https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.ps1 | iex
```

Releases are never deleted, which is what makes that rollback work: every
tag stays a working download URL for machines already pinned to it, and
`releases/latest/download/...` — the URL both installers use by default —
always points at the newest one.

## 1. Get the binary

Download the file for the target OS from the
[Releases page](https://github.com/jaylordibe/taymna/releases) (built by
`.github/workflows/release.yml` on every version tag). The files are named:

| OS | Release file | Installed as |
|---|---|---|
| Windows (x86-64) | `taymna-agent-windows-x86_64.exe` | `C:\Program Files\Taymna\taymna-agent.exe` |
| Linux (x86-64, any distribution -- statically linked) | `taymna-agent-linux-x86_64` | `/usr/local/bin/taymna-agent` |
| macOS (Apple Silicon) | `taymna-agent-macos-arm64` | `/usr/local/bin/taymna-agent` |

The steps below assume the download landed in your Downloads folder; adjust
the source path if not. Every command uses absolute paths, so it does not
matter which directory your shell is in.

Building it yourself instead (needs a Rust toolchain): `cargo build
--release` in `agent/` produces `agent/target/release/taymna-agent[.exe]`.

## 2. Get an enrollment token

In the dashboard, add the machine (or click **Installation command** on an
existing one). The token is single-use and expires in 15 minutes, so do this
right before the enroll step. The `--server` value is the URL your agents
use to reach the API (e.g. `https://taymna.example.com`, or a tunnel URL) --
not `localhost`, unless the server really is on the same machine.

## Windows

Open PowerShell **as Administrator** (Start -> type "PowerShell" ->
right-click -> Run as administrator). The window title must say
"Administrator: Windows PowerShell"; a normal shell fails the service
commands with "Access is denied" (error 5). Paste one line at a time.

**Install the binary.** This creates the folder and renames the download:

```powershell
mkdir "C:\Program Files\Taymna" -Force
Copy-Item "$env:USERPROFILE\Downloads\taymna-agent-windows-x86_64.exe" "C:\Program Files\Taymna\taymna-agent.exe" -Force
```

**Check it runs.** Must print the version and `exit code: 0`:

```powershell
& "C:\Program Files\Taymna\taymna-agent.exe" --version; "exit code: $LASTEXITCODE"
```

**Register the service** (LocalSystem, required both for the lock technique
in [enforcement.md](enforcement.md) and for Windows to manage it at all).
The third line prints the config; `BINARY_PATH_NAME` must show the exe path
in quotes:

```powershell
New-Service -Name TaymnaAgent -BinaryPathName '"C:\Program Files\Taymna\taymna-agent.exe" run' -StartupType Automatic
sc.exe failure TaymnaAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000
sc.exe qc TaymnaAgent
```

**Give the service its state directory.** This is set on the service's own
registry key, which Windows applies the next time the service starts:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\TaymnaAgent" -Name "Environment" -PropertyType MultiString -Value @("TAYMNA_STATE_DIR=C:\ProgramData\Taymna") -Force
```

**Enroll**, substituting your server URL and the token from step 2. Must
print `Enrolled successfully as machine ...`:

```powershell
$env:TAYMNA_STATE_DIR = "C:\ProgramData\Taymna"; & "C:\Program Files\Taymna\taymna-agent.exe" enroll --server https://taymna.example.com --token <token>
```

**Start it and verify:**

```powershell
sc.exe start TaymnaAgent
sc.exe query TaymnaAgent
Get-Content "C:\ProgramData\Taymna\agent.log" -Tail 20
```

`STATE` should be `4 RUNNING`, the log should end with `connected to Taymna
server`, and the machine shows **Online** on the dashboard. With no active
session the screen locks immediately and re-locks within ~2 seconds of
signing in; starting a session from the dashboard makes it usable.

### Why the Windows steps look the way they do

- **Quoted path inside the service config.** The exe lives under `Program
  Files` (a space). `New-Service` with the inner `"..."` stores it quoted.
  The tempting `sc.exe create ... binPath= "C:\Program Files\...\taymna-agent.exe run"`
  stores it *unquoted* (the classic "unquoted service path" pitfall): the
  process's own command line then splits on the space and the CLI parser
  would reject `Files\Taymna\...` as an unknown subcommand and exit before
  reaching the Service Control Manager. To fix an already-registered
  service in place:
  `Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\TaymnaAgent" -Name ImagePath -Value '"C:\Program Files\Taymna\taymna-agent.exe" run'`
- **`&` before the quoted exe path.** PowerShell treats a quoted path as a
  string value, not a command, unless invoked with the call operator.
- **State directory via the registry, not a machine variable.** The service
  runs as LocalSystem; your interactive `enroll` runs as your admin account.
  Different accounts, different profile folders -- `TAYMNA_STATE_DIR` is
  what makes them agree. Setting it with
  `[Environment]::SetEnvironmentVariable(..., "Machine")` does not reach a
  service until reboot (services inherit `services.exe`'s boot-time
  environment); the per-service `Environment` registry value is applied
  immediately. The `$env:TAYMNA_STATE_DIR = ...;` prefix on the enroll line
  applies it to that one interactive command.
- **Self-contained binary.** The C runtime is statically linked
  (`agent/.cargo/config.toml`), so no Visual C++ Redistributable is needed.
- **Logs.** A Windows service has no console, so on this platform the agent
  writes `agent.log` in the state directory instead of stdout, plus
  `panic.log` / `service_dispatch.log` if it fails during startup.

### Windows troubleshooting

- `sc.exe start` fails with **1053** ("did not respond in a timely
  fashion") and nothing else: the process died before it could talk to
  Windows. Run the `--version` check. Exit code `-1073741515`
  (STATUS_DLL_NOT_FOUND) with no output means a build older than v0.1.3;
  `-1073741701` means a wrong-architecture binary. If `--version` is fine,
  check `sc.exe qc` for the quoted path, then the log files above.
- Service runs but the machine never shows online: read
  `C:\ProgramData\Taymna\agent.log`. "not enrolled yet" means the enroll
  step wrote somewhere else -- re-run it exactly as shown, with the
  `$env:TAYMNA_STATE_DIR` prefix.
- **The server URL changed** (new tunnel address, moved to a VPS): get a
  fresh token, then `sc.exe stop TaymnaAgent`, run the enroll line with the
  new `--server`, `sc.exe start TaymnaAgent`. The agent reads the URL from
  its saved state at startup, so a restart is required.

## Linux (systemd)

Run these as a user with `sudo`. Root is required for `loginctl
lock-sessions` to affect other users' sessions -- see
[enforcement.md](enforcement.md). For expiry warnings to reach the desktop,
`notify-send` (the `libnotify-bin` / `libnotify` package) must be installed
alongside a running notification daemon; without it the agent logs a warning
each time and still locks on time -- see
[expiry-warnings.md](expiry-warnings.md).

**Install the binary:**

```bash
sudo install -m 755 ~/Downloads/taymna-agent-linux-x86_64 /usr/local/bin/taymna-agent
taymna-agent --version
```

**Create the unit file** at `/etc/systemd/system/taymna-agent.service`
(e.g. `sudo nano /etc/systemd/system/taymna-agent.service`):

```ini
[Unit]
Description=Taymna agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/taymna-agent run
StateDirectory=taymna-agent
Environment=TAYMNA_STATE_DIR=/var/lib/taymna-agent
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

`StateDirectory=` has systemd create `/var/lib/taymna-agent` with the right
ownership before the service starts.

**Enroll and start.** The enroll runs as root with the same state directory
the service uses, so both see the same credentials:

```bash
sudo mkdir -p /var/lib/taymna-agent
sudo TAYMNA_STATE_DIR=/var/lib/taymna-agent taymna-agent enroll --server https://taymna.example.com --token <token>
sudo systemctl daemon-reload
sudo systemctl enable --now taymna-agent
systemctl status taymna-agent
```

Logs: `journalctl -u taymna-agent -f`. If the server URL changes: fresh
token, `sudo systemctl stop taymna-agent`, re-run the enroll line, `sudo
systemctl start taymna-agent`.

## macOS (launchd)

The released binary is for Apple Silicon. Run these in Terminal as an
administrator user.

**Install the binary:**

```bash
sudo install -m 755 ~/Downloads/taymna-agent-macos-arm64 /usr/local/bin/taymna-agent
taymna-agent --version
```

macOS may quarantine a downloaded binary; if `--version` is blocked, run
`sudo xattr -d com.apple.quarantine /usr/local/bin/taymna-agent` and retry.

**Create the launchd plist** at `/Library/LaunchDaemons/dev.taymna.agent.plist`
(e.g. `sudo nano /Library/LaunchDaemons/dev.taymna.agent.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.taymna.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/taymna-agent</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAYMNA_STATE_DIR</key><string>/var/lib/taymna-agent</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/taymna-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/taymna-agent.log</string>
</dict>
</plist>
```

Without the two `Standard*Path` keys launchd discards the agent's output and
a failure is invisible; with them, logs are in `/var/log/taymna-agent.log`.

**Enroll and start:**

```bash
sudo mkdir -p /var/lib/taymna-agent
sudo TAYMNA_STATE_DIR=/var/lib/taymna-agent taymna-agent enroll --server https://taymna.example.com --token <token>
sudo chown root:wheel /Library/LaunchDaemons/dev.taymna.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.taymna.agent.plist
sudo launchctl print system/dev.taymna.agent | head
```

**Required manual step:** grant the daemon Accessibility permission in
System Settings -> Privacy & Security -> Accessibility. macOS will not let
this be granted silently, and locking fails (logged, retried) until it's
done -- see [enforcement.md](enforcement.md).

If the server URL changes: fresh token, `sudo launchctl bootout
system/dev.taymna.agent`, re-run the enroll line, then the `bootstrap`
command again.

## Development

None of the above is needed to work on the agent itself:

```bash
cd agent
cargo run -- enroll --server https://taymna.example.com --token <token>
cargo run          # or: cargo run -- run
```

`cargo run` (no args) is equivalent to `cargo run -- run` and uses a
user-writable state directory by default (resolved via the `directories`
crate, or overridden with `TAYMNA_STATE_DIR`).
