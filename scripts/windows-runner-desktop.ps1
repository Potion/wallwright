<#
.SYNOPSIS
  Reports, and optionally performs, what PROTO1-P8 needs so a build can see a
  desktop.

.DESCRIPTION
  The GitHub runner is installed as a Windows service. A service runs in session
  0, which is isolated from the interactive desktop, so it cannot render or
  capture anything a person would see. On this machine there is no desktop at
  all: nobody is signed in, and explorer.exe is not running.

  Two things have to be true for a build to see a desktop:

    1. A user is signed in and stays signed in, so a desktop exists.
    2. The runner runs inside that session rather than as a service.

  Run with no arguments to report. Run with -Apply to make the changes.

  This is a shared machine. Read "The trade-off" in docs/windows-runner.md
  before applying: signing in automatically means the machine boots straight to
  an unlocked desktop, which is a real change to its security posture and
  affects every project that uses this runner.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-runner-desktop.ps1
  powershell -ExecutionPolicy Bypass -File scripts\windows-runner-desktop.ps1 -Apply
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$RunnerDir = 'C:\actions-runner'
)

$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Todo($t) { Write-Host "  [todo] $t" -ForegroundColor Yellow }

Section 'Current state'

$signedIn = [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue)
if ($signedIn) { Ok 'someone is signed in, so a desktop exists' }
else { Todo 'nobody is signed in: there is no desktop to draw on or capture' }

$svc = Get-CimInstance Win32_Service |
  Where-Object { $_.PathName -like '*actions-runner*' -or $_.Name -like '*actions.runner*' } |
  Select-Object -First 1
if ($svc) { Todo "runner is a service ($($svc.Name), as $($svc.StartName)), so it runs in session 0" }
else { Ok 'runner is not installed as a service' }

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$auto = (Get-ItemProperty -Path $winlogon -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon
if ($auto -eq '1') { Ok 'autologon is enabled' } else { Todo 'autologon is disabled' }

if (-not $Apply) {
  Section 'What to do'
  Write-Host @'
  Nothing has been changed. To apply:

  1. Set up automatic sign-in. Use Sysinternals Autologon rather than editing
     the registry by hand: it stores the password as an encrypted LSA secret
     instead of plaintext under DefaultPassword.

       https://learn.microsoft.com/sysinternals/downloads/autologon
       Autologon.exe Proto . <password>

  2. Re-run this script with -Apply. It removes the runner service and sets the
     runner to start at sign-in instead, so it lands in the desktop session.

  3. Reboot. The machine signs in, the desktop appears, and the runner starts
     inside it.

  Then dispatch the "Screenshot Windows" workflow. Its diagnostic step should
  report a session id other than 0 and explorer.exe running.
'@
  exit 0
}

Section 'Applying'

if (-not $signedIn) {
  Write-Warning 'No one is signed in. Set up autologon first (step 1 above), or the runner will have no session to start in after reboot.'
}

if ($svc) {
  Write-Host "  stopping and removing $($svc.Name)"
  Push-Location $RunnerDir
  try {
    & .\svc.cmd stop
    & .\svc.cmd uninstall
    Ok 'runner service removed'
  }
  finally { Pop-Location }
}

# Start the runner at sign-in, inside the interactive session. A Startup
# shortcut rather than a scheduled task: a task with "run whether logged on or
# not" lands back in session 0, which is the problem being fixed.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'GitHub Actions Runner.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = Join-Path $RunnerDir 'run.cmd'
$shortcut.WorkingDirectory = $RunnerDir
$shortcut.WindowStyle = 7 # minimised, so it does not sit over the wall
$shortcut.Description = 'Runs the GitHub Actions runner in the interactive session'
$shortcut.Save()
Ok "runner will start at sign-in ($lnk)"

# A locked or blanked screen has no composited desktop to capture.
Write-Host '  disabling the screen saver and lock timeouts'
Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0'
Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0' -ErrorAction SilentlyContinue
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
Ok 'screen will stay awake and unlocked'

Section 'Next'
Write-Host '  Reboot. After sign-in the runner starts in the desktop session.'
Write-Host '  Then dispatch "Screenshot Windows" and check the diagnostic step.'
