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

Run every command below in an **elevated** PowerShell ("Run as
administrator" -- the window title must say "Administrator: Windows
PowerShell"). A non-elevated shell fails `sc.exe create`/`start` with
"Access is denied" (error 5).

The Windows binary is self-contained (the C runtime is statically linked,
see `agent/.cargo/config.toml`), so no Visual C++ Redistributable is needed.
Sanity-check any freshly copied binary before registering it:

```powershell
& "C:\Program Files\Taymna\taymna-agent.exe" --version; "exit code: $LASTEXITCODE"
```

It must print the version and `exit code: 0`. An exit code of `-1073741515`
(STATUS_DLL_NOT_FOUND) with no output means a build older than v0.1.3, which
still depended on VCRUNTIME140.dll -- as a service that failure is completely
silent and shows up only as `sc.exe start` failing with error 1053.

Register the binary as a service (LocalSystem, required for both the
`WTSQueryUserToken`/`CreateProcessAsUserW` technique in
[enforcement.md](enforcement.md) and for `sc.exe`/SCM to manage it at all):

```powershell
mkdir "C:\Program Files\Taymna" -Force
Copy-Item ".\taymna-agent.exe" "C:\Program Files\Taymna\taymna-agent.exe"

New-Service -Name TaymnaAgent -BinaryPathName '"C:\Program Files\Taymna\taymna-agent.exe" run' -StartupType Automatic
sc.exe failure TaymnaAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000
sc.exe qc TaymnaAgent
```

The exe path **must be quoted inside** the service's binary path (note the
inner `"..."` in the `New-Service` line) because it contains a space. The
tempting `sc.exe create ... binPath= "C:\Program Files\...\taymna-agent.exe run"`
stores it *unquoted*: SCM still finds and launches the exe, but the process
then sees its own command line as `C:\Program`, `Files\Taymna\taymna-agent.exe`,
`run` -- the CLI parser rejects `Files\Taymna\...` as an unknown subcommand and
exits before ever reaching the Service Control Manager handshake. The only
symptom is a bare "1053: did not respond in a timely fashion" on start, with
no process and no log file. Confirm with `sc.exe qc`: `BINARY_PATH_NAME` must
show the path in quotes. To fix an already-registered service in place:

```powershell
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\TaymnaAgent" -Name ImagePath -Value '"C:\Program Files\Taymna\taymna-agent.exe" run'
```

The service (LocalSystem) and an interactive `enroll` run (your own admin
account) are different Windows accounts with different profile
directories, so they need `TAYMNA_STATE_DIR` to agree on a shared location
-- **don't** set it with `[Environment]::SetEnvironmentVariable(...,
"Machine")`: that only updates the registry, and a Windows service inherits
its environment from `services.exe`'s own process environment, captured at
boot -- it will *not* see a machine variable set after boot without a
reboot. Set it directly on the service's own registry key instead, which
SCM does apply immediately, no reboot needed:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\TaymnaAgent" `
  -Name "Environment" -PropertyType MultiString `
  -Value @("TAYMNA_STATE_DIR=C:\ProgramData\Taymna") -Force

$env:TAYMNA_STATE_DIR = "C:\ProgramData\Taymna"   # for this enroll command only
# The `&` (call operator) is required: PowerShell treats a *quoted* path as
# a plain string value, not something to execute, unless told to with `&`.
# (An unquoted/`.\`-relative path like `.\taymna-agent.exe` doesn't need it
# -- only this case, where the path must be quoted because it contains a
# space ("Program Files").)
& "C:\Program Files\Taymna\taymna-agent.exe" enroll --server https://taymna.example.com --token <token>

sc.exe start TaymnaAgent
```

A Windows service has no attached console, so on this platform only, the
agent logs to `<TAYMNA_STATE_DIR>\agent.log` (e.g.
`C:\ProgramData\Taymna\agent.log`) instead of stdout -- check there first
if the service starts but the machine never shows as online.

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
