# The 72-hour soak: runbook

**Status: RUNNING. Third attempt, started `2026-08-27T20:31:57Z`, due to end about
`2026-08-30T20:31:57Z`.**

| attempt | started                | ended                  | got               |
| ------- | ---------------------- | ---------------------- | ----------------- |
| first   | `2026-08-25T13:24:29Z` | `2026-08-25T20:17:36Z` | 6.9h, no verdict  |
| second  | `2026-08-27T19:47:42Z` | same hour, abandoned   | ~30min, discarded |
| third   | `2026-08-27T20:31:57Z` | running                | -                 |

`memoryLimitMb` stays 0 and `_memoryBaseline` stays `NOT MEASURED YET` until this
one finishes. `docs/validation.md` has all three write-ups.

**Both earlier attempts died the same way: the machine was in use and this work did
not know.** The first was displaced by `C:\HQ\SoDA\MS_Immersive_Tunnel.exe
-station mini2`, which started 77 minutes after its last sample and then ran for two
days, holding 7758 of 8188 MiB of VRAM at 99% GPU. The second was staged beside it
and looked perfectly healthy for half an hour, because Wallwright was on the
integrated chip and SoDA had the discrete card, so the two never contended.

That process was confirmed to be leftover from an old test and killed before this
attempt. Its two Scheduled Tasks are one-shot triggers that already fired, so
nothing will relaunch it.

**The lesson, for the next person staging this:** "is the machine free" is the wrong
question and it passed twice while being wrong. Ask **what is running on it right
now**, and look at the GPU, not just at memory and task lists. The pre-flight now
enforces that, but a script refusing to start is a worse way to find out than
asking.

**Three checks before walking away from a start**, all of which have caught
something real:

1. `matched display by <w>x<h>` and `layout ... 1:1` in the app log. The display had
   been rotated between attempts and the app fell back to primary at 0.563 scale.
2. The GPU pre-flight line. It fails at or above 50% VRAM or 50% utilisation and
   names the neighbour.
3. `Wallwright.exe` present in `nvidia-smi`, if the wall is meant to be on a
   discrete card. Which socket the cable is in changes what the memory series can
   see.

## What is running, and where

|         |                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------- |
| Machine | **HQ-PROTO-MINI-2**, tailnet `100.98.111.111`, ssh user `proto`                                 |
| Key     | `~/.ssh/fcat_wall_deploy_ed25519` (the fcat wall-deploy key)                                    |
| Stage   | `C:\Users\proto\wallwright-soak`                                                                |
| Output  | `C:\Users\proto\wallwright-soak\out`                                                            |
| App log | `C:\Users\Proto\AppData\Roaming\Wallwright\logs\wallwright.log`                                 |
| Build   | git `c384dcf`, `Wallwright-0.1.1-x64.zip`, sha256 `1b377dbe...`, from Actions run `33109052397` |
| GPU     | **NVIDIA RTX A1000**, cable on the discrete card. Confirmed via `nvidia-smi` process list       |
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

## Staging it from cold

Everything is in the repo; nothing has to be reconstructed. Three scripts, and the
only one you run by hand is the first:

| script                      | runs on  | what                                                                      |
| --------------------------- | -------- | ------------------------------------------------------------------------- |
| `scripts/soak-stage.sh`     | the Mac  | copies build, harness, panel pages and config; hash-verifies; pre-flights |
| `scripts/soak-setup.ps1`    | the wall | expands the build, writes the wrappers, registers the five tasks, starts  |
| `scripts/soak-teardown.ps1` | the wall | ends it and gives the machine back                                        |

**1. Build from the ref you intend to soak.** Not a stale artifact: the point of
the run is a baseline for what ships.

```sh
gh workflow run build-windows.yml --ref main
gh run download <run-id> -n wallwright-windows-x64 -D /tmp/build
```

**2. Stage it.** This copies everything and stops. It deliberately does not start
the run, because staging is reversible and committing somebody else's machine for
three days is not.

```sh
scripts/soak-stage.sh /tmp/build/Wallwright-0.1.1-x64.zip
```

It refuses to continue if the zip's sha256 does not survive the transfer, and it
finishes by running the pre-flight, which changes nothing. The pre-flight fails
rather than warns if `%APPDATA%\Wallwright` already exists, if a `Soak*` task is
still registered, if node is missing, or if the panel pages did not arrive. A
leftover profile means the previous teardown did not finish, and starting on top of
it would both poison the run and make the next teardown delete something that was
not ours.

**3. Confirm the machine is free**, per the top of this file. This is the step that
cost the first run.

**4. Start it.**

```sh
ssh ... 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\proto\wallwright-soak\soak-setup.ps1' </dev/null
```

The setup script starts the mock server first and **refuses to start the app if
`:8787` does not answer**, because both local arms would otherwise fail to load and
a failed load at T0 is a pre-registered failure. It prints T0 and the projected end.

**5. Check the geometry before walking away.** The single most important line in
the app log, and the one that caught this run's first start:

```sh
ssh ... 'powershell -NoProfile -Command "Get-Content $env:APPDATA\Wallwright\logs\wallwright.log -TotalCount 6"' </dev/null
```

It must say `matched display by <w>x<h>` and `layout ... 1:1`. If it says
`falling back to the PRIMARY display` or `scaled to 0.nnn`, stop and fix the config
before the run gets any further: the pre-registration fixes `wall.scale` at 1.0, and
a scaled layout is not the experiment that was registered.

## The geometry changed between the runs

The first run found this 4K panel mounted in **portrait**, 2160x3840, and
`config/soak-72h.json` was authored at 1080x1920 to match. Between the two runs the
project that owns the machine rotated it back to **landscape**, 3840x2160, so at
200% scaling the app is handed 1920x1080.

The config now follows the display rather than the other way round. Rotating a
shared machine's screen back to suit this experiment is exactly the kind of
unannounced interference that ended the first run, and it is not worth a verdict.

**The pre-registration survives this intact**, because what it actually fixed was
the pixel count, not the aspect:

|                 | first run           | this run            |
| --------------- | ------------------- | ------------------- |
| mounting        | portrait 2160x3840  | landscape 3840x2160 |
| logical window  | 1080x1920           | 1920x1080           |
| raster at DPR 2 | **8.29 megapixels** | **8.29 megapixels** |
| `wall.scale`    | 1.0                 | 1.0                 |
| panels          | 2x2 of 540x960      | 2x2 of 960x540      |

Raster memory and GPU load are driven by that pixel count, and it is unchanged, so
the two memory series are comparable and both are comparable to a 3840x2160 wall.
The four arms, the thresholds and the invalidating conditions are all untouched.
One caveat genuinely improves: the first run had to note that a wall is landscape
and this display was not. Now it is.

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

**An early reading is not a result.** One hour into the _first_ run the total went
1380 to 1409MB.
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
ssh ... 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\proto\wallwright-soak\soak-teardown.ps1' </dev/null
```

That script ends and unregisters all five tasks, kills the app and node, removes
the stage and the `%APPDATA%\Wallwright` profile (safe: pre-flight confirmed
neither existed before), and **re-enables `FCATWallLauncher` and
`FCATSoakSampler`**, which belong to another project and are disabled for the
duration. Verify afterwards that both read `Ready` and that no `Soak*` task
remains; the script prints both.

It retries the two deletions with a backoff rather than trying once. `taskkill`
returns when the kill is _signalled_, not when the kernel has finished tearing the
processes down, so the expanded build is still open for a second or two afterwards.
A single attempt loses that race often enough to matter: on this run's first
teardown it reported everything gone except `app\`, which was still there.

## What to do with the numbers

1. Append a section to `docs/validation.md` in the house style: result first,
   numbers as evidence, caveats explicit. Include both memory series, the final-24h
   slope with R² and the median cross-check, the per-panel table with `control` as
   the headline row, the counters, and any downtime rows.
2. Quantify the **workingSetSize versus private bytes gap** at the plateau. Two
   minutes into this run, once the startup transient had cleared, it was 1326MB
   against 777MB, so the app's own figure read about 71% high; the first run
   started at 65% high and drifted down to 59% by hour 7. That
   number is what lets anyone interpret the app's own log line, and it has been an
   open question since the original 699MB datum.
3. Set the shipped countermeasure from the data, using the rule already committed
   in `config/wall.json` under `_memoryBaseline` and implemented as
   `memoryLimitFromBaseline()` in `src/upkeep.js`. Do not guess it: a limit inside
   the normal operating band rebuilds a panel on every check, which was measured
   taking memory _up_ from 1513 to 1885MB.
4. Fill in the `_memoryBaseline` block with the measured `p95_24h`, `peak_72h` and
   drift, replacing the `NOT MEASURED YET` marker.

## Caveats a run here carries

- **Not the show PC and not a wall.** The display is a 4K panel at 200% scaling, so
  the app runs at 1920x1080 logical. The raster is 3840x2160 = 8.29 megapixels,
  identical to a 3840x2160 wall, so GPU and raster load are representative; the
  panel arrangement is not. The aspect now is, which is one caveat better than the
  first run managed. See "The geometry changed between the runs".
- **Not the real dashboards.** Nothing here speaks to whether a real IdP session
  survives idleness or a rebuild. That stays open until the URLs exist.
- **One machine, one run, no replicate.** A strong lower bound on how bad things
  are, weak evidence of how good.
- SentinelOne runs on this machine at ~844MB and is a background variable.
- **Which GPU draws the wall is a question about a cable**, and it changes what the
  memory series can see. On the integrated chip, GPU allocations come out of system
  RAM and the existing columns catch them. On the discrete card they live in VRAM,
  invisible to private bytes, which is why `vram_used_mb` exists. Record which one
  was in use, because `_memoryBaseline` only transfers to a show PC cabled the same
  way. Nothing in this repo yet records how the show PC is cabled.
- The `heavy` panel's DOM HUD overlaps the canvas-drawn counters. Cosmetic; the
  canvas text is the freeze detector and it works.

## If it has died when you look

That is a finding, not an accident to paper over. There is no auto-launch and no
crash restart (`AGENTS.md` TODO 6), so the wall stays dark until somebody notices,
which is exactly what the soak is meant to reveal. The sampler keeps polling and
records `ok=0` rows with an error kind, so the outage is dated in the CSV and the
summary lists it under Downtime. Harvest first, then read the app log's last lines
and the Windows event log before restarting anything.
