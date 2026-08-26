# Giving the Windows runner a desktop

## What the runner can and cannot do, precisely

Added 2026-08-26, when the self-test moved onto every push. Two facts that sound
contradictory and are not:

- **Electron can create and drive a real window on PROTO1-P8.** `npm run selftest`
  runs there as a gating step and passes: 62 assertions, a `BaseWindow`, four
  `WebContentsView`s, an overlay composited on top, and a synthetic pointer drag
  through the layout editor. Proven, not assumed - the step has no
  `continue-on-error`, and the run is green.
- **Nothing on that runner can photograph the desktop.** The diagnostic below
  still stands: the runner is a Windows service, so it lives in session 0, where
  `UserInteractive` is `False`, no user is logged on and `explorer.exe` is not
  running. `CopyFromScreen` needs an interactive desktop; creating a window does
  not.

So session 0 has a window station Electron is happy to draw into, and no desktop a
screenshot API can read. That distinction is the whole reason `npm run selftest`
is a useful CI gate while `screenshot-windows.yml` is parked.

Worth stating because it is easy to over-read. A sibling project's runner notes
conclude from a passing Electron smoke test that "that machine has an interactive
desktop". The smoke test proves Electron can make a window; it does not prove the
session is interactive, and here the same evidence coexists with a session 0
diagnostic that says it is not.

## Runner facts, for when a job will not start

Both runners are **org-level**, in the Potion group `default`. There are none
scoped to this repository.

| label set                | machine                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `[self-hosted, Windows]` | `PROTO1-P8`                                                         |
| `[self-hosted, macOS]`   | `hqmbp26-crouse`, plus `jeffbook-mac` and `Brooklyn-Studio` when up |

Access for this repository **is** granted - `build-windows.yml` and now `ci.yml`
both run on it. So a job stuck at "Waiting for a runner to pick up this job" means
the machine is offline, not a labels or permissions problem. The tell: if one
platform's job starts and the other queues, it is a machine.

An offline runner will block a PR here, because the Windows job is a required gate
rather than advisory. That is deliberate. The hosted Linux job still reports in
about fifteen seconds, so there is always some signal.

`../planchette/docs/RUNNERS.md` has the fuller write-up, including how a Mac was
added as an org runner and why `svc.sh install` is the step people forget.

## The problem

Wallwright's last unverified assumption is that the transparent overlay
composites over the live panels on Windows. Everything else about Windows is
covered: the probes confirm the view APIs and the fullscreen paths, the
self-test confirms `main.js` behaves, and the installer builds. None of that
proves the wall _looks_ right, because nothing has looked at it.

An automated screen grab on the self-hosted runner fails with "the handle is
invalid". The diagnostic step in `.github/workflows/screenshot-windows.yml`
reports why:

```
user:                Proto
UserInteractive:     False
process session id:  0
screen count:        1
  WinDisc 1024x768 primary=True

 SESSIONNAME   ID  STATE
>services       0  Disc
 console        1  Conn

query user:   No User exists for *
explorer.exe is NOT running

actions.runner.Potion.PROTO1-P8   StartName: .\Proto   StartMode: Auto
AutoAdminLogon = 0
```

Two separate things are wrong, and fixing only one will not help.

1. **The runner is a service**, so it runs in Windows **session 0**, which is
   isolated from the interactive desktop by design. It cannot see or capture
   session 1.
2. **Nobody is signed in.** `explorer.exe` is not running, so there is no
   desktop anywhere on the machine. The console session is sitting at the
   sign-in screen.

That second point is the one that surprised us. Re-registering the runner
interactively would not be enough on its own: there would be no session for it
to run in.

It also bounds what the Windows evidence so far means. Every Windows probe and
the self-test ran against the `WinDisc 1024x768` disconnected pseudo-display, so
they establish behaviour and API results, not rendering.

## The fix

Both parts, in order:

1. **Sign in automatically**, so a desktop exists after a reboot. Use
   [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon)
   rather than editing the registry: it stores the password as an encrypted LSA
   secret instead of plaintext in `DefaultPassword`. The machine is already
   half-configured for this, with `DefaultUserName = Proto`.

2. **Start the runner inside that session** rather than as a service. Remove the
   service and start `run.cmd` from the user's Startup folder. A scheduled task
   set to "run whether the user is logged on or not" lands back in session 0,
   which is the problem being fixed.

3. **Keep the screen awake and unlocked.** A locked or blanked screen has no
   composited desktop to capture.

`scripts/windows-runner-desktop.ps1` reports on all three and, with `-Apply`,
does steps 2 and 3. It deliberately does not do step 1, because that means
handling a password.

```powershell
# report only
powershell -ExecutionPolicy Bypass -File scripts\windows-runner-desktop.ps1

# after setting up autologon
powershell -ExecutionPolicy Bypass -File scripts\windows-runner-desktop.ps1 -Apply
```

Then reboot and dispatch **Screenshot Windows**. The diagnostic step should
report a session id other than 0 and `explorer.exe` running, and the run should
produce a screenshot artifact.

## The trade-off

This is worth stating plainly, because it is a change to shared infrastructure
and not only to this project.

Automatic sign-in means the machine boots straight to an unlocked desktop.
Anyone with physical access to PROTO1-P8 has a logged-in session, and the
runner's account credentials are stored on it. The build machine also stops
being unattended in the security sense, and every project using this runner
inherits that: touch-table-sim and conflower-player run here too.

Against that, an interactive runner is what lets any of those projects test
anything a person would actually see. touch-table-sim's release workflow already
carries the note that its smoke test "cannot open a window without" an
interactive desktop, and marks that step `continue-on-error` for exactly this
reason. So this is a pre-existing limitation for more than one project, and
fixing it helps more than one.

## The cheaper alternative

If this is a one-off check rather than something wanted on every build, none of
the above is necessary. Install the release on any Windows machine with a
display, run it, and look at the wall. That answers the compositing question in
about a minute, and it is closer to the real deployment anyway, since the show
PC is not a build runner.

Automating it is worth doing if compositing should be checked on every build, or
if the show PC is remote and hard to get to.
