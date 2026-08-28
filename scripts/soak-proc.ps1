<#
.SYNOPSIS
  The OS-side memory series for a soak run: one row a minute, forever.

.DESCRIPTION
  The app reports its own memory through /api/status, and that number is not the
  honest one. `workingSetSize` counts shared pages once per process that maps
  them, so on the first run the app read about 60% above private bytes. This is
  the series that answers "is this machine running out of memory", and the app's
  own series is the trend it can see about itself. A soak needs both, which is
  why this exists alongside src/dev/soak.js rather than instead of it.

  Runs as a long-lived Scheduled Task, not a 60-second trigger, so the CPU delta
  has a previous sample to subtract from. Never exits on error: the app dying at
  hour 4 is the single most important thing a soak could discover, and a sampler
  that dies with it records nothing.

  The first ten columns are the first run's, unchanged and in the same order, so a
  positional reader of that file still works here. Three VRAM columns are appended
  after them.

  VRAM is not optional once the app renders on a discrete GPU. There, textures,
  framebuffers and tiles live in dedicated video memory, which private bytes cannot
  see at all: a VRAM leak would read as a perfectly flat curve, the healthiest
  possible result. On integrated graphics the same allocations come out of system
  RAM and the existing columns catch them. The series has to cover both, because
  which one applies is a question about a cable.

  Blank rather than zero when nvidia-smi is absent, so "no discrete GPU" is not
  recorded as "no VRAM in use".

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File soak-proc.ps1 -Out C:\Users\proto\wallwright-soak\out
#>
[CmdletBinding()]
param(
  [string]$Out = (Join-Path $PSScriptRoot 'out'),
  [string]$ProcessName = 'Wallwright',
  [int]$IntervalSec = 60
)

$ErrorActionPreference = 'Continue'

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$csv = Join-Path $Out ("proc-" + $env:COMPUTERNAME + ".csv")

if (-not (Test-Path $csv)) {
  'iso_utc,uptime_s,procs,ws_mb,private_mb,handles,threads,avail_mb,commit_pct,cpu_pct_sum,vram_used_mb,vram_total_mb,gpu_util_pct' |
    Out-File -FilePath $csv -Encoding ascii
}

# Committed bytes has no CIM property: it is a performance counter, and the
# localised counter name would break on a non-English machine, so the total comes
# from Win32_OperatingSystem instead and the percentage is computed here.
$os = Get-CimInstance Win32_OperatingSystem
$commitLimitMb = [math]::Round($os.TotalVirtualMemorySize / 1KB, 1)

$startedUtc = (Get-Date).ToUniversalTime()
$prevCpu = @{}
$prevStamp = $null

# Resolved once: a Get-Command per minute for 72 hours is 4,320 pointless lookups.
$nvidiaSmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source

while ($true) {
  try {
    $nowUtc = (Get-Date).ToUniversalTime()
    $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)

    $wsMb = 0.0; $privMb = 0.0; $handles = 0; $threads = 0; $cpuPct = 0.0

    foreach ($p in $procs) {
      $wsMb += $p.WorkingSet64 / 1MB
      $privMb += $p.PrivateMemorySize64 / 1MB
      $handles += $p.HandleCount
      $threads += $p.Threads.Count

      # CPU as a share of one core-second per wall-second, so a fully busy
      # quad-core reads 400 rather than 100. A throttled app shows as a cliff,
      # which is the point: memory that stops climbing because the app stopped
      # working is not a memory result.
      $cpuNow = $p.TotalProcessorTime.TotalSeconds
      if ($prevStamp -and $prevCpu.ContainsKey($p.Id)) {
        $wall = ($nowUtc - $prevStamp).TotalSeconds
        if ($wall -gt 0) { $cpuPct += (($cpuNow - $prevCpu[$p.Id]) / $wall) * 100.0 }
      }
      $prevCpu[$p.Id] = $cpuNow
    }

    # Drop pids that are gone, or a 72-hour run accumulates every renderer the
    # watchdog ever recycled.
    $live = @{}
    foreach ($p in $procs) { $live[$p.Id] = $true }
    foreach ($id in @($prevCpu.Keys)) { if (-not $live.ContainsKey($id)) { $prevCpu.Remove($id) } }

    $osNow = Get-CimInstance Win32_OperatingSystem
    $availMb = [math]::Round($osNow.FreePhysicalMemory / 1KB, 0)
    $usedMb = $commitLimitMb - [math]::Round($osNow.FreeVirtualMemory / 1KB, 1)
    $commitPct = if ($commitLimitMb -gt 0) { [math]::Round(($usedMb / $commitLimitMb) * 100, 1) } else { 0 }

    $vramUsed = ''; $vramTotal = ''; $gpuUtil = ''
    if ($nvidiaSmi) {
      try {
        # One GPU assumed, which is true here. Parsed defensively: a driver update
        # mid-run that changes the output must cost blank cells, not the series.
        $q = & $nvidiaSmi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>$null
        $parts = ($q | Select-Object -First 1) -split ','
        if ($parts.Count -ge 3) {
          $vramUsed = $parts[0].Trim(); $vramTotal = $parts[1].Trim(); $gpuUtil = $parts[2].Trim()
        }
      } catch { }
    }

    $row = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12}' -f
      $nowUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'),
      [int]($nowUtc - $startedUtc).TotalSeconds,
      $procs.Count,
      [math]::Round($wsMb, 1),
      [math]::Round($privMb, 1),
      $handles,
      $threads,
      $availMb,
      $commitPct,
      [math]::Round($cpuPct, 2),
      $vramUsed,
      $vramTotal,
      $gpuUtil

    Add-Content -Path $csv -Value $row -Encoding ascii
    $prevStamp = $nowUtc
  } catch {
    # A failed sample must not end the series. Record it and keep going: a gap
    # cannot be told apart from a stopped sampler, a recorded failure can.
    Add-Content -Path $csv -Value ("# " + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + " sample failed: " + $_.Exception.Message) -Encoding ascii
  }

  Start-Sleep -Seconds $IntervalSec
}
