# The 72-hour soak: in flight

**Status: RUNNING.** Started `2026-08-25T13:24:29Z`, ends about
`2026-08-28T13:24Z` (Friday morning, 09:24 local). Everything below is written to
be usable by somebody who was not there, from nothing but this file.

## What is running, and where

|         |                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------- |
| Machine | **HQ-PROTO-MINI-2**, tailnet `100.98.111.111`, ssh user `proto`                                 |
| Key     | `~/.ssh/fcat_wall_deploy_ed25519` (the fcat wall-deploy key)                                    |
| Stage   | `C:\Users\proto\wallwright-soak`                                                                |
| Output  | `C:\Users\proto\wallwright-soak\out`                                                            |
| App log | `C:\Users\Proto\AppData\Roaming\Wallwright\logs\wallwright.log`                                 |
| Build   | git `ddafb04`, `Wallwright-0.1.1-x64.zip`, sha256 `020be292...`, from Actions run `32847419440` |
| Config  | `config/soak-72h.json`, staged as `soak-config.json`                                            |

The base command for everything here. Every call needs `</dev/null` or a read loop
will consume its own stdin:

```sh
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/fcat_wall_deploy_ed25519 \
    proto@100.98.111.111 '<command>' </dev/null
```

Five Scheduled Tasks, all with an `InteractiveToken` principal so they land in
console session 1 where the display is. They are tasks rather than SSH children
because **Windows OpenSSH kills the whole process tree when the session ends**,
which is a lesson this fleet already learned the hard way.

| task          | what                                   | state while running                                                                                                                                      |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SoakMock`    | serves the two local panels on `:8787` | Running                                                                                                                                                  |
| `SoakWall`    | the app                                | **Ready** (PowerShell does not block on a GUI app, so the task completes while the app keeps running. Kill the app with `taskkill`, not `schtasks /end`) |
| `SoakSampler` | polls `/api/status` every 60s          | Running                                                                                                                                                  |
| `SoakProc`    | OS-side series every 60s               | Running                                                                                                                                                  |
| `SoakGrab`    | screen grab every 30 min               | Ready between firings                                                                                                                                    |

## Checking on it, without disturbing it

```sh
# the app's own view
ssh ... 'cmd.exe /c curl -s http://127.0.0.1:8901/api/status' </dev/null

# the current slope and verdict, rewritten every minute
ssh ... 'powershell -NoProfile -Command "Get-Content C:\Users\proto\wallwright-soak\out\*-summary.md"' </dev/null

# private bytes, the honest number
ssh ... 'powershell -NoProfile -Command "Get-Content C:\Users\proto\wallwright-soak\out\proc-*.csv -Tail 3"' </dev/null

# the app's own log
ssh ... 'powershell -NoProfile -Command "Get-Content $env:APPDATA\Wallwright\logs\wallwright.log -Tail 20"' </dev/null
```

**Do not RDP to this machine.** A remote session hijacks console session 1, blanks
the physical display and leaves it disconnected, which is one of the pre-registered
invalidating conditions in `docs/validation.md`.

## Reading the result

Judged on the **final 24 hours**, not the whole run: Chromium legitimately climbs
for hours before it settles. The pre-registration is in `docs/validation.md` under
"Pre-registration: the 72-hour soak" and was committed before T0. The short form:

- **Pass** at or under **15 MB/hour** over the final 24h on this 31.6GB machine.
- The **median cross-check must agree** in sign and rough magnitude with the OLS
  fit. If it does not, the fit is being driven by a spike and neither is trusted.
- `soak-stats.js` prints `INSUFFICIENT DATA` rather than a verdict when the window
  is too thin, so a number is never dressed up as a finding.
- Fails regardless of memory: any unexpected exit, a panel crash not recovered
  inside 60s, a sustained watchdog reload cadence, URL drift, or the `control` arm
  climbing.

**The arms are the point.** `control` is a static page with no timers, no network
and no DOM changes: if _it_ climbs, the growth is in Electron or in this app, which
is the only outcome that indicts the product. `heavy` is heavy but leak-free by
construction. `grafana` and `earth` are realistic but not actionable: if they climb
and the local arms do not, a third-party page leaks and the answer is `refreshMs`
on those panels, not app surgery.

**An early reading is not a result.** One hour in, the total went 1380 to 1409MB.
Extrapolated that is 29 MB/hour and over the line, and it is almost certainly
warm-up. Do not quote it.

## Harvesting, then tearing down

Collect **before** destroying anything:

```sh
ssh ... 'powershell -NoProfile -Command "Compress-Archive -Path C:\Users\proto\wallwright-soak\out\*, $env:APPDATA\Wallwright\logs\wallwright.log -DestinationPath C:\Users\proto\wallwright-soak\results.zip -Force"' </dev/null
scp -o IdentitiesOnly=yes -i ~/.ssh/fcat_wall_deploy_ed25519 \
    proto@100.98.111.111:wallwright-soak/results.zip .
```

Also check for a reboot, which invalidates the memory curve and must not be
stitched over:

```sh
ssh ... 'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime; Get-WinEvent -FilterHashtable @{LogName=\"System\"; ID=1074,6005,6008,41} -MaxEvents 10 | Select TimeCreated,Id"' </dev/null
```

Then, and only then:

```sh
ssh ... 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\proto\wallwright-soak\teardown-soak.ps1' </dev/null
```

That script ends and unregisters all five tasks, kills the app and node, removes
the stage and the `%APPDATA%\Wallwright` profile (safe: pre-flight confirmed
neither existed before), and **re-enables `FCATWallLauncher` and
`FCATSoakSampler`**, which belong to another project and are disabled for the
duration. Verify afterwards that both read `Ready` and that no `Soak*` task
remains.

## What to do with the numbers

1. Append a section to `docs/validation.md` in the house style: result first,
   numbers as evidence, caveats explicit. Include both memory series, the final-24h
   slope with R² and the median cross-check, the per-panel table with `control` as
   the headline row, the counters, and any downtime rows.
2. Quantify the **workingSetSize versus private bytes gap** at the plateau. At T0 it
   was 1380MB against 835MB, so the app's own figure read about 65% high. That
   number is what lets anyone interpret the app's own log line, and it has been an
   open question since the original 699MB datum.
3. Set the shipped countermeasure from the data, using the rule already committed
   in `config/wall.json` under `_memoryBaseline` and implemented as
   `memoryLimitFromBaseline()` in `src/upkeep.js`. Do not guess it: a limit inside
   the normal operating band rebuilds a panel on every check, which was measured
   taking memory _up_ from 1513 to 1885MB.
4. Fill in the `_memoryBaseline` block with the measured `p95_24h`, `peak_72h` and
   drift, replacing the `NOT MEASURED YET` marker.

## Caveats this run carries

- **Not the show PC and not a wall.** The display is a 4K panel mounted in portrait
  at 200% scaling, so the app runs at 1080x1920 logical. The raster is 2160x3840 =
  8.29 megapixels, identical to a 3840x2160 wall, so GPU and raster load are
  representative; the aspect and the panel arrangement are not.
- **Not the real dashboards.** Nothing here speaks to whether a real IdP session
  survives idleness or a rebuild. That stays open until the URLs exist.
- **One machine, one run, no replicate.** A strong lower bound on how bad things
  are, weak evidence of how good.
- SentinelOne runs on this machine at ~844MB and is a background variable.
- The `heavy` panel's DOM HUD overlaps the canvas-drawn counters. Cosmetic; the
  canvas text is the freeze detector and it works.

## If it has died when you look

That is a finding, not an accident to paper over. There is no auto-launch and no
crash restart (`AGENTS.md` TODO 6), so the wall stays dark until somebody notices,
which is exactly what the soak is meant to reveal. The sampler keeps polling and
records `ok=0` rows with an error kind, so the outage is dated in the CSV and the
summary lists it under Downtime. Harvest first, then read the app log's last lines
and the Windows event log before restarting anything.
