# Soak summary

Label: mini2
Host: HQ-Proto-Mini-2
Window: 2026-08-27T20:31:56.604Z to 2026-08-30T20:32:07.756Z (72.0h)
Samples: 4320, ok 4320, failed 0
Restarts: 0

## Memory

first 1537MB, last 1406MB, min 1261MB, max 1537MB, mean 1339MB

| fit | MB/hour | R2 | samples |
| --- | --- | --- | --- |
| whole longest segment | 0.80 | 0.857 | 4320 |
| **final 24h** | **0.45** | 0.288 | 1440 |
| median cross-check | 0.89 | - | head 1299MB tail 1362MB |

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

URL drift samples: 4320

## Verdict: PASS

Threshold 15 MB/hour over the final 24h, pre-registered before the run.
