<#
.SYNOPSIS
  Registers Wallwright as a Scheduled Task that starts at logon and restarts if
  it dies. The half of auto-start that cannot live inside the app.

.DESCRIPTION
  There are two ways to make the wall come back on its own, and they cover
  different failures.

  The app's own `autoStart` setting is a login item: a per-user "start this at
  logon" entry. It handles the case that blocks a deployment, which is that the
  show PC reboots overnight. It cannot handle a crash, because the thing that
  would do the restarting is the thing that died.

  This script is the other half. A Scheduled Task supervises the process, so
  Windows restarts it when it exits unexpectedly.

  ** USE ONE OR THE OTHER, NOT BOTH. ** If the login item and this task are both
  active, two copies launch at logon. The single-instance lock means the second
  one exits rather than fighting over the wall, so it is survivable, but it is
  still an app failing to start every morning for no reason. If you register this
  task, turn `autoStart` off in the settings panel.

  Three Task Scheduler details are load-bearing, and two of them have already
  cost this project a run:

  1. The action runs the exe DIRECTLY, never through powershell.exe or a .cmd
     wrapper. `docs/soak-run.md` records that the soak's `SoakWall` task sat in
     state Ready rather than Running, because PowerShell does not block on a GUI
     app: the wrapper returned immediately and the task completed while the app
     kept running. A task that has already completed cannot restart anything, so
     a wrapper would silently turn restart-on-failure into decoration.

  2. ExecutionTimeLimit is PT0S. The default is PT72H, which would kill the wall
     at exactly hour 72. The soak hit this one too.

  3. Priority is 4. The default of 7 is below-normal CPU and low I/O, which
     visibly hurts four 4K panels.

  A clean quit is not a crash. Ctrl+Shift+Q exits zero, the task completes
  successfully and nothing restarts, which is what an administrator deliberately
  quitting should get.

  ** UNRUN. ** This script has never been executed: there is no show PC yet. It
  is committed so the deployment is not reconstructed from memory on the day, and
  it is listed as unverified in `docs/validation.md` group C.

.PARAMETER ExePath
  The installed Wallwright.exe. Defaults to the perMachine NSIS location.

.PARAMETER Unregister
  Remove the task instead of creating it.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\wallwright-autostart.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\wallwright-autostart.ps1 -Unregister
  powershell -NoProfile -ExecutionPolicy Bypass -File .\wallwright-autostart.ps1 -ExePath 'D:\Wallwright\Wallwright.exe' -RestartCount 5
#>
[CmdletBinding()]
param(
  [string]$ExePath = 'C:\Program Files\Wallwright\Wallwright.exe',
  [string]$TaskName = 'Wallwright',
  [string]$UserId = "$env:USERDOMAIN\$env:USERNAME",
  [string]$ConfigPath = '',
  [int]$RestartCount = 3,
  [int]$RestartIntervalMinutes = 1,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "  [FAIL] $t" -ForegroundColor Red; exit 1 }

if ($Unregister) {
  Section "Removing $TaskName"
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Warn "no task named $TaskName; nothing to do"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Ok "$TaskName removed"
  Warn 'The app is still running if it was running. Stop it with taskkill.'
  exit 0
}

Section 'Pre-flight'

if (-not (Test-Path $ExePath)) {
  Die "$ExePath does not exist. Install Wallwright first, or pass -ExePath."
}
Ok "found $ExePath"

# The whole point of the direct-exec rule above, asserted rather than trusted:
# if somebody edits this script to add a wrapper, this catches it.
if ([System.IO.Path]::GetExtension($ExePath).ToLower() -ne '.exe') {
  Die "ExePath must be the exe itself. A .cmd or a powershell wrapper returns immediately, the task completes, and restart-on-failure silently stops working. See the notes at the top of this file."
}
Ok 'the action is the exe itself, so the task stays Running while the app does'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Warn "a task named $TaskName already exists and will be replaced"
}

Section 'Registering'

$action = if ($ConfigPath) {
  # Wallwright reads WALLWRIGHT_CONFIG from the environment, which does not
  # propagate into a Scheduled Task. Passing it as an argument is not supported by
  # the app, so a config override means setting the variable machine-wide instead.
  Die 'WALLWRIGHT_CONFIG cannot be passed through a task action. Set it as a machine environment variable, or leave the config in %APPDATA%\Wallwright\wall.json where the app seeds it.'
} else {
  New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory (Split-Path $ExePath -Parent)
}

# InteractiveToken, because the wall needs console session 1 where the display
# is. A task running in session 0 has no display at all and the app would come up
# with nowhere to draw. Limited rather than Highest: the app writes its config to
# %APPDATA% and needs no elevation, and elevating it complicates input handling
# for no gain.
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

$s = @{
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  DontStopOnIdleEnd          = $true
  StartWhenAvailable         = $true
  ExecutionTimeLimit         = ([TimeSpan]::Zero)   # PT0S: the default PT72H would kill the wall at hour 72
  RestartCount               = $RestartCount
  RestartInterval            = (New-TimeSpan -Minutes $RestartIntervalMinutes)
}
$settings = New-ScheduledTaskSettingsSet @s
$settings.Priority = 4                # the default 7 is below-normal CPU and low I/O
$settings.MultipleInstances = 'IgnoreNew'

# At logon rather than at startup. At startup would fire in session 0, before
# anyone has logged in, with no display to draw on. This assumes the show PC
# auto-logs-in, which is how an unattended exhibit machine is set up anyway.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
  -Settings $settings -Trigger $trigger -Force | Out-Null
Ok "$TaskName registered"

Section 'What to check'
Write-Host @"
  1. The show PC must auto-log-in, or nothing fires: this trigger is at logon.
  2. Turn autoStart OFF in the settings panel if you registered this task, or
     two copies launch every morning and the second one exits on the lock.
  3. Log out and back in. The task should read Running, not Ready, for as long
     as the app is up. Ready means the action returned and restart-on-failure is
     doing nothing.
       Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
  4. Kill it with taskkill and confirm it comes back within $RestartIntervalMinutes minute(s).
  5. Quit it properly with Ctrl+Shift+Q and confirm it does NOT come back.
"@
