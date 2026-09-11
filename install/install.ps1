<#
Taymna agent installer for Windows. Run in an elevated PowerShell
("Run as administrator"):

  irm https://raw.githubusercontent.com/jaylordibe/taymna/main/install/install.ps1 | iex

Downloads the latest release binary, installs it to C:\Program Files\Taymna,
registers it as a LocalSystem Windows service, enrolls the machine, and starts
it. Prompts for the server URL and an enrollment token, or reads them from
$env:TAYMNA_SERVER / $env:TAYMNA_TOKEN. To pass them as parameters instead:

  & ([scriptblock]::Create((irm <url>))) -Server https://taymna.example.com -Token <token>

Re-running upgrades the binary and keeps the existing enrollment unless a
token is given. -Reenroll skips the download and only re-enrolls (for a
changed server URL). -Version <tag> installs a specific release.
#>
param(
    [string]$Server = $env:TAYMNA_SERVER,
    [string]$Token = $env:TAYMNA_TOKEN,
    [string]$Version = $(if ($env:TAYMNA_VERSION) { $env:TAYMNA_VERSION } else { 'latest' }),
    [switch]$Reenroll
)

function Install-TaymnaAgent {
    param([string]$Server, [string]$Token, [string]$Version, [switch]$Reenroll)

    # Scoped to this function so an `irm | iex` run doesn't leave the
    # caller's session with a changed preference.
    $ErrorActionPreference = 'Stop'

    $Repo = 'jaylordibe/taymna'
    $Asset = 'taymna-agent-windows-x86_64.exe'
    $InstallDir = 'C:\Program Files\Taymna'
    $ExePath = Join-Path $InstallDir 'taymna-agent.exe'
    $StateDir = 'C:\ProgramData\Taymna'
    $ServiceName = 'TaymnaAgent'
    $RegKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"

    function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Start -> PowerShell -> right-click -> Run as administrator).'
    }

    # Windows PowerShell 5.1 defaults to TLS 1.0 for web requests; GitHub requires 1.2.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    function Stop-AgentService {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Stopped') {
            Write-Step "Stopping $ServiceName"
            Stop-Service -Name $ServiceName -Force
            $svc.WaitForStatus('Stopped', '00:00:30')
        }
        # A stray foreground `taymna-agent.exe run` (e.g. from a manual test)
        # would otherwise keep the exe locked and make the replace fail.
        Get-Process -Name taymna-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    $stateFile = Join-Path $StateDir 'state.json'
    $enrolled = (Test-Path $stateFile) -and ((Get-Content -Path $stateFile -Raw) -match '"machine_secret"')
    $needEnroll = $Reenroll -or [bool]$Token -or -not $enrolled
    if (-not $needEnroll -and $Server) {
        # Enrolled already, but for a different server than the one given
        # now: keeping the old enrollment would leave the agent trying the
        # wrong address forever, so treat this as a re-enroll (needs a token).
        $saved = (Get-Content -Path $stateFile -Raw | ConvertFrom-Json).credentials.server_url
        if ($saved.TrimEnd('/') -ne $Server.TrimEnd('/')) {
            Write-Step "Existing enrollment is for $saved, not $Server -- re-enrolling (a fresh token is required)"
            $needEnroll = $true
        }
    }

    # Prompt and validate first, so a wrong URL or token stops the run
    # before anything on the machine has been changed. Each check names the
    # specific mistake rather than leaving it to a raw HTTP error at the end.
    if ($needEnroll) {
        if (-not $Server) { $Server = Read-Host 'Server URL (e.g. https://taymna.example.com)' }
        if (-not $Token) { $Token = Read-Host 'Enrollment token (from the dashboard)' }
        if ($Server -notmatch '^https?://') { throw "The server URL must start with http:// or https:// (got: $Server)" }
        $Server = $Server.TrimEnd('/')
        Write-Step "Checking $Server"
        try {
            $health = Invoke-RestMethod -Uri "$Server/health/live" -TimeoutSec 10 -UseBasicParsing
        }
        catch {
            throw "Cannot reach $Server ($($_.Exception.Message))`n  - Is the Taymna API running, and reachable from this machine (tunnel up, firewall, VPN)?`n  - The URL must be the API address (the one agents connect to), not the web dashboard."
        }
        if (-not ($health -is [object] -and $health.status -eq 'ok')) {
            throw "$Server responded, but not like the Taymna API.`n  - Use the API address (e.g. https://host:3000), not the web dashboard (port 3001)."
        }
        if ($Token -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}$') {
            $shown = if ($Token.Length -gt 40) { $Token.Substring(0, 40) + '...' } else { $Token }
            throw "That doesn't look like an enrollment token (expected <uuid>.<secret>, got: $shown)`n  - Paste only the token from the dashboard's Installation command, not the whole command."
        }
    }

    if ($Reenroll) {
        if (-not (Test-Path $ExePath)) { throw "$ExePath is not installed yet -- run without -Reenroll first." }
        Stop-AgentService
    }
    else {
        $url = if ($Version -eq 'latest') {
            "https://github.com/$Repo/releases/latest/download/$Asset"
        }
        else {
            "https://github.com/$Repo/releases/download/$Version/$Asset"
        }
        Write-Step "Downloading $url"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("taymna-agent-" + [guid]::NewGuid() + ".exe")
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

        Stop-AgentService
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Move-Item -Path $tmp -Destination $ExePath -Force
        Unblock-File -Path $ExePath

        Write-Step 'Checking the binary'
        $versionOutput = & $ExePath --version
        if ($LASTEXITCODE -ne 0) {
            throw "taymna-agent.exe failed to run (exit code $LASTEXITCODE). See docs/agent-install.md, Windows troubleshooting."
        }
        Write-Host "    $versionOutput"

        Write-Step "Registering service $ServiceName"
        # The exe path must be quoted inside the service's command line: it
        # contains a space, and an unquoted path is split by the process.
        $binPath = "`"$ExePath`" run"
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            # Re-assert every property a previous (manual or failed) install
            # may have left wrong, rather than assuming the registration is fine.
            Set-ItemProperty -Path $RegKey -Name ImagePath -Value $binPath
            Set-Service -Name $ServiceName -StartupType Automatic
        }
        else {
            try {
                New-Service -Name $ServiceName -DisplayName 'Taymna Agent' -BinaryPathName $binPath -StartupType Automatic | Out-Null
            }
            catch {
                if ($_.Exception.Message -match 'marked for deletion') {
                    throw "A previous $ServiceName service is still pending removal (deleted while running). Reboot Windows, then re-run this installer."
                }
                throw
            }
        }
        & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
        # Services inherit services.exe's boot-time environment, so a
        # machine-wide variable wouldn't reach it until reboot; this
        # per-service value is applied by SCM on the next start.
        New-ItemProperty -Path $RegKey -Name Environment -PropertyType MultiString -Value @("TAYMNA_STATE_DIR=$StateDir") -Force | Out-Null
    }

    if ($needEnroll) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        Write-Step "Enrolling with $Server"
        # Same state directory the service uses (set above via the registry),
        # so the credentials written here are the ones the service reads.
        $env:TAYMNA_STATE_DIR = $StateDir
        & $ExePath enroll --server $Server --token $Token
        if ($LASTEXITCODE -ne 0) {
            throw "Enrollment failed (see the server's reason above).`n  - Tokens are single-use and expire 15 minutes after being issued.`n  - Get a fresh one from the machine's Installation command on the dashboard and re-run this installer."
        }
    }
    else {
        Write-Step 'Already enrolled -- keeping the existing enrollment (pass a token or -Reenroll to change it)'
    }

    Write-Step "Starting $ServiceName"
    # Remember where the log ends now, so verification only reads lines from
    # this start -- not a "connected" line left over from an earlier run.
    $log = Join-Path $StateDir 'agent.log'
    $logMark = if (Test-Path $log) { @(Get-Content -Path $log).Count } else { 0 }
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', '00:00:30')

    # Don't declare success on the strength of "the service started":
    # confirm the agent actually reached the server, and if it didn't, show
    # why. This is what catches a stale enrollment (revoked credential,
    # reset server, wrong address) that a plain start would sit on forever.
    $connected = $false
    $newLines = @()
    foreach ($i in 1..15) {
        Start-Sleep -Seconds 1
        if ((Get-Service -Name $ServiceName).Status -ne 'Running') {
            $newLines = if (Test-Path $log) { @(Get-Content -Path $log) | Select-Object -Skip $logMark } else { @() }
            $newLines | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
            throw "The service stopped right after starting (last log lines above, from $log). Fix the cause and re-run this installer."
        }
        $newLines = if (Test-Path $log) { @(Get-Content -Path $log) | Select-Object -Skip $logMark } else { @() }
        if ($newLines -match 'connected to Taymna server') { $connected = $true; break }
    }
    if (-not $connected) {
        $newLines | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
        throw "The service is running but did not connect within 15 seconds (last log lines above, from $log).`n  - An unauthorized/401 error means the saved enrollment is stale (credential revoked, server reset, wrong server): re-run with a fresh token.`n  - A connection error means the server URL isn't reachable from this machine."
    }
    Write-Step 'Connected to the server.'
    Write-Step 'Done. The machine should now show as Online on the dashboard.'
}

Install-TaymnaAgent -Server $Server -Token $Token -Version $Version -Reenroll:$Reenroll
