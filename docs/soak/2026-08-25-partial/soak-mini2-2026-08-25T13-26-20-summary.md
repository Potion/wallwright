# Soak summary

Label: mini2
Host: HQ-Proto-Mini-2
Window: 2026-08-25T13:26:20.607Z to 2026-08-25T20:17:28.026Z (6.9h)
Samples: 412, ok 412, failed 0
Restarts: 0

## Memory

first 1379MB, last 1424MB, min 1379MB, max 1458MB, mean 1413MB

| fit | MB/hour | R2 | samples |
| --- | --- | --- | --- |
| whole longest segment | 3.40 | 0.467 | 412 |
| **final 24h** | **3.40** | 0.467 | 412 |
| median cross-check | 3.76 | - | head 1401MB tail 1423MB |

The final window is the one that matters: Chromium climbs for hours before
it settles, so an early fit measures warm-up. The median cross-check must
agree in sign and rough magnitude, or the fit is being driven by a spike.

## Counters at the end

- crashes: 0
- failedLoads: 0
- loads: 0
- watchdogScheduled: 0
- watchdogReloads: 0
- watchdogDeferrals: 0
- timerRefreshes: 0
- recycles: 0
- memoryLimitHits: 0
- memoryRecycles: 0
- memoryAllInUse: 0
- presetApplies: 0
- panelsCreated: 0
- panelsDeleted: 0

URL drift samples: 412

## Verdict: PASS

Threshold 15 MB/hour over the final 24h, pre-registered before the run.
