<#
.SYNOPSIS
  One half-size screen grab, for the visual record a memory series cannot give.

.DESCRIPTION
  No memory series can see a frozen renderer: a stalled panel holds its memory
  perfectly flat, which reads as the healthiest possible curve. The soak pages
  draw a frame counter into the canvas rather than over it in the DOM, so it
  composites on the same surface as the animation, and two consecutive grabs
  showing the same count is a frozen renderer.

  Fires from a Scheduled Task every 30 minutes rather than looping, so a crash in
  here costs one grab rather than the rest of the run. Must run in the console
  session: a grab from an SSH session captures the wrong desktop, or nothing.

  Half size on purpose. Full 2160x3840 PNGs across 144 firings is gigabytes, and
  the frame counter is legible at half.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File soak-grab.ps1 -Out C:\Users\proto\wallwright-soak\out\shots
#>
[CmdletBinding()]
param(
  [string]$Out = (Join-Path $PSScriptRoot 'out\shots'),
  [double]$Scale = 0.5
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI awareness matters here for the same reason it mattered when measuring the
# display: without it a 2160x3840 panel at 200% scaling reports 1080x1920 and the
# grab silently captures a quarter of the screen. SetProcessDPIAware is the
# per-process call and has to happen before any bounds are read.
$sig = '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
$u32 = Add-Type -MemberDefinition $sig -Name 'WwDpi' -Namespace 'Wallwright' -PassThru
[void]$u32::SetProcessDPIAware()

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$w = [int]($bounds.Width * $Scale)
$h = [int]($bounds.Height * $Scale)
$small = New-Object System.Drawing.Bitmap $w, $h
$gs = [System.Drawing.Graphics]::FromImage($small)
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gs.DrawImage($full, 0, 0, $w, $h)

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$small.Save((Join-Path $Out "shot-$stamp.png"), [System.Drawing.Imaging.ImageFormat]::Png)

$gs.Dispose(); $small.Dispose(); $g.Dispose(); $full.Dispose()
Write-Host "grabbed ${w}x${h} -> shot-$stamp.png"
