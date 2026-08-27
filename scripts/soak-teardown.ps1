<#
.SYNOPSIS
  Ends a soak run and gives HQ-PROTO-MINI-2 back to the project that owns it.

.DESCRIPTION
  Harvest BEFORE running this. It destroys the stage and the app profile, and
  there is no second copy of either. docs/soak-run.md has the harvest commands
  and they come first for a reason.

  This script previously existed only on the soak machine, which meant it removed
  itself along with the stage and the second run had to reconstruct it from the
  validation notes. It lives in the repo now.

  Two things here are not about Wallwright at all. HQ-PROTO-MINI-2 belongs to
  another project, whose FCATWallLauncher and FCATSoakSampler tasks are disabled
  for the duration of a run because they would fight over the display and the
  sampler port. Re-enabling them is the whole reason teardown is a script rather
  than a handful of ad-hoc commands: leaving that machine subtly broken for
  somebody else is a worse outcome than any soak result.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\proto\wallwright-soak\soak-teardown.ps1
#>
[CmdletBinding()]
param(
  [string]$Stage = 'C:\Users\proto\wallwright-soak',
  [switch]$KeepProfile
)

$ErrorActionPreference = 'Continue'

function Section($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor Yellow }

$soakTasks = 'SoakGrab', 'SoakProc', 'SoakSampler', 'SoakWall', 'SoakMock'
$fcatTasks = 'FCATWallLauncher', 'FCATSoakSampler'

Section 'Stopping the tasks'
foreach ($t in $soakTasks) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    schtasks /end /tn $t 2>&1 | Out-Null
    schtasks /delete /tn $t /f 2>&1 | Out-Null
    Ok "$t ended and unregistered"
  } else {
    Warn "$t was not registered"
  }
}

Section 'Killing what the tasks left behind'
# SoakWall's task completes the moment PowerShell hands off to a GUI app, so the
# app outlives its own task and schtasks /end does nothing to it. taskkill is the
# only thing that stops it.
foreach ($p in 'Wallwright', 'node') {
  $running = @(Get-Process -Name $p -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    taskkill /IM "$p.exe" /F 2>&1 | Out-Null
    Ok "$p killed ($($running.Count) process(es))"
  } else {
    Ok "$p was not running"
  }
}

Section 'Removing the stage'
# Retried, because the first attempt reliably loses a race. taskkill returns as
# soon as the kill is signalled, not once the kernel has torn the processes down,
# so app\ is still open for a moment afterwards and a single Remove-Item leaves
# the expanded build behind while reporting everything else gone. Nine renderer
# processes is nine chances to lose that race.
function Remove-WithRetry($path, $label) {
  if (-not (Test-Path $path)) { Ok "$label was already gone"; return }
  foreach ($wait in 0, 2, 5, 10) {
    if ($wait -gt 0) { Start-Sleep -Seconds $wait }
    Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $path)) { Ok "$label removed"; return }
  }
  Warn "$label would not delete: something still has a handle on it"
  Get-ChildItem $path -Force -ErrorAction SilentlyContinue | ForEach-Object { Warn "  left behind: $($_.Name)" }
}

Remove-WithRetry $Stage $Stage

# Safe to remove because pre-flight confirmed no %APPDATA%\Wallwright existed
# before the first run: this machine has never been a Wallwright user, so there
# is no real profile to destroy. soak-setup.ps1 re-checks that each time.
$profileDir = Join-Path $env:APPDATA 'Wallwright'
if ($KeepProfile) {
  Warn "keeping $profileDir (-KeepProfile)"
} else {
  Remove-WithRetry $profileDir $profileDir
}

Section "Giving the machine back"
foreach ($t in $fcatTasks) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Enable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null
    $state = (Get-ScheduledTask -TaskName $t).State
    if ($state -eq 'Disabled') { Warn "$t is STILL DISABLED: fix this by hand, it is not ours" }
    else { Ok "$t re-enabled ($state)" }
  } else {
    Warn "$t is not registered on this machine: nothing to re-enable"
  }
}

Section 'Final state'
$left = @(Get-ScheduledTask -TaskName 'Soak*' -ErrorAction SilentlyContinue)
if ($left.Count -eq 0) { Ok 'no Soak* task remains' } else { Warn "still registered: $($left.TaskName -join ', ')" }
Get-ScheduledTask -TaskName 'FCAT*' -ErrorAction SilentlyContinue |
  Select-Object TaskName, State | Format-Table -AutoSize
