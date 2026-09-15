# Tablet Control Surface for the Electron Compositor

## Goal

Operate the individual web panels composed on the LED wall from a tablet on the
same LAN. One panel at a time, shown at tablet resolution with real touch
targets, with taps and scrolls injected back into the live panel.

This is **not** screen mirroring. We do not capture or stream the wall's
framebuffer. Each panel is captured individually through its own `webContents`,
downscaled inside the main process, and sent to the tablet. The wall output is
untouched.

## Why this approach

- The wall canvas is >4K. Mirroring it to a tablet means either lossy
  downscaling or shipping enormous frames, and then squinting at a shrunken
  pointer.
- We do not control the page source, so we cannot add a control UI to the pages
  themselves.
- We _do_ control the Electron app, which means we have a `webContents` handle
  for every panel. Per-panel capture and input injection is available directly,
  with no external tooling, no debugging port exposed to the network, and no
  cooperation from the pages.

## What already exists

This is an extension of the admin surface in `src/control-server.js`, not a new
server. Three things are already built and must not be duplicated:

- **The HTTP server.** `createControlServer(actions, { log })` at
  `src/control-server.js:86`, started by `startControlServer()` at
  `src/main.js:3678` when `config.control.port` is set. Routes are flat string
  comparisons against a parsed `URL`, so `searchParams` is already in hand.
- **The panel registry.** One `WebContentsView` per configured page,
  index-aligned with `config.views` (`src/main.js:184`, constructed at
  `src/main.js:632`). Ids are already stable (`config.views[].id`) and
  `/api/status` already returns the full inventory (`src/main.js:3478`). The
  iframe case that would have broken per-panel capture does not apply.
- **The actions seam.** `controlActions` at `src/main.js:3531`. Everything
  Electron-shaped lives behind it; `control-server.js` imports no electron,
  which is what lets `test/control-server.test.js` drive it over real HTTP with
  a stand-in wall.

Three constraints come with that code and shape everything below.

1. **No dependencies.** "This runs on a show PC that must not need a package
   install to come up" (`src/control-server.js:14`). `package.json` has no
   runtime `dependencies` at all. So no `express`, and no `ws`.
2. **The seam stays clean.** New capability arrives as new _actions_, not as
   Electron code inside `control-server.js`.
3. **The guard is the bind address.** "There is no auth to get wrong because
   there is no auth" (`src/control-server.js:11`), with a runtime warning when
   `host` is not loopback (`src/main.js:3687`). A tablet surface requires a LAN
   bind, which removes that guard. See Security.

## Architecture

```
tablet browser  --- GET /api/stream?id=N --->  control-server.js  ---> controlActions
  /touch page   <-- multipart JPEG stream ---   (no electron)          startPanelStream
                --- POST /api/input -------->                          sendPanelInput
                                                                          |
                                                                   webContents (panel N)
```

### No websocket

The plan this replaces used `express` + `ws`. Both are avoidable, and dropping
them is what lets this fold in rather than stand up beside.

**Frames** go down as `multipart/x-mixed-replace`, the MJPEG format every IP
camera uses. A browser renders it natively in an `<img>` with no client-side
decode loop, no JSON envelope, and no base64: the CDP screencast hands us base64
which we decode in the main process and write as raw bytes. The "binary frames"
item in the old plan's refinements list is free here rather than deferred.

**Input** goes up as `POST /api/input`, which the existing router and
`readBody()` already handle. The cost is one request per event batch instead of
a persistent socket. On a LAN with keep-alive that is a few milliseconds, and
the client coalesces pointer moves into one POST per animation frame, so a drag
is a handful of requests per second rather than hundreds.

### Engine coverage, measured

The transport was the one assumption worth invalidating early, so it was tested
against all three engines locally rather than waiting for the venue tablet. This
matters more than it sounds: on iPadOS every browser is WebKit underneath, so
"any tablet browser" is really three engines, and two of them are on any Mac.

| engine               | native `<img>` multipart  | `fetch()` + parse in JS       |
| -------------------- | ------------------------- | ----------------------------- |
| Blink (Chrome 152)   | works                     | works, 124 parts in 4s        |
| WebKit (Safari 26.6) | works, 24 distinct frames | **200 with a zero-byte body** |
| Gecko (Firefox 155)  | did not render            | zero-byte body                |

Both engines that matter then chose the stream over the fallback unprompted on an
ordinary static dashboard, which is the case that counts: Chrome reported
`streaming`, and Safari was confirmed by its holding the single stream slot.

Two conclusions, one of them the opposite of what was expected.

**The native `<img>` path is the right primary, and the scripted parser is not a
fallback.** Reading the same stream with `fetch()` looked like the portable
option, since it depends on nothing but HTTP. On WebKit it returns a 200 whose
body yields nothing at all: the engine routes a multipart response to its image
decoder and the fetch consumer never sees a byte. An iPad is the most likely
tablet, so that rules the approach out as a safety net.

**Chunked transfer encoding is off.** Node reaches for it whenever there is no
content length, which wraps chunked framing around multipart framing, and that
is the combination WebKit is widely reported to mishandle. `Connection: close`
plus `res.useChunkedEncodingByDefault = false` sends the parts and nothing else.

Gecko is the open question. It did not render in either chunked mode, but those
runs are not trustworthy: the harness was contending with the server's
one-stream-at-a-time limit at the time, and the cleanest Firefox run reported
neither a load nor an error, which reads as a request that never ran rather than
one that failed. Worth re-testing before trusting the row. It changes nothing
about an iPad or an Android tablet.

**So the fallback is polling, not a second transport.** A `GET /api/frame?id=…`
returning one ordinary JPEG works on anything that can render an image, with no
multipart decoder and no streaming body involved. The touch page should watch
for a first frame and switch to polling if none arrives within a couple of
seconds. That is the milestone 3 deliverable now, and it is what makes the venue
tablet a confirmation rather than a gate.

## 1. New actions

Added to `controlActions` (`src/main.js:3531`), following the verdict contract
`updatePanel` and `updateSettings` already use, so a missing panel is a 404 and
a refusal is a 400 that says why:

```js
// -> { ok: true, stop } | { notFound: true } | { ok: false, reason }
startPanelStream: (id, onFrame) => { ... }

// -> { ok: true } | { notFound: true } | { ok: false, reason }
sendPanelInput: (id, events) => { ... }
```

`onFrame` takes a `Buffer`. `stop()` is idempotent. `control-server.js` calls
`stop()` from the response's `close` handler and never learns what a
`webContents` is; the stand-in wall in `test/control-server.test.js` grows a
fake that emits two buffers and records `stop`.

One addition to the existing `/api/status` panel payload: the panel's current
rect in window pixels, next to `grid` (`src/main.js:3484`). The tablet needs it
for coordinate mapping, and it changes when a panel is promoted, so it belongs
in the status poll rather than baked into the stream.

```js
rect: panelRect(i),   // { x, y, width, height }, window pixels
```

## 2. Screencast

Attach the debugger and start a screencast **only for the currently viewed
panel**. Encoding several 4K panels at once will compete with the wall for GPU
and CPU time. One stream at a time, app-wide: a second `startPanelStream` while
one is live either stops the first or is refused with a reason.

```js
function startPanelStream(id, onFrame) {
  const i = indexOfId(id);
  if (i < 0) return { notFound: true };
  const wc = contentViews[i] && contentViews[i].webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, reason: 'panel has no live view' };

  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    return { ok: false, reason: `could not attach: ${e.message}` };
  }

  const onMessage = (_e, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    onFrame(Buffer.from(params.data, 'base64'));
    dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId });
  };
  dbg.on('message', onMessage);
  dbg.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality: 70,
    maxWidth: 1600,
    maxHeight: 1200,
    everyNthFrame: 1,
  });

  let stopped = false;
  return {
    ok: true,
    stop: () => {
      /* stopScreencast, off, detach, once */
    },
  };
}
```

Notes:

- **Always ack.** Chromium stops sending frames if `screencastFrameAck` is not
  called. This is the most common way this breaks.
- **The screencast emits nothing on an idle page, and that is the ordinary case
  on a wall.** It is event driven, which was the reason to prefer it, but the
  consequence was underrated: a static dashboard produced zero frames over 2.5
  seconds where an animating one produced 62, and a static panel that had just
  been reloaded still produced zero, because its repaints happened before the
  screencast attached. An earlier reading of "a frame at +12ms" was a page still
  settling after launch, not a general property. So a stream primes itself with
  one `capturePage` and keeps an idle clock.
- **A multipart part is not complete until another part follows it.** Chrome held
  `naturalWidth` at 0 for eight seconds on a stream carrying a single frame,
  firing neither `load` nor `error`. Terminating the part with a trailing
  boundary is necessary but not sufficient: a second part has to arrive. That is
  why `STREAM_IDLE_MS` exists alongside the priming capture, and why the boundary
  trails each part rather than leading it.
- Downscaling happens via `maxWidth`/`maxHeight` before encoding, so a 4K panel
  never crosses the wire at full size.
- The screencast is event-driven, so a static panel costs nothing.
- **DevTools is a real conflict, not a hypothetical.** `Ctrl/Cmd+Shift+I` opens
  detached DevTools on the active panel in DEV builds (`src/main.js:3741`), and
  `dbg.attach()` throws when it is open. Hence the try/catch and the reason
  string: the tablet should say "DevTools is open on this panel", not fail
  silently.
- `stop()` must survive a panel being recycled or crashing underneath it.
  `recyclePanel()` (`src/main.js:962`) closes the old `webContents`, so the
  stream has to end when it does; hook `destroyed` and call `stop()`.

## 3. Routes

Two additions to the router in `src/control-server.js`, in the existing style.

**`GET /api/stream?id=…`**

```js
res.writeHead(200, {
  'Content-Type': 'multipart/x-mixed-replace; boundary=wallwrightframe',
  'Cache-Control': 'no-store',
  Connection: 'close',
});
```

Each frame is written as a part:

```
--wallwrightframe\r\n
Content-Type: image/jpeg\r\n
Content-Length: <n>\r\n
\r\n
<bytes>\r\n
```

Backpressure comes free from the socket: if `res.write()` returns `false`, drop
frames until `drain` rather than queueing them, or the stream drifts behind real
time. Dropping is correct here; a stale frame has no value.

`req.on('close')` calls `stop()`. This is the one long-lived response on the
server, so it must not go through the normal `json()` path, and the catch-all
500 handler must not try to write a body to a response that is already
streaming.

**`POST /api/input`**

Body `{ id, events: [ { kind, x, y, ... } ] }`, answered with the verdict shape
the other POST routes use. Validate `events` is an array and cap its length;
`readBody`'s 1 MB cap already bounds the rest.

## 4. Input injection

`webContents.sendInputEvent()` rather than `Input.dispatchMouseEvent`. It does
not require the debugger session and is simpler to get right. Pages cannot
distinguish these from real input.

```js
wc.sendInputEvent({ type: 'mouseMove', x, y });
wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true });
```

A `mouseMove` before `mouseDown` matters for pages that rely on hover state to
reveal controls.

Injected input goes straight to the target `webContents` and never touches OS
hit testing, which has a useful consequence: **the overlay is not in the way.**
On the wall itself a `WebContentsView` consumes every OS event that lands on it,
which is why the overlay has to be hidden for panels to be interactive and why
promotion exists at all (`src/main.js:1397`). The tablet is not subject to that.
It can drive a panel in grid mode without promoting it, so operating a panel no
longer means changing what the wall is showing.

## 5. Coordinate mapping

Map on the client, in two steps, using fractions rather than absolute sizes.
The frame dimensions and the panel's real size differ (the screencast is capped
at 1600x1200) and both change when a panel is promoted, so anything that
hard-codes either will drift.

```js
function toPanelCoords(evt, img, rect) {
  const r = img.getBoundingClientRect();
  // Fraction of the rendered frame, corrected for letterboxing inside the
  // element. naturalWidth/Height, not the CSS box: they differ whenever the
  // aspect ratios do not match.
  const fx = (evt.clientX - r.left) / r.width;
  const fy = (evt.clientY - r.top) / r.height;
  return { x: Math.round(fx * rect.width), y: Math.round(fy * rect.height) };
}
```

`rect` is the panel's window-pixel rect from `/api/status`. Send view-local
coordinates in that space: `sendInputEvent` works in the view's own coordinate
space, and Chromium applies the page zoom on the way in.

The zoom question is settled, by measurement rather than by reading. A panel
rendering 1253x705 window pixels at panelZoom 1.306 reports an `innerWidth` of
960, so its CSS space and its window-pixel space genuinely differ. Handing
`sendInputEvent` an x of 61 produced a `clientX` of 46, which is 61 / 1.306:
**sendInputEvent works in the view's own window-pixel space and Chromium divides
by the zoom on the way in.** So the panel-space coordinate goes straight through
with no conversion at all, and `src/panel-input.js` applies none.

At zoom 1 both candidate answers agree, which is why the first calibration pass
looked conclusive and was not. Any future check must use a panel whose zoom is
not 1. Verified across zoom 1, 2, 0.75 and 1.5 against a page that reported the
`clientX` it actually received: every target hit, worst error 1px, which is the
rounding.

`params.metadata` also carries `offsetTop`, `pageScaleFactor`, `deviceWidth` and
`deviceHeight`. Start without them and add if a scrolled or pinched page maps
wrong.

## 6. The touch page

A second export from `src/control-page.js`, served at `GET /touch`, following
the rules the status page already keeps: one constant string, no build step, no
inline event handlers (`data-` attributes plus one delegated listener), and the
palette tokens shared with `src/overlay.html` so the admin surfaces read as one
tool (`src/control-page.js:1`).

Minimum viable version:

- Panel picker across the top, from `/api/status`.
- One `<img src="/api/stream?id=…">` filling the rest. No JS in the render path.
- Pointer events on the image mapped per section 5 and POSTed, coalesced to one
  request per animation frame.
- Re-poll `/api/status` on an interval so a promote elsewhere updates `rect`.
- On stream error, reset `src` to reconnect.

`touch-action: none` on the image so the browser does not swallow gestures as
page scroll.

The existing status page gets a link per panel pointing at `/touch?id=…`, which
is the whole discovery story.

## 7. Refinements

Done, except one, and the exception is deliberate.

- **Quality toggle.** A `q` on both the stream and the still url; the page cycles
  low / normal / high (40 / 70 / 90) and restarts the stream, because quality is
  a parameter of the screencast rather than of a frame. The wall clamps to
  30..90: a quality is a preference, not an instruction, and a tablet asking for
  something silly should get a picture rather than an error. Measured on a static
  dashboard: 14 KB at q=30, 21 KB at q=70, 29 KB at q=90, and q=1000 returns the
  same bytes as q=90. On an animating panel the spread is much narrower, 163 to
  187 KB/s, because flat colour compresses the same either way.

- **Client-side pinch and pan.** Two fingers zoom and pan, one finger is input to
  the panel. The split is what keeps them unambiguous: no gesture could be
  either. A second finger landing sends an `up` first, or the panel is left
  holding a mouse button for the whole gesture. Zoom is clamped to 1..8, and
  switching panels resets the view.

  **The coordinate mapping needed no change for it**, which is worth recording
  because the earlier draft of this plan warned that it would.
  `getBoundingClientRect` already reports the _transformed_ box, so the fractions
  absorb the transform on their own. Verified rather than assumed: with the image
  scaled 2.5x and panned, all four corner targets still hit, at the same clientX
  and clientY as unzoomed, while the reported box went from 1255px wide to
  3138px.

- **Clipboard and selection, as commands rather than chords.** This was first
  built as a shortcut chord sent through `key`, and it silently did nothing.
  Measured: an injected Cmd+V arrives at the page as a keydown of "v" with meta
  set and pastes nothing, and an injected Cmd+A appends where it should have
  replaced. Clipboard and selection are browser-level commands in Chromium,
  driven by the command layer rather than by a page's key handling, so no amount
  of key injection reaches them. There is now an `edit` kind carrying an
  allow-listed command name straight to `webContents.selectAll()`, `.copy()` and
  the rest. Verified: select-all then typing replaces the selection, where the
  chord had appended.

- **Paste, from the tablet's own clipboard.** The `edit` command `paste` pastes
  the _show PC's_ clipboard, which is almost never what somebody holding a tablet
  meant. A `paste` kind carries the text across instead and inserts it with
  `insertText`: one operation, one insertion event, and a cap of 4096 characters
  rather than the 256 that typing gets.

  The page reads it from the `paste` event rather than the Clipboard API, because
  `navigator.clipboard.readText` needs a secure context and this surface is plain
  HTTP - a paste event is user-initiated, so its `clipboardData` is readable
  anywhere. Cmd+V is deliberately not also sent as an `edit` command: that would
  paste twice, from two different clipboards. Verified end to end through the
  touch page with `clipboard-sécret-€` and an emoji, arriving exactly, and
  nothing retained in the local field.

  Copying _out_ of a panel still puts the text on the show PC's clipboard, not
  the tablet's. There is no channel back. Worth knowing before somebody tries it.

- **Canvas + `createImageBitmap`: not built, on purpose.** The condition was
  "only if `<img>` decode shows up as jank above ~15fps", and the rate is 25fps,
  so the threshold is met and the question is live. But the measurement it turns
  on cannot be taken here: rendering jank needs a visible page, and an automated
  Chrome tab reports `visibilityState: hidden`, where `requestAnimationFrame`
  does not run and timers are throttled to a second. What can be said is that the
  frames are small - about 7 KB each at 1253x705 - which is a modest decode load
  for a path browsers already take off the main thread. Building it would cost
  the no-JS render path for a problem nobody has observed. Take the measurement
  on the venue tablet, with the page in front of someone, and only then decide.

Binary frames and backpressure were never on this list. Both came for free from
the transport chosen in section 1.

## 7a. What it costs the wall

Every other figure in this document measures the TABLET's experience. This one
measures the wall's, which is the one that matters on a show floor: the wall is
the deliverable and the tablet is the accessory.

`npm run stream-cost` (`src/dev/stream-cost.js`) drives a panel showing
`src/dev/mock/soak-heavy.html` - WebGL cube, 2D canvas, rotating globe, the
content class the exhibit actually uses - and reads the frame counter that page
already keeps for the 72h soak. Baseline with nothing attached, then again with a
stream running. The page reports its counter over HTTP only when asked with
`?fps=1`, so the soak keeps measuring exactly what it always did.

| condition   | panel fps | vs baseline | stream fps | bandwidth |
| ----------- | --------- | ----------- | ---------- | --------- |
| no stream   | 99.9      |             | -          | -         |
| q=40 w=1600 | 100.1     | +0.2%       | 2.8        | 1505 KB/s |
| q=70 w=1600 | 99.9      | 0.0%        | 2.2        | 2287 KB/s |
| q=90 w=1600 | 100.1     | +0.2%       | 0.6        | 3800 KB/s |
| q=70 w=960  | 100.0     | +0.1%       | 2.3        | 1292 KB/s |
| q=70 w=640  | 100.0     | +0.1%       | 3.0        | 666 KB/s  |
| q=40 w=640  | 100.1     | +0.1%       | 8.7        | 433 KB/s  |

**The wall does not stutter.** Within noise at every setting, on the worst
content there is. That is the question worth having asked, and the answer is
good.

**The tablet's view of that content is slow, and that is inherent.** Between 0.6
and 8.7 fps against 25 on a trivial animation. A globe redraws every pixel every
frame, so no JPEG can delta anything away and each frame is full price. A
dashboard with an animation on it will look like a slideshow on the tablet. It
remains usable for _control_ - taps land, scrolling works - but nobody should be
shown this as a way to watch the wall.

**Width is the stronger lever, and the two are not independent.** Pixels dominate
the cost, so narrowing buys frame rate and bandwidth together where quality only
buys bandwidth. Hence one paired control on the touch page rather than two knobs:
smooth (q40 w640), normal (q70 w960), sharp (q90 w1600). Two independent knobs
would let an operator sit on the corner that is sharp, slow and expensive at
once.

**Bandwidth is the real constraint on a venue LAN.** 3800 KB/s is 30 Mbps for one
tablet at the sharp setting. The smooth setting is 433 KB/s, which is a ninth of
that for eight times the frame rate. On venue wifi this is the number to design
against, not the frame rate.

### Test content that looks like the exhibit

Three mock pages, all interactive, all reporting through the same `?fps=1`
channel so `npm run stream-cost --page <file>` can drive any of them.

- **`globe.html`** - [globe.gl](https://globe.gl/) with the night-earth texture,
  120 animated arcs, city points and an atmosphere. Drag to spin, wheel to zoom.
  This is the content class the exhibit's own demos use, built on the library
  they would be built on. It pulls globe.gl, three.js and two textures from a
  CDN, so it needs the network; everything else here does not.
- **`dash-ops.html`** - a busy corporate operations dashboard: four live KPI
  tiles, three animated canvas charts, an asset table, an event log and a
  scrolling ticker, every region repainting independently. Interactive
  throughout - tabs, a zone filter, sortable columns, a drag slider that changes
  the chart window, acknowledge buttons on alarms, and a scrollable log. Self
  contained, so it works with the network down.
- **`soak-heavy.html`** - the existing WebGL cube and globe the 72h soak already
  validates. Unchanged except for opt-in reporting.

| page           | q=40 w=640         | q=70 w=1600        | wall cost |
| -------------- | ------------------ | ------------------ | --------- |
| globe.gl       | 28.2 fps, 194 KB/s | 8.7 fps, 796 KB/s  | 0.0%      |
| busy dashboard | 14.6 fps, 397 KB/s | 1.9 fps, 2000 KB/s | 0.1%      |
| soak-heavy     | 8.7 fps, 433 KB/s  | 2.2 fps, 2287 KB/s | 0.1%      |

The wall holds 100 fps on every one of them. The globe is the _cheapest_ of the
three, which is counterintuitive until you look at it: the night-earth texture is
mostly black, and black compresses. Density of detail, not motion, is what costs.
The busy dashboard is the expensive one, and it is also the realistic one.

Interaction through the surface was checked against the dashboard rather than
only against a target page: taps on a tab and a zone filter registered on the
panel, and a 60-move drag on the globe delivered 49 of 60 moves - enough that the
rotation tracked, since each move carries an absolute position rather than a
delta.

A caution on reading this table: an earlier run of the same measurement appeared
to show the wall collapsing to 1.2 fps at narrow widths. It was an artifact - the
app was restarted between widths and a panel reloaded inside a sample window, so
the frame counter reset and the delta read as a collapse. `stream-cost.js` now
refuses a sample whose counter went backwards, and width is a request parameter
so a sweep runs in one instance with no restarts.

## 8. Security

The control surface can already drive the wall. Streaming adds the ability to
_see_ whatever a panel is showing, including a signed-in dashboard, and to click
anything on it. That is a material change to what the existing bind-address
guard is protecting, and the guard has to change with it.

- **Keystrokes make this worse, and they now exist.** Text entry was added for
  logins, so a password typed on the tablet crosses the venue LAN as plaintext
  HTTP on an unauthenticated surface. The token below is no longer the whole
  answer: a non-loopback bind wants TLS or an SSH tunnel in front of it. The page
  itself keeps nothing - every insertion is forwarded and cancelled, so no
  password is ever held by the tablet - but the wire is still in the clear.
- **A token becomes a precondition, not a nice-to-have.** Add
  `config.control.token` beside `port` and `host` (validated at
  `src/config.js:354`, defaulted at `src/config.js:493`). Compare with
  `crypto.timingSafeEqual` on equal-length buffers. Refuse to bind to a
  non-loopback host when a port is set and no token is configured: today's
  warning at `src/main.js:3687` is the right thing for a loopback-by-default
  surface and the wrong thing for this one.
- `<img src>` cannot set headers, so the stream accepts `?token=`. Query-string
  tokens land in logs; that log is the machine's own diag file, which is an
  acceptable trade, but say so in the config comment. POSTs use a header.
- Bind to the venue interface, not `0.0.0.0`, if the machine has more than one,
  and firewall the port to the venue subnet.
- Keep the `EDITABLE_SETTINGS` allow-list posture (`src/config.js:524`): the new
  routes add exactly two verbs, both scoped to one panel id.
- Do not enable `--remote-debugging-port` for this. The in-process debugger API
  gives the same capability without opening a CDP port anyone on the network can
  drive.

## 9. Tests

`npm run coverage` gates at 97% lines / 87% branches / 95% functions, so this
lands with tests or it does not land.

`control-server.js` stays electron-free, so the stand-in wall in
`test/control-server.test.js` grows `startPanelStream` and `sendPanelInput`
fakes. Worth covering there, over real HTTP:

- A stream response carries the multipart content type and one readable part per
  emitted buffer.
- `stop()` is called when the client disconnects mid-stream.
- An unknown id is a 404 on both routes; a refusal (DevTools attached) is a 400
  carrying the reason.
- `/api/input` rejects a non-array `events` and an over-long batch.
- The catch-all 500 handler does not try to write a JSON body into a response
  that has already started streaming.

Coordinate mapping is the part most likely to be wrong and the part hardest to
unit test. Keep `toPanelCoords` a pure function so `test/control-page.test.js`
can exercise it against letterboxed and promoted rects without a browser.

## Milestones

1. `/api/stream` route and the `startPanelStream` action, wired to a stub that
   emits a fixed JPEG. Proves the multipart framing and the seam.
2. Real screencast frames from a hardcoded panel, acked, rendering in desktop
   Chrome.
3. Done. `/api/frame`, `/touch`, and the transport switch. Stills go through
   `capturePage`, so they never touch the stream slot: a second tablet polling
   one panel while another streams a different one is demonstrated working, and
   that is the practical relief valve for the slot contention noted below.
4. Done. `/api/input`, `src/panel-input.js`, and the touch page's pointer
   handling. Verified end to end: taps dispatched at the touch page's `<img>`
   landed on all four corner targets of a calibration page inside the panel,
   within a pixel.
5. Done. Picker, switching, and clean start/stop. Six rapid switches in a row
   were accepted with no refusals and a frame on each. Switching is gated on a
   session counter: a polling chain, a pending stream load and a transport
   timeout all belong to the panel that started them, and both transports drive
   the same `<img>`, so a stale callback left running fights the new panel for
   it. The new stream also waits `RELEASE_MS` for the server to free the single
   slot, because a 400 there would be read as "this browser cannot stream" and
   drop the tablet to polling for the rest of the session.
6. Done. Scroll and full text entry.

   **Scroll direction is inverted between the two conventions.** A DOM wheel
   event reports a positive `deltaY` when the user scrolls down; `sendInputEvent`
   wants a negative one to move the page down. Measured: -600 took a page from
   scrollY 0 to 919, +600 brought it back. `src/panel-input.js` negates both
   axes, so a tablet swipe no longer scrolls backwards.

   **Text goes out as char events, one per code point.** Verified against a page
   reporting what its field actually held: ascii, accents, umlauts and tildes,
   currency symbols, the ASCII symbol set, Greek, CJK, emoji and a mixed password
   all round-tripped exactly, 9 of 9. Astral characters need `Array.from`;
   indexing a string would send two halves of a surrogate pair and arrive as
   nothing. All 13 named keys arrive with the right DOM name, and all four
   modifiers survive singly and combined.

7. Token and non-loopback bind refusal. Before any LAN bind, not after.
8. Refinements from section 7 as needed.

## Open questions

- Do any panels need keyboard input, or is pointer enough for v1?
- Which browser is on the venue tablet? No longer a gate: WebKit and Blink are
  both measured working, and polling covers whatever is left. Still worth
  knowing, and worth re-running the harness against Gecko.
- Should the token be shared with the existing status page and API routes, or
  scoped to the streaming ones? Shared is simpler and closes a hole that is
  already open; scoped avoids changing the behaviour of a surface that is
  working today.
- One stream at a time is assumed app-wide. Switching panels no longer trips
  over it (see milestone 5), but the underlying fragility is unchanged. A browser tab left open holds the slot indefinitely,
  and the only thing that frees it is that socket closing. This bit repeatedly
  during transport testing: a forgotten tab locked out every later request with
  a 400. Before a show floor sees it, the slot needs either an idle timeout, or
  a newer request that takes the stream from an older one, or both. Two
  operators with two tablets makes it worse, not different.
