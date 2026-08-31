# Changelog

Wallwright is pre-1.0, so the API, the config format and the keyboard map may all
change between releases without a major bump. That is what
[semver](https://semver.org/) means by major version zero.

**The releases were renumbered once, on 2026-08-24.** What had been published as
`v0.2.0` and `v0.3.0` became `v0.1.0` and `v0.1.1`, because 0.3.0 overstated how
far along this is. Semver says a released version must never be modified, and
renumbering breaks that; it was done anyway because nothing had been downloaded
(every asset showed zero downloads) and the repository is private. It will not
happen again now that this file exists.

The Forge-named installers were deleted from both releases at the same time. The
app was called Forge until 2026-08-24; see `docs/identity.md` for why it is not
called that any more. The git tags still point at the code those installers were
built from, so nothing is unrecoverable.

## Unreleased

### The shipped config is heavy now, and the control surface is on

`config/wall.json` shipped four `example.com` placeholders, which meant nothing
about the default resembled what a wall actually carries: no WebGL, no live data,
no dashboard that keeps working after it has loaded. It now ships two Grafana Play
boards, `earth.nullschool.net` and `windy.com`. Every one was checked to respond
before being committed.

Two of them, the Grafana board and earth, are content the 72-hour soak measured,
so `memoryLimitMb` 2000 is now derived against something related to what ships.
**Only related, not identical**, and `_memoryBaseline.recheck_when` says so: two of
the four soak arms were local pages served by the dev harness on
`localhost:8787`, and `src/dev` does not ship, so they could not be used here.
The limit transfers approximately. It is still a runaway guard rather than a tuned
figure until it is re-derived against the real dashboards.

**The control surface now ships enabled**, on `127.0.0.1:8901`. It was `port: 0`,
which is off. This is a real change in default posture and not a tidy-up: every
install now opens a loopback listener it did not open before. The surface is
unauthenticated by design and the guard is the bind address, per `AGENTS.md`, and
it is turned on because it is where the settings live. `control.port: 0` still
turns it off.

Unchanged and still blocked on the real dashboards: `allowedOrigins` is still
empty, and the per-panel `zoom` values are still 1 rather than tuned.

### Auto-start, in the two halves it actually has

`AGENTS.md` carried "auto-launch on boot and crash restart" as one TODO item. It
is two, they fail differently, and only one of them can live in this process.

**The machine rebooted** is a login item, and that is new: `autoStart`, off by
default, reconciled at every boot so an entry deleted by hand is noticed and put
back. `src/autostart.js` holds the decisions and imports no electron, so
`test/autostart.test.js` covers them on plain node. Two refusals in there are
deliberate. It does nothing on Linux, and it does nothing in an unpackaged run,
where `process.execPath` is the Electron binary under `node_modules` — the probe
answer recording exactly that path is in `docs/validation.md`.

**The app died** cannot be a login item. It fires once at logon, and the process
that would restart the app is the one that crashed. That half is
`scripts/wallwright-autostart.ps1`, a Scheduled Task with restart-on-failure,
`InteractiveToken` so the wall lands on the display, `ExecutionTimeLimit` PT0S
and `Priority` 4. Its load-bearing detail is that the action is the **exe
itself**: `docs/soak-run.md` records the soak's own `SoakWall` task sitting in
state _Ready_ rather than _Running_, because PowerShell does not block on a GUI
app, and a task that has already completed cannot restart anything. The script
refuses to register a non-`.exe` action for that reason.

**The script has never been run.** There is no show PC. CI now parses every
`scripts/*.ps1` on the Windows runner, which proves they are valid PowerShell and
nothing further; that gate exists because these files only ever execute somewhere
nothing else would catch a syntax error. Both halves are in `docs/validation.md`
group C with what to check on the day.

Also new, and read-only on purpose: `npm run probe` now reports the login item
API. Registering one would write into the login items of whoever runs the probe,
and the macOS CI job runs on a person's own machine. It turned up that
`executableWillLaunchAtLogin` is present on macOS despite being documented as
Windows-only, so it cannot be used as a platform test and is not.

## 0.1.2 - 2026-08-31

The first release since the audit, and the first with evidence behind it rather
than intent. Three things make it worth taking over 0.1.1 even though nothing is
deployed yet.

**Security.** Chromium 150 to 152, via Electron 43.4.1 to 44.1.0. On top of that,
several holes closed since the last tag: SSO popups had no navigation policy at
all, a panel could be pointed at any URL scheme and any partition, permissions are
now deny-by-default with a per-view escape hatch, the overlay has a CSP, and the
navigation policy now covers `will-redirect` and `will-frame-navigate` rather than
only `will-navigate`. That last one mattered: four of six redirect shapes used to
slip straight past enforcement, including the one that looks exactly like an
expired session bouncing to an identity provider.

**Longevity, measured.** A completed 72-hour soak at 0.45 MB/hour against a
pre-registered 15, with the `control` arm flat. The memory countermeasure is
switched on for the first time, at a limit derived from that run rather than
guessed. The watchdog is bounded; it used to reload a broken URL every thirty
seconds forever.

**It is checked now, not just documented.** The self-test runs on Windows and
macOS on every push and is 85 assertions, up from 21 at the last tag. Coverage
thresholds, `eslint:recommended`, and an assertion over the built `.asar` that the
dev harness did not ship.

### Known limitations

- **Unsigned on both platforms.** SmartScreen warns and Gatekeeper quarantines.
  Certificates are still to be obtained; see README "Signing".
- **`memoryLimitMb` is 2000, measured against the soak lineup**, not against the
  real Honeywell dashboards, which do not exist yet. Treat it as a guard against
  runaway growth rather than a tuned figure, and re-derive it when the real URLs
  land. `config/wall.json` also still ships `example.com` placeholders, so the file
  is edited before deployment anyway.
- **`selfTest()` still ships inside `main.js`**, roughly 600 lines, inert without
  both `WALLWRIGHT_DEV=1` and `WALLWRIGHT_SELFTEST=1`. Moving it out of the bundle
  was on the audit's list and was not done.
- **Not verified on the show PC**, and nothing here speaks to the real dashboards:
  no evidence about whether a real IdP session survives three days of idleness.

### The watchdog, the discard path and the fatal page, all asserted

Second batch of the group A conversion. The self-test is 85 assertions, up from 73.

Steps 26 and 27 kill a real renderer with `forcefullyCrashRenderer()`, and neither
watchdog path had ever been exercised end to end. 26 covers the background path;
27 is the half that protects an operator's login, and its load-bearing assertion is
the negative one, that nothing reloaded the panel while somebody had it promoted.
Disabling the safety rule reddens it with `watchdogReloads went 1 -> 2`.

26 also asserts a rule its own first version tripped over. Every panel in
`config/selftest.json` has an empty url, and `scheduleReload()` returns early for
those on purpose, because a placeholder cannot fail and retrying it is noise. The
first attempt therefore read correct behaviour as a broken watchdog. Both halves of
the rule are asserted now.

28 asserts the config file is byte-identical after Shift+Esc. 29 renders the real
`fatalPage()` in a real renderer and reads the text back, so the page this project
had never actually looked at has now been looked at.

**And `hideInactiveWhenActive` is answered, after being open since the option was
written.** Steps 22 and 30 measure the same 50ms interval in a backgrounded panel,
once with the option off and once on, on both platforms:

| platform | occluded (off)                | hidden (on)        |
| -------- | ----------------------------- | ------------------ |
| macOS    | 60 ticks in 3000ms, full rate | 3 ticks, about 1Hz |
| Windows  | 3 ticks, about 1Hz            | 3 ticks, about 1Hz |

On Windows, the deployment target, the two columns are the same number: Chromium
already throttles an occluded renderer, so hiding it as well costs nothing this can
measure. The framing in `AGENTS.md`, that hiding "may throttle" the view, treated
that as the cost of enabling it, and on the machine that matters the cost is
already being paid either way.

The liveness half is settled; the benefit half is not. Nothing here measures how
much GPU load hiding four 4K panels saves. So the option is safe to enable rather
than known to be worth enabling, and **the default is deliberately unchanged**. The
macOS column is also a trap worth naming: a dev machine makes the option look
expensive, and anyone evaluating it there reaches the opposite conclusion from the
correct one.

Reported and not changed: Shift+Esc skips the save but does not put the live layout
back, so a panel dragged during a session stays dragged until the app restarts,
while the overlay labels that key "discard".

### Five things the checklist asked a person to look at, now asserted

`AGENTS.md` has long carried a convention: add a `check()` to the self-test for
behaviour you would otherwise verify by eye, and make sure it can actually fail.
`docs/validation.md` then carried seventeen things to verify by eye, none of them
ticked. The mechanical ones are now self-test steps 21 to 25, running on every push
on both target platforms. The self-test is 73 assertions, up from 64.

- **No reload on promote or dock** (21), the `SPEC.md` guarantee that stops every
  promote costing an operator whatever they had typed. A mark on the renderer's
  `window` survives both, or the view reloaded.
- **A backgrounded panel keeps running** (22), with a real interval in the other
  panel's renderer. A wall whose other three dashboards freeze the moment one is
  promoted is a wall showing stale numbers.
- **One Esc docks the wall** (23), sent to the panel's own `webContents`, because
  Esc is handled per view rather than as a `globalShortcut`.
- **Per-panel zoom does not leak** (24).
- **Idle auto-return** (25), which arms `idleReturnMs` briefly rather than waiting
  minutes. Only administrators have input, so this timer is the common path back
  to the grid, not an edge case.

**The Windows runner then failed two of them, and both were the test's fault, not
the app's.** Which is the job doing exactly what it exists for.

Step 24 expected a zoom factor of 0.75 and got 0.6. The app was right:
`panelZoom()` is `zoom * layout.scale`, and `PROTO1-P8` fits a 1280x800 wall into
a 1024x768 display at 0.8. The assertion had a scale of 1.0 baked into it, which is
invisible on a dev machine where the scale _is_ 1.0. **That is the second time that
exact mistake has been made here**, after three steps once passed wall units to
`ww:addPanel` for the same reason, and the second time this runner is the only
thing that caught it. It compares against `panelZoom()` now.

Step 22 expected at least three ticks of a 50ms interval and got one. That one is
not a test bug but a finding: **Windows throttles an occluded renderer to about
1Hz, and macOS runs it at the full rate** - 1 tick in 1200ms against 60 in 3000ms,
with `hideInactiveWhenActive` `false` in both cases, so the panel was visible and
merely covered. On the deployment target, promoting one dashboard drops the other
three to roughly one update a second. Nothing is broken, but "the other panels keep
running" is a weaker promise on the show platform than the dev machine suggests.
The step now asserts the renderer did not stop and logs the observed count, because
asserting a rate would be asserting one platform's behaviour and calling the other
a failure.

That also part-answers the open `hideInactiveWhenActive` question, whose premise
was that leaving it off keeps panels at full rate. On Windows it does not, so the
trade is "throttled versus hidden" rather than "full rate versus throttled", and
the GPU-headroom argument for it is correspondingly weaker.

Each was proven to fail against the behaviour it guards before being counted, and
one of them did not. The first version of the zoom check sampled only after
docking, and a leak injected into `activate()` did not trip it: `showPanelsInGrid()`
re-applies each panel's own factor on the way out, so the fault was scrubbed before
the assertion ran. It now samples while promoted as well, and catches it. A check
that passes against broken code is worse than no check, which is the whole reason
the convention says to try to break it.

### The last duplications, and one comment that had stopped being true

Phase 6, and the end of the audit.

`loadPanel()` has always carried a comment calling itself "the one place that
decides" what an empty URL means, so the watchdog could not disagree with every
other load path. It was not the one place. Three other sites built the same
`v.url || placeholderURL(v)` expression inline and called `loadURL` themselves:
creating a view, applying a URL change, and the control surface's reload. They
agreed with it by coincidence, and none of them got the catch that is there
because a torn-down `webContents` throws synchronously. All six load sites route
through it now.

Checked rather than assumed while in there: `loadURL` rejects on `ERR_ABORTED`,
which is routine, and `unhandledRejection` logs at fatal level. That looked like it
might mean spurious fatal lines in the log. It does not, and the completed soak
says so: zero unhandled rejections in 5787 lines over 90 hours. Left alone, but
there is now one place to change it if that ever stops being true.

`indexOfId()` existed and four other places inlined the same `findIndex` anyway,
one of them a local arrow inside `checkMemory()` that shadowed it with an identical
body. All four call the helper now.

A scan for repeated four-line runs found three blocks, and collapsed them into
`contentWebPreferences(v)`, `showPanelsInGrid()` and `raiseOverlay()`. **The first
is the one that mattered**: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true` and the shared activity preload were written out twice, for the two
surfaces that display somebody else's page. Divergence there is a security
regression, not an inconsistency, and an SSO popup with `contextIsolation`
accidentally off still logs people in perfectly. The popup copy even carried a
comment saying its preload had to match the content views', which is exactly the
kind of invariant a comment cannot hold and a function can.

The fourth item on the phase's list, naming drift, was looked for and is not there:
no `panelId` or `viewId`, and `v` for a config spec against `view` for the Electron
object holds across every module. The one real inconsistency, `config.views`
holding things the runtime calls panels, is in the config schema, and renaming it
would break every committed config and every deployed profile to settle a question
of taste. Recorded as a non-finding rather than turned into churn.

### Three gates that were documented rather than enforced

The rest of the audit's phase 4. Each of these was a fact `docs/validation.md`
already asserted, with nothing checking it stayed true.

**`eslint:recommended` is the baseline**, with the five hand-picked rules kept on
top of it, scoped to the same file set so the linter does not wander into `dist/`
or the mock pages. The codebase passed on the first run with no fixes. That is a
weaker result than it sounds, since a config that fails to apply and a config that
finds nothing look identical, so it was checked: a file with unreachable code and
a duplicate object key produced exactly `no-unreachable` and `no-dupe-keys`,
neither of which the five hand-written rules cover. `@eslint/js` and `js-yaml` are
now explicit devDependencies rather than borrowed from other packages' trees.

**`npm run coverage` fails below 97% lines, 87% branches and 95% functions**,
against measured 98.26 / 89.08 / 97.08, and runs on the hosted CI job. Set just
under the current numbers deliberately: a ratchet against regression rather than a
target, since a threshold set exactly at today's figure turns an unrelated refactor
into a red build.

Those thresholds cannot see the blind spot this project already knew about, so it
is covered separately. Node's reporter lists only files the test process loaded, so
a module with no tests does not show as 0%, it does not show at all; the reported
98% is over 2424 of 6406 lines, and true coverage of shipped source is 38%.
`test/packaging.test.js` now requires every top-level `src/*.js` to have a matching
test file or be one of four listed exceptions, checks the reverse so an exception
that grows a test has to come off the list, and has a tripwire for entries naming
files that no longer exist.

**What ships is now asserted in two layers.** `electron-builder.yml` has always
excluded `src/dev/**` and nothing ever checked. The fast layer is
`test/packaging.test.js`, running on every push: the exclusion exists, `asar` is
on, the default config still ships, and the negation still comes _after_ the
`src/**/*` include that would otherwise match it. That last one is the sharp edge,
because the order is load-bearing and swapping two adjacent lines silently ships
the harness while looking like a tidy-up. The true layer is `npm run check:asar`,
wired into both build workflows, which reads the built artifact rather than the
config that produced it, and checks both directions: nothing under `src/dev/`,
`test/`, `docs/`, `.github/` or `node_modules/electron/`, and the entry point, the
three renderer bridges, `config/wall.json` and `package.json` all present.

Every one of these was proven against a real failure rather than just written. Each
config assertion was checked by making the exact edit it guards and watching that
test and no other go red. The artifact check was proven by deleting the exclusion
and running a real build: 34 dev files shipped, including the mock server that
binds a port and every probe, against 22 entries and a clean pass with the
exclusion in place. That was one line away from shipping at any point in this
project's life.

### Electron 44, and every probe answer re-run against it

Bumped 43.4.1 to **44.1.0**, Chromium 150.0.7871.224 to 152.0.7977.65. Taken after
the soak and after the memory cleanups, which is the order the audit plan fixed:
a probe answer recorded against one runtime is evidence about that runtime and
nothing else, so a bump invalidates the lot until they are re-run.

**All six probes were re-run and every answer came back identical.** That is the
result worth having, more than a green test suite, because these are the findings
the design rests on: child views still reorder in place rather than detaching,
macOS still needs simple fullscreen rather than kiosk, a reload still costs a login
nothing while a recycle still clears `sessionStorage`, an animated page still does
not fake input, and the navigation matrix came back row for row, including the two
rows that forced `hardenView()` to police `will-redirect` and `will-frame-navigate`
as well as `will-navigate`.

Every breaking change in Electron 44 was checked against the source rather than
assumed away, and none of them lands: the `clipboard` module's removal from the
renderer and its move to Promises (not used, except `navigator.clipboard` in a mock
dev page, which is what the change points you at), the null `webContents` on
`select-client-certificate` (not listened for), `net.request` frame destinations
(`net` unused), 32-bit Windows and Linux armv7l (x64 and arm64 only), Unity on
Linux, and the pre-macOS 13 login item attributes. One is worth remembering rather
than dismissing: **macOS 12 is no longer supported**, so a self-hosted macOS runner
on Monterey would stop working.

The caveat this creates is recorded rather than glossed. `_memoryBaseline` was
measured on 43.4.1, and a whole Chromium major plus ANGLE moving to static linking
are both in the GPU path the soak needed a VRAM column to see at all. The limit is
a runaway guard sitting 633MB above the measured p95, so there is no reason to
think it stops being sane, but it now describes a runtime one major behind what
ships. The re-measure already scheduled against the real dashboards covers this
too; the thing to avoid is bumping Electron again between a baseline being measured
and the wall going live.

### The memory ladder keeps its state in one place, and the upkeep tick is linear

Three cleanups to the memory code, held back until the soak finished because that
run existed to characterise exactly this code, and landing changes underneath it
would have made the baseline describe something that no longer shipped.

`memorySnapshot()` was the third writing of the same sum over
`app.getAppMetrics()`. Two earlier copies had already been collapsed into it, but
the survivor still could not be tested, because it reached for the Electron API in
the middle of the arithmetic. It now calls `summarizeMetrics()` in `src/upkeep.js`,
which is that same arithmetic in a form a test can hand a captured payload to, and
keeps only the part that genuinely needs Electron: making the call, and surviving
it throwing. That failure path is now covered, and it had a sharper edge than it
looked. `memorySnapshot()` assigns the result's `byPid` straight into the module's
last-reading cache, so a summary without maps would turn one failed metrics call
into a `TypeError` on the next tick.

The ladder's six loose module globals are one `memoryLadder` object. They were
never really six independent variables, and the comment above them claimed all of
them reset when memory recovers, which was not true: `recyclesSinceReduction`
counts rebuilds that reclaimed nothing and deliberately outlives an episode,
because giving up is a judgement about the whole run rather than about one spike.
Which fields clear together is now a `clearMemoryPressure()` function rather than
four assignments a reader has to check against a comment.

The upkeep tick was quadratic. `eligible()` called `panelStates()` and indexed one
element out of the result, and `runUpkeep()` calls `eligible()` once per panel per
second, so _n_ panels built _n²_ panel states a second. There is now a
`panelStateAt(i)` for one panel, with `panelStates()` mapping over it for the
memory ladder, which ranks candidates against each other and so genuinely needs
all of them. Four panels made this cheap enough to ignore, but panels are created
at runtime and the count is not fixed at four.

`panelStateAt()` returns null when no panel is at that index, and `eligible()` now
answers "no such panel" rather than dereferencing undefined. That case is real
rather than defensive: `deletePanel()` splices a spec out while that view's own
handlers are still attached, so the watchdog arrives with an index of -1. It used
to throw, and because `uncaughtException` rethrows, it took the whole wall down.
Self-test step 16 already reproduces it, and now covers the guard as well.

### The 72-hour soak finished, and there is finally a memory baseline

Third attempt, and the first to reach a verdict. It ran the full 72.0 hours on
HQ-PROTO-MINI-2 from `2026-08-27T20:31:56Z` and **passed**: 0.45 MB/hour over the
final 24 hours against a threshold of 15 fixed before T0, with the median
cross-check at 0.89 agreeing in sign and magnitude. 4320 of 4320 samples, no failed
polls, one `runId` for the whole run, zero crashes, zero failed loads, zero watchdog
reloads, and no reboot inside the window.

The `control` arm is the one that mattered, because it is a static page with no
timers, no network and no DOM changes, so growth there would have been growth in
Electron or in Wallwright rather than in anybody's dashboard. It did not climb: a 73
to 79MB band across three days, +0.021 MB/hour over the scored window, and a step
back down at h+66.5. `heavy` settled at exactly 121MB from h+24 onward, which
retires the 1.1 MB/hour reading the 16-hour checkpoint flagged as the one line to
watch; it was warm-up being extrapolated.

`_memoryBaseline` in `config/wall.json` is filled in from the run: `p95_24h` 1367,
`peak_72h` 1537, `driftMbPerHour` 0.45, which the committed rule turns into
`memoryLimitMb` 2000 and `memoryHardLimitMb` 2750, **and both are now set**. The
memory countermeasure is live for the first time; it has shipped inert since it was
written.

Switching it on was gated on one question about a cable. The baseline was measured
with the video on a discrete GPU, where textures and framebuffers live in VRAM and
never enter the number the limit is compared against; on integrated graphics they
come out of system RAM and do. Jeff confirmed the show PC's HDMI is always in the
discrete GPU port, so the path matches and the baseline transfers. If one ever runs
off the motherboard port, the baseline is void.

The limit is a runaway guard rather than a tuned figure, and the write-up says so:
it was measured against the soak lineup, not the real Honeywell dashboards, which do
not exist yet and are the thing most likely to move `p95_24h`.

Two long-open questions are also closed. The `workingSetSize` versus private-bytes
gap is **1.44 and stable** across the whole run, not the drifting figure the two
partial runs suggested, so the app's own memory line reads about 44% high against
Task Manager. And the `URL drift samples: 4320` line that prints above `Verdict:
PASS` is not the contradiction it looks like: the verdict never consulted it, and
what it records is `grafana` and `earth` normalising their own URLs once at load,
with the two local arms never drifting at all.

The run is nonetheless **reported as partial**, because any human input is a
pre-registered invalidating condition and it took one, at `2026-08-29T00:58Z`. The
argument for the verdict is in `docs/validation.md` rather than the disclosure being
left out: `lastUsedSecAgo` shows exactly one input instant, never on the other three
arms, 19.6 hours before the scored window opens.

The write-up is `docs/validation.md` under "The 72-hour run, third attempt:
COMPLETE", and the harvested series, the app log and the summary are committed under
`docs/soak/2026-08-30-complete/`.

HQ-PROTO-MINI-2 was torn down on 2026-08-31 once the archive was taken and
hash-verified, and it is given back: no stage, no app profile, no `Soak*` task, and
the other project's `FCATWallLauncher` and `FCATSoakSampler` re-enabled. The app had
run 90.8 hours continuously by then, the last 18.7 of them past the scored window
and flat to within a megabyte.

### The soak pre-flight fails on a busy machine, and the series records VRAM

Two soak attempts have now died because HQ-PROTO-MINI-2 was in use by another
project and nothing checked. The second was staged beside
`C:\HQ\SoDA\MS_Immersive_Tunnel.exe`, which had been holding 7758 of 8188 MiB of
VRAM at 99% GPU utilisation since the day the first attempt died, 77 minutes after
its last sample.

Nothing noticed for half an hour because Wallwright was rendering on the integrated
chip while SoDA had the discrete card, so the two never contended and every number
looked healthy. A clean-looking series is not evidence of a clean machine.

`soak-setup.ps1` now fails the pre-flight at or above 50% GPU memory or 50%
utilisation and prints `nvidia-smi` so the neighbour is named, and warns about any
foreign windowed process holding more than an hour of CPU. It fails rather than
warns because the cost of finding out late is the whole 72 hours.

`soak-proc.ps1` now records `vram_used_mb`, `vram_total_mb` and `gpu_util_pct`
after the existing ten columns, which a positional reader of the old file can still
skip. This is not bookkeeping: on a discrete GPU, textures and framebuffers live in
video memory that private bytes cannot see, so a VRAM leak would read as the
flattest and healthiest curve the harness can produce. On integrated graphics the
same allocations come out of system RAM and were always visible. Which case applies
is a question about which socket the video cable is in, so the series has to cover
both. Blank rather than zero without `nvidia-smi`, so "no discrete GPU" is not
recorded as "no VRAM in use".

### The soak can be started from the repo, not from memory

The first 72-hour run left a runbook that could tell you how to watch a run,
harvest it and tear it down, but never how to **start** one. The teardown script
existed only on the soak machine, so teardown deleted it along with the stage. The
second run had to reconstruct all five Scheduled Task definitions from the notes in
`docs/validation.md`.

The whole procedure is in `scripts/` now: `soak-stage.sh` copies the build, harness
and config from the Mac and hash-verifies the transfer; `soak-setup.ps1` expands the
build, writes the task wrappers, registers the five tasks and starts them in
dependency order; `soak-teardown.ps1` ends the run and re-enables the other
project's tasks; `soak-proc.ps1` and `soak-grab.ps1` are the OS-side recorders.

Staging deliberately stops short of starting. Staging is reversible and committing
somebody else's machine for three days is not, which is the lesson of the first
run: it ended because a person stopped it at the machine, having never been told a
run was on. Confirming the machine is free is a documented precondition now.

Three things the scripts refuse to paper over. The pre-flight **fails** rather than
warns if a `%APPDATA%\Wallwright` profile or a stale `Soak*` task is left over,
because starting on top of one both poisons the run and makes the next teardown
delete something that was not ours. Setup refuses to start the app if the mock
server is not answering on `:8787`, since both local arms would fail to load and a
failed load at T0 is a pre-registered failure. And teardown retries its deletions:
`taskkill` returns when the kill is signalled rather than when the kernel has
finished, so a single attempt leaves the expanded build behind while reporting
everything else gone.

### The soak config follows the display

`config/soak-72h.json` is authored at 1920x1080 for a landscape 3840x2160 panel. It
was 1080x1920, for the same panel mounted in portrait, which is how the first run
found it; the project that owns the machine rotated it back between the runs.

Authored to match rather than rotating the screen back, because a shared machine is
not this experiment's to reconfigure. The pre-registration survives it: what that
fixed was the raster, and 3840x2160 at device pixel ratio 2 is the same 8.29
megapixels as 2160x3840, so both runs remain comparable to each other and to a real
wall. `wall.scale` is 1.0 either way. A landscape mounting is in fact one caveat
better, since a wall is landscape.

Caught at T0 from the app's own log, which said `falling back to the PRIMARY
display` and `scaled to 0.563`. Checking that line before walking away is now a
step in the runbook: six minutes here, 72 hours if it is first read at harvest.

### The self-test now gates every push, on Windows

`npm run selftest` is the only coverage `src/main.js` has, and it only ran on a
`v*` tag. So a regression in 3,200 lines of main process could merge to `main`
completely green and surface at release time. It now runs on every push and every
PR, on the self-hosted Windows runner, along with lint and the unit tests.

Windows specifically, because Windows is the deployment target and is never
exercised on the dev machine, which is a Mac. It also restores the Windows
coverage that was dropped when the `windows-latest` job was removed for costing 2x
on a private repo - self-hosted runners are free, so that objection is gone. And
it is the only place the self-test _can_ run: it needs a real display, which a
hosted Linux runner does not have.

The macOS runner (`hqmbp26-crouse`, the development machine) runs the same three
steps, also gating, so the only coverage `src/main.js` has now runs on both
platforms the app ships to on every change. It catches the reverse case of the
Windows job - something that works on Windows and not on POSIX - and it is where
the app is actually developed, so a failure there is the fastest feedback
available.

The hosted Linux job stays, as the fifteen-second signal that does not depend on a
self-hosted machine being reachable.

**It earned itself on the first run.** Three self-test steps were passing wall
units to `ww:addPanel`, which takes window pixels - the handler runs
`unscaleRect()` on whatever it is given. At scale 1.0 on the dev machine the two
are indistinguishable, so the calls looked correct and had been green for days. On
the runner, where a 1280x800 wall is fitted into a 1024x768 display at 0.8, a panel
asked for at x=512 was created at 640, and the drag check failed. That is precisely
the class of bug a POSIX-only CI cannot see, and it was found within minutes of
turning Windows on.

The Windows step is a gate, with no `continue-on-error`, and `AGENTS.md` now
forbids adding one: a step marked that way reports a failed conclusion as
`success`, which is how a sibling project believed a broken smoke test passed for
weeks.

`docs/windows-runner.md` gains what that runner can and cannot do, which is
narrower than it looks: Electron can create and drive a real window there, and
nothing on it can photograph the desktop, because the runner is a service in
session 0. Those two facts sound contradictory and are not.

### The 72-hour soak ended early, and there is still no memory baseline

The first attempt ran 6.9 of its 72 hours. It was shut down at the machine on
2026-08-25T20:17:36Z, and the machine was needed for other work the next day, so
it was harvested and torn down on 2026-08-26. The threshold is judged on the final
24 hours of 72, so **there is no verdict**: `memoryLimitMb` stays 0 and
`_memoryBaseline` stays `NOT MEASURED YET`. A re-run is planned for 2026-08-27 and
starts from zero, because a memory curve cannot be resumed across a gap.

The 6.9 hours are worth reading, and are written up in `docs/validation.md`. The
`control` arm - a static page with no timers and no network, the one whose growth
would indict the app rather than a dashboard - went from 73MB to 74MB. Nothing
crashed, nothing failed to load, the watchdog never fired across 412 samples, and
the two drift estimators agreed at about 3.4 MB/hour against a 15 MB/hour
threshold. All of which is warm-up, not a result.

The harness came out of it well: between the sampler, the per-panel series and the
app log it dated the end to the second, proved it was a graceful `app.quit()`
rather than a crash, and ruled out both a reboot and the one pre-registered
invalidating condition. The log line that made that possible exists because of a
deliberate choice - `will-quit` writes `stopping after Ns` so that "silence at the
end of a soak log" cannot be mistaken for a clean finish.

### Ownership

- `copyright` is now `Copyright (c) 2026 Hyperquake`, and `package.json` names
  `Jeff Crouse <jeff.crouse@hyperquake.com>` as author. Both feed the shipped
  binaries: electron-builder writes the copyright into the Windows executable's
  version resource and into `NSHumanReadableCopyright` on macOS.
- **`appId` moved from `com.potion.wallwright` to `com.hyperquake.wallwright`.**
  That is the bundle identity, so Windows treats a build from here on as a
  different application from `v0.1.1`: an existing install is not upgraded in
  place, it is installed alongside, and the old entry has to be uninstalled by
  hand. Done now specifically because it is free now - no installer has been
  distributed and no asset has ever been downloaded - and it stops being free the
  moment one is.
- `userData` is unaffected. Electron derives that folder from the application
  name, not the appId, and the name is unchanged, so the tuned montage and every
  `persist:` session carry across untouched.

### Fixed

- The watchdog could take the whole wall down. `scheduleReload()` looked up a
  panel's index without guarding against `-1`, which is what it gets when a
  handler fires for a spec that `deletePanel()` or `applyPreset()` has already
  removed. The out-of-bounds lookup threw, and `uncaughtException` rethrows.
- Upkeep never actually refused to rebuild a panel mid-SSO-login. The rule was
  written and unit tested, but `popupOwner` was declared and read and never
  written to, so `popupOpen` was permanently false.
- A control-surface POST over the 1MB cap hung instead of answering. The cap
  destroyed the request while only `'end'` could settle the promise, and `'end'`
  never fires on a destroyed request. It now stops buffering, keeps draining, and
  answers 413.
- `saveViews()` wrote the live config with a plain `writeFileSync`. It now writes
  a sibling and renames, so a crash part-way through cannot truncate the file the
  wall boots from.
- `transitionMs`, `escDoubleMs` and `backButton` are validated. All three reached
  Electron as raw numbers, where a `NaN` silently disabled an animation, undid the
  Esc policy, or put the Back button at unusable bounds.
- `showHotspotHint`, `hideInactiveWhenActive`, `idleResetUrls` and
  `memoryRelaunch` must now be real booleans. A quoted `"false"` used to read as
  true, which for `idleResetUrls` meant a scheduled logout of every dashboard.
- A `globalShortcut` the OS refuses is now logged. Twelve accelerators were
  registered without checking the result, including the deliberate admin exit.
- **SSO popups had no navigation policy at all.** `hardenView()` was never
  applied to them, so the login window was the only one in the app that could
  follow a redirect chain anywhere and open further windows freely. They now get
  the same origin policy the content views get. Esc is deliberately still left to
  the page there, because docking the wall would close the popup out from under a
  half-entered password, and a popup whose renderer dies is now closed rather
  than left holding its panel ineligible for upkeep.
- **A panel could be pointed at any URL scheme and any partition.** `patch.url`
  was `String()`-coerced straight into `loadURL`, so `file:`, `javascript:`,
  `data:` and `chrome:` all worked, and `isAllowed` was never consulted on that
  path because it guards only `will-navigate` and `setWindowOpenHandler`. A
  partition without the `persist:` prefix silently became an in-memory session
  that loses the login on the next rebuild. Both are now refused with a reason,
  and the whole patch is validated before any of it is applied.
- The rectangles arriving on `ww:layout` and `ww:addPanel` are checked. A
  non-numeric field became `NaN`, passed through `clampGrid` untouched, reached
  `setBounds`, and was written into the config file.
- `POST /api/panel` answers 400 with a reason for a refused patch. It used to
  answer 200 with the wall's status, which reads as "done".

### Added

- **The layout editor's snapping is one implementation, not two.** It was written
  twice, in wall units in `src/layout.js` and in window pixels in
  `src/overlay.js`, and the two had already drifted apart. `src/layout.js` now
  holds the only copy, parameterised on its candidate edges and tolerance so it
  serves both unit spaces, and the overlay loads it as a plain script.
  `src/overlay.js` is 109 lines lighter, and the aspect-locked scale branch and
  the proportional clamp have tests for the first time.
- **Fixed a snap that moved a panel off the wall.** The wall-units half took the
  first edge within tolerance rather than the closest, so a panel shorter than the
  tolerance had its top edge snapped onto a line its bottom edge was already on.
  `clampGrid` hid it. Found by collapsing the duplication above.
- **The self-test drives a real pointer drag.** Every other check goes through IPC
  and skips the editor's geometry entirely; this one presses the mouse down on a
  panel frame, moves it, and asserts where the panel actually landed.
- `captureWall` moved to `src/dev/capture-wall.js`, required lazily so it cannot
  ship. Separately: `npm run capture` does not currently work on the dev machine,
  which is pre-existing and is now written up in `docs/validation.md`.
- **Four modules extracted from `main.js`, all at 100% coverage.**
  `src/pages.js` (the three generated pages, including the `escapeHtml` that is
  the only thing between an operator-typed label and a `data:` document),
  `src/interaction.js` (the Esc policy and the fullscreen predicate),
  `src/display.js` (which output the wall lands on, and how the layout is fitted
  into it), and `src/watchdog.js` (the backoff ladder and the failure-log
  suppression, both of which had been wrong before and fixed by hand).
- **Every content view now listens for `preload-error`.** That failure had no
  other symptom: the page renders, nothing crashes, and the wall silently stops
  knowing which panel is in use, so the idle timer docks it under an operator and
  the watchdog reloads a panel mid-login. The self-test now presses a key into a
  panel and checks the activity arrives.
- **Permissions are denied unless a panel asks for them.** Measured first
  (`npm run probe:perm`): a session with no handler grants microphone, camera and
  notifications silently, with no prompt, and leaves geolocation pending forever.
  Nothing in the app had ever touched permissions. Both
  `setPermissionRequestHandler` and `setPermissionCheckHandler` are now installed
  per partition, because neither alone closes the hole: the first is what refuses
  `getUserMedia`, the second is the only thing that stops
  `navigator.permissions.query` reporting `granted`. A panel that genuinely needs
  one names it in the new per-view `allowedPermissions`.
- **The navigation policy now covers redirects and subframes.** Measured
  (`npm run probe:nav`): `will-navigate` is handed the URL a page asked for and
  never the one it lands on, and it does not fire for a subframe at all, so four
  of six navigation shapes went straight past it - including a 302 whose target is
  not named in the request, which is what an expired session bouncing to an
  identity provider looks like. `will-redirect` and `will-frame-navigate` are now
  policed too, through the same `isAllowed()`.
- **A Content-Security-Policy on the overlay**, `default-src 'none'` with no
  exceptions. The overlay is the one renderer with a privileged bridge attached.
  Its stylesheet moved to `src/overlay.css` so `style-src` did not need an
  `'unsafe-inline'` hole; `src/overlay.html` is 444 lines shorter.
- `npm run probe:perm` and `npm run probe:nav`, both wired into
  `probe-windows.yml`. One runner, `src/dev/probe-serve.js`, serves the mocks for
  either and fails loudly if its server does not start, rather than silently
  measuring whatever else holds the port.
- `src/policy.js`: what a panel may load, and where it may navigate. The origin
  policy moved out of `main.js`, where it had no tests despite deciding whether a
  navigation or a popup is blocked, and it gained a fixed scheme allow-list.
- Unknown config keys are warned about on load. `memoryLimitMB` or `escToGird`
  used to validate, do nothing, and say nothing. A leading underscore still means
  documentation, so `_comment`, `_memoryBaseline` and `_soak` stay quiet.

### Changed

- `engines.node` is now `>=22`, which is the oldest version CI actually exercises
  and what the coverage thresholds require. `>=18` was never tested.

## 0.1.1 - 2026-08-24

Published earlier as `v0.3.0`.

### Renamed to Wallwright

- The product, the bundle, the installer, the `appId` (`com.potion.wallwright`),
  the environment variables (`WALLWRIGHT_*`), and the docs. The old `FORGE_*`
  variables are gone.
- **An existing install is carried across on first run.** An Electron app derives
  its userData folder from its own name, and that folder holds both the tuned
  montage and every `persist:` session, so a rename alone would have brought a
  show PC up with a default layout and signed-out dashboards.
  `migrateLegacyUserData()` copies both, and copies rather than moves so a
  rollback still finds the old install intact.
- `config/wall.json` partitions moved from `persist:forge-N` to `persist:wall-N`.
  A partition name is a storage key, so that is a new empty session, but it only
  affects a fresh install: a real deployment reads its config from userData, and
  the migration copies that across unchanged.

### A visual identity

- A new mark and app icon: an authored montage, one hero panel wearing the layout
  editor's corner grips, rather than the quad split every product in this category
  draws. Generated by `npm run icon`, never hand-drawn.
- A wordmark on the editor's bar and the control page, and nowhere else. Grid and
  active mode stay unbranded so a visitor sees the dashboards rather than the
  thing hosting them.
- The palette is now one set of tokens in `src/overlay.html`, mirrored by name in
  `src/control-page.js`, replacing about forty scattered literals.
- `docs/identity.md` records the name, the mark, the type, the palette, the
  placement rules, and which names were unavailable and why.

### A control surface for administrators

- Set `control.port` and the wall serves a status page an administrator can open
  from a laptop or phone: mode, memory, uptime, and every panel's size, position,
  zoom, load state, watchdog history and idle time.
- **Where a panel actually is**, flagged when it has drifted from its configured
  URL, which is how a silently logged-out dashboard gets noticed.
- The same routes are an API, so a show controller can drive the wall:
  `GET /api/status`, and `POST` to `/api/preset`, `/api/panel`, `/api/promote`
  and `/api/reload`.
- Unauthenticated, and it can drive the wall, so it binds to `127.0.0.1` unless
  told otherwise and logs a warning when it is not on loopback.

### Saved montages

- A montage can be saved under a name and recalled later, so one wall serves an
  overview layout, a detail layout, and whatever a given demo needs.
- `Ctrl/Cmd+Shift+1` through `9` recall the first nine without opening the editor.
- Recalling reuses panels that have not changed rather than rebuilding them, so
  switching montages does not reload pages that were already right.

### Keeping a long-running wall healthy

- Per-panel `refreshMs` and `recycleMs`, so a dashboard cannot go stale and a
  renderer can hand memory back on a timer.
- `memoryCheckMs` and `memoryLimitMb`: past the limit, the least recently used
  idle panel is recycled. The panel someone is currently using is never touched.

### Interaction

- Grid panels are live and usable where they sit. Promotion became its own mode
  (`Ctrl/Cmd+Shift+P`), because a click in the grid belongs to the page
  underneath.
- `WALLWRIGHT_LOG_INPUT=1` logs which panel each click and keypress reaches, so
  input routing can be checked rather than eyeballed.

### Verification

- The self-test now **gates** both build workflows. It drives the real app over
  IPC and needs a real display, which is why it runs on the self-hosted runners.
- Test coverage is measured (`npm run coverage`); 80 unit tests.
- Windows probes confirmed the view APIs match macOS and that every fullscreen
  path covers the display there.
- **Still unverified:** that the transparent overlay composites over live panels
  on Windows, which is the architecture's central assumption. The self-hosted
  runner cannot answer it: the runner is a service in session 0 and nobody is
  signed in, so there is no desktop to photograph. See `docs/windows-runner.md`.

## 0.1.0 - 2026-08-24

Published earlier as `v0.2.0`. Its installers were named `Forge-0.2.0` and have
been deleted; this release is source only.

- The wall: one `BaseWindow` with a `WebContentsView` per panel and a transparent
  overlay above them for click targets and chrome. No compositor and no video
  capture, so the pages stay live and interactive.
- A layout editor on top of the live pages (`Ctrl/Cmd+Shift+E`): move, resize from
  a side, scale from a corner, draw a new panel on empty wall, delete. Panels snap
  to each other and to the wall edges, twice, so an edge that looks snapped while
  previewing a 4K layout on a laptop does not save a one-pixel seam.
- Panel CRUD and an inspector for URL, label, zoom and session.
- Sessions persist across restarts, and panels can share one so several views of
  the same SSO-protected app sit behind a single login.
- macOS needs `setSimpleFullScreen`: every native fullscreen and kiosk path
  reports success while leaving the menu-bar strip uncovered.
- A notch-safe layout option for development on a MacBook.
- Windows and macOS packaging, and a wall capture tool that needs no
  screen-recording permission, which is how the README screenshots are made.
