<#
.SYNOPSIS
  Stages a 72-hour soak on HQ-PROTO-MINI-2 and starts the five tasks.

.DESCRIPTION
  The counterpart to soak-teardown.ps1, and the piece the first run never wrote
  down: docs/soak-run.md could tell you how to watch a run and how to end one,
  but not how to begin one, so the second run had to reconstruct the task
  definitions from docs/validation.md. Both halves are in the repo now.

  Expects the stage to be populated already (scripts/soak-stage.sh does that from
  the Mac): the build zip, soak-config.json, the sampler, and the mock server
  with its pages. This script expands the build, writes the wrappers, registers
  the tasks and starts them.

  Everything here is a Scheduled Task with an InteractiveToken principal, which
  is the only way into console session 1 where the display is. Not an SSH child:
  Windows OpenSSH kills the whole process tree when the session ends, a lesson
  this fleet learned the hard way. Every task action is a wrapper .cmd, because
  environment does not propagate through `schtasks /run` and the app is
  configured by WALLWRIGHT_CONFIG.

  Two Task Scheduler defaults would each have quietly ruined a run:
  ExecutionTimeLimit defaults to PT72H and would kill a 72-hour soak at exactly
  hour 72, so it is PT0S; and Priority defaults to 7, which is below-normal CPU
  and low I/O, and would distort both rendering and the memory being measured, so
  it is 4.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\proto\wallwright-soak\soak-setup.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ...\soak-setup.ps1 -PreflightOnly
#>
[CmdletBinding()]
param(
  [string]$Stage = 'C:\Users\proto\wallwright-soak',
  [string]$Zip = '',
  [int]$Hours = 72,
  [string]$Label = 'mini2',
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "  [FAIL] $t" -ForegroundColor Red; exit 1 }

$out = Join-Path $Stage 'out'
$appDir = Join-Path $Stage 'app'
$profileDir = Join-Path $env:APPDATA 'Wallwright'
$configFile = Join-Path $Stage 'soak-config.json'

Section 'Pre-flight'

# Refusing to start on a dirty machine is the whole point of a pre-flight. A
# leftover profile carries a previous run's window state and, worse, teardown
# would then delete something that was not ours to delete.
if (Test-Path $profileDir) { Die "$profileDir already exists. Teardown did not finish, or this machine has a real Wallwright profile. Resolve by hand." }
Ok 'no existing Wallwright profile: teardown is clean and this machine is not a Wallwright user'

foreach ($f in @($configFile, (Join-Path $Stage 'soak.js'), (Join-Path $Stage 'soak-stats.js'), (Join-Path $Stage 'mock-server.js'))) {
  if (-not (Test-Path $f)) { Die "missing from the stage: $f. Run scripts/soak-stage.sh from the Mac first." }
}
foreach ($p in @('soak-static.html', 'soak-heavy.html')) {
  if (-not (Test-Path (Join-Path $Stage "mock\$p"))) { Die "missing panel page: mock\$p" }
}
Ok 'sampler, mock server, both local panel pages and the config are staged'

if (-not $Zip) {
  $found = @(Get-ChildItem -Path $Stage -Filter '*.zip' | Where-Object { $_.Name -notlike 'results*' })
  if ($found.Count -ne 1) { Die "expected exactly one build zip in $Stage, found $($found.Count). Pass -Zip." }
  $Zip = $found[0].FullName
}
Ok "build zip: $(Split-Path -Leaf $Zip)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'node is not on PATH: the sampler and the mock server both need it' }
Ok "node $(& node --version)"

# A 72-hour run writes roughly 4300 sampler rows and 144 half-size grabs. Not
# large, but a full disk halfway through is an invalidated run rather than an
# inconvenience.
$free = [math]::Round((Get-PSDrive -Name C).Free / 1GB, 1)
if ($free -lt 5) { Die "only ${free}GB free on C:. A run needs headroom for grabs and the app profile." }
Ok "${free}GB free on C:"

$mem = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
Ok "${mem}GB physical memory free at T0"

foreach ($t in 'FCATWallLauncher', 'FCATSoakSampler') {
  if (-not (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) {
    Warn "$t is not registered here: nothing to disable, and teardown will say the same"
  }
}

$stale = @(Get-ScheduledTask -TaskName 'Soak*' -ErrorAction SilentlyContinue)
if ($stale.Count -gt 0) { Die "Soak* tasks already registered: $($stale.TaskName -join ', '). Run soak-teardown.ps1 first." }
Ok 'no stale Soak* task'

if ($PreflightOnly) { Section 'Pre-flight only: stopping here, nothing was changed'; exit 0 }

Section 'Expanding the build'
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $appDir -Force
$exe = Get-ChildItem -Path $appDir -Filter 'Wallwright.exe' -Recurse | Select-Object -First 1
if (-not $exe) { Die "no Wallwright.exe inside $Zip" }
Ok "app: $($exe.FullName)"

# The audit added an assertion that src/dev never ships. Worth confirming on the
# artifact itself rather than trusting the packager, because a soak that
# accidentally ran a dev build would be measuring the wrong program.
if (Test-Path (Join-Path $exe.DirectoryName 'resources\app.asar')) { Ok 'packaged as app.asar' }
else { Warn 'no app.asar next to the exe: this may be an unpacked build' }

New-Item -ItemType Directory -Force -Path $out, (Join-Path $out 'shots') | Out-Null

Section 'Writing the task wrappers'
# One .cmd per task. `start ""` on the app only: PowerShell does not block on a
# GUI app anyway, and the app must outlive the wrapper. The three long-running
# console jobs must NOT be started detached, or their task reports completed and
# there is nothing left to `schtasks /end`.
$wrappers = @{
  'run-mock.cmd'    = "@echo off`r`nset WALLWRIGHT_MOCK_PORT=8787`r`ncd /d `"$Stage`"`r`nnode mock-server.js`r`n"
  'run-wall.cmd'    = "@echo off`r`nset WALLWRIGHT_CONFIG=$configFile`r`nstart `"`" `"$($exe.FullName)`"`r`n"
  'run-sampler.cmd' = "@echo off`r`ncd /d `"$Stage`"`r`nnode soak.js --port 8901 --out `"$out`" --hours $Hours --label $Label --threshold 15`r`n"
  'run-proc.cmd'    = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Stage\soak-proc.ps1`" -Out `"$out`"`r`n"
  'run-grab.cmd'    = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Stage\soak-grab.ps1`" -Out `"$out\shots`"`r`n"
}
foreach ($name in $wrappers.Keys) {
  [System.IO.File]::WriteAllText((Join-Path $Stage $name), $wrappers[$name], [System.Text.Encoding]::ASCII)
  Ok "wrote $name"
}

Section 'Registering the tasks'
function Register-SoakTask {
  param([string]$Name, [string]$Cmd, [switch]$Repeating)

  $action = New-ScheduledTaskAction -Execute (Join-Path $Stage $Cmd) -WorkingDirectory $Stage
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\proto" -LogonType Interactive -RunLevel Highest

  $s = @{
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    DontStopOnIdleEnd          = $true
    StartWhenAvailable         = $true
    ExecutionTimeLimit         = ([TimeSpan]::Zero)   # PT0S: the default PT72H would kill this at hour 72 exactly
  }
  $settings = New-ScheduledTaskSettingsSet @s
  $settings.Priority = 4          # default 7 is below-normal CPU and low I/O, and would distort the measurement
  $settings.MultipleInstances = 'IgnoreNew'

  if ($Repeating) {
    $t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 4)
    Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Trigger $t -Force | Out-Null
  } else {
    Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  }
  Ok "$Name registered"
}

Register-SoakTask -Name 'SoakMock'    -Cmd 'run-mock.cmd'
Register-SoakTask -Name 'SoakWall'    -Cmd 'run-wall.cmd'
Register-SoakTask -Name 'SoakSampler' -Cmd 'run-sampler.cmd'
Register-SoakTask -Name 'SoakProc'    -Cmd 'run-proc.cmd'
Register-SoakTask -Name 'SoakGrab'    -Cmd 'run-grab.cmd' -Repeating

Section 'Standing the other project down for the duration'
foreach ($t in 'FCATWallLauncher', 'FCATSoakSampler') {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $t | Out-Null
    Ok "$t disabled (soak-teardown.ps1 puts it back)"
  }
}

Section 'Starting, in dependency order'
# Mock first: the app's two local panels 404 if it is not up, and a failed load
# at T0 is a pre-registered failure. Then the app, then the recorders, so the
# first sampler row is a running wall rather than a connection refused.
schtasks /run /tn SoakMock | Out-Null; Ok 'SoakMock started'
Start-Sleep -Seconds 3
$probe = try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8787/soak-static.html' -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
if ($probe -ne 200) { Die "mock server did not answer on :8787 (got $probe). Not starting the app: both local arms would fail to load." }
Ok 'mock server answering on :8787'

schtasks /run /tn SoakWall | Out-Null; Ok 'SoakWall started'
Start-Sleep -Seconds 12
$status = try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8901/api/status' -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
if ($status -ne 200) { Warn "the app is not answering on :8901 yet. Check the log before trusting T0." }
else { Ok 'app answering on :8901' }

schtasks /run /tn SoakSampler | Out-Null; Ok 'SoakSampler started'
schtasks /run /tn SoakProc | Out-Null;    Ok 'SoakProc started'
schtasks /run /tn SoakGrab | Out-Null;    Ok 'SoakGrab fired once; repeats every 30 min'

Section 'State'
Get-ScheduledTask -TaskName 'Soak*' | Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "T0 (UTC): $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))" -ForegroundColor Cyan
Write-Host "Ends about: $((Get-Date).ToUniversalTime().AddHours($Hours).ToString('yyyy-MM-ddTHH:mm:ssZ'))" -ForegroundColor Cyan
