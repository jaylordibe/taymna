# Agent installation

The agent is a single binary (`taymna-agent`). Development never requires
installing a system service:

```bash
cd agent
cargo run -- enroll --server https://taymna.example.com --token <token>
cargo run          # or: cargo run -- run
```

`cargo run` (no args) is equivalent to `cargo run -- run` and uses a
user-writable state directory by default (resolved via the `directories`
crate, or overridden with `TAYMNA_STATE_DIR`).

For installing on a machine you're controlling, you don't need a clone or a
Rust toolchain there: grab the prebuilt binary for that OS from the
[Releases page](https://github.com/jaylordibe/taymna/releases) (built by
`.github/workflows/release.yml` on every version tag). Building it yourself
instead: `cargo build --release` produces `target/release/taymna-agent`.

For always-on use, install it as the OS's native service so it starts on
boot and restarts if it crashes. No installer/updater beyond these
definitions exists in V1 -- copy the binary and unit/plist file, then use
the OS's own service manager.

## Linux (systemd)

```ini
# /etc/systemd/system/taymna-agent.service
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

`StateDirectory=` has systemd create `/var/lib/taymna-agent` with the
correct ownership/permissions before the service starts. Root is required
for `loginctl lock-sessions` to affect other users' sessions -- see
[enforcement.md](enforcement.md).

```bash
sudo cp taymna-agent /usr/local/bin/
sudo cp taymna-agent.service /etc/systemd/system/
sudo taymna-agent enroll --server https://taymna.example.com --token <token>  # as root, so it writes to /var/lib/taymna-agent
sudo systemctl enable --now taymna-agent
```

## Windows (Windows Service)

Register the binary as a service (LocalSystem, required for the
`WTSQueryUserToken`/`CreateProcessAsUserW` technique in
[enforcement.md](enforcement.md)):

```powershell
sc.exe create TaymnaAgent binPath= "C:\Program Files\Taymna\taymna-agent.exe run" start= auto
sc.exe failure TaymnaAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000
```

Enroll once before starting the service (run as Administrator so it writes
to the same state directory the service will use, e.g. via
`TAYMNA_STATE_DIR` set as a system environment variable pointing at
`C:\ProgramData\Taymna`):

```powershell
"C:\Program Files\Taymna\taymna-agent.exe" enroll --server https://taymna.example.com --token <token>
sc.exe start TaymnaAgent
```

## macOS (launchd)

```xml
<!-- /Library/LaunchDaemons/dev.taymna.agent.plist -->
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
</dict>
</plist>
```

```bash
sudo cp taymna-agent /usr/local/bin/
sudo mkdir -p /var/lib/taymna-agent
sudo TAYMNA_STATE_DIR=/var/lib/taymna-agent taymna-agent enroll --server https://taymna.example.com --token <token>
sudo cp dev.taymna.agent.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.taymna.agent.plist
```

**Required manual step:** grant the daemon (or its running process)
Accessibility permission in System Settings -> Privacy & Security ->
Accessibility -- macOS will not let this be granted silently, and locking
will fail (logged, retried) until it's done. See
[enforcement.md](enforcement.md) for why this is needed.
