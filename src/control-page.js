// The control surface's status page.
//
// A constant string with no interpolation, and no inline event handlers: every
// button carries data- attributes and one delegated listener reads them. The
// first version built onclick="..." into the markup, which meant JavaScript
// quoted inside HTML quoted inside a template literal, and the escaping
// collapsed and shipped a page that could not parse. Data attributes remove the
// nesting entirely.
//
// Plain HTML, no build step, no dependencies, served from memory: it has to work
// on a show PC from a browser or a phone with nothing installed.

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallwright control</title>
<style>
  /* The same palette, with the same token names, as src/overlay.html.
     docs/identity.md says what each one is for. */
  :root {
    color-scheme: dark;
    --accent:#f04e23; --accent-rgb:240,78,35;
    --ground:#0d1117; --surface:#161b22; --surface-raised:#21262d;
    --text:#e6edf3; --muted:#8b949e; --line:#30363d;
    --warn:#ffa198; --alarm:#f85149; --alarm-rgb:248,81,73;
  }
  body { margin:0; padding:20px; background:var(--ground); color:var(--text);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif; }
  /* Wordmark: mark, name, then the mode it is in. Mono and letterspaced, as on
     the wall's own edit bar, so the two admin surfaces read as one tool. */
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:5px; }
  .brand svg { display:block; width:22px; height:22px; flex:none; }
  h1 { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:15px;
    font-weight:600; letter-spacing:0.16em; text-transform:uppercase;
    margin:0; }
  #mode { font:13px/1.5 inherit; font-family:inherit; letter-spacing:0.08em;
    color:var(--accent); }
  .sub { color:var(--muted); margin-bottom:18px; font-size:13px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
  button { font:inherit; padding:8px 13px; border-radius:7px; cursor:pointer;
    background:var(--surface-raised); color:var(--text); border:1px solid var(--line); }
  button:hover { border-color:var(--accent); }
  button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .panel { border:1px solid var(--line); border-radius:9px; padding:14px;
    margin-bottom:11px; background:var(--surface); }
  .panel h2 { font-size:15px; margin:0 0 3px; }
  .meta { color:var(--muted); font-size:12.5px; word-break:break-all; margin-bottom:9px; }
  .warn { color:var(--warn); }
  input { font:inherit; width:100%; box-sizing:border-box; padding:8px 10px;
    margin-bottom:8px; border-radius:7px; border:1px solid var(--line);
    background:var(--ground); color:var(--text); }
  .err { background:rgba(var(--alarm-rgb),0.12); border:1px solid var(--alarm);
    padding:9px 12px; border-radius:7px; margin-bottom:14px; }
  .settings { border:1px solid var(--line); border-radius:9px; padding:14px;
    margin-bottom:11px; background:var(--surface); }
  .settings h2 { font-size:15px; margin:0 0 11px; }
  .srow { display:flex; align-items:center; gap:10px; margin-bottom:9px; flex-wrap:wrap; }
  .srow > label { flex:0 0 auto; min-width:150px; }
  .srow input[type=number] { width:110px; margin:0; }
  .srow input[type=checkbox] { width:16px; height:16px; margin:0;
    accent-color:var(--accent); }
  .note { color:var(--muted); font-size:12.5px; }
  .dirty { color:var(--accent); font-size:12.5px; }
</style>

<div class="brand">
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="14.7" y="2" width="7.3" height="11.5" fill="var(--accent)" opacity="0.4"/>
    <rect x="2" y="14.7" width="5.2" height="7.3" fill="var(--accent)" opacity="0.4"/>
    <rect x="8.4" y="14.7" width="13.6" height="7.3" fill="var(--accent)" opacity="0.4"/>
    <rect x="2" y="2" width="11.5" height="11.5" fill="var(--accent)"/>
  </svg>
  <h1>Wallwright</h1>
  <span id="mode"></span>
</div>
<div class="sub" id="sub"></div>
<div id="err"></div>
<div id="pressure"></div>
<div class="row" id="presets"></div>
<div class="row">
  <button data-action="grid">Back to grid</button>
  <button data-action="reload-all">Reload every panel</button>
</div>
<div id="settings"></div>
<div id="panels"></div>

<script>
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function post(path, body, onOk) {
    if (busy) return;
    busy = true;
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || r.statusText);
          return j;
        });
      })
      .then(function (j) {
        $('err').innerHTML = '';
        if (onOk) onOk();
        draw(j);
      })
      .catch(function (e) {
        $('err').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
      })
      .then(function () {
        busy = false;
      });
  }

  // One listener for every button. Each says what it does in data attributes,
  // so nothing has to be quoted into the markup.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!b) return;
    var id = b.getAttribute('data-id');
    var action = b.getAttribute('data-action');
    if (action === 'preset') post('/api/preset', { id: id });
    else if (action === 'promote') post('/api/promote', { id: id });
    else if (action === 'reload') post('/api/reload', { id: id });
    else if (action === 'recycle') post('/api/recycle', { id: id });
    else if (action === 'grid') post('/api/promote', {});
    else if (action === 'reload-all') post('/api/reload', {});
    else if (action === 'save-settings') saveSettings();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var input = e.target.closest ? e.target.closest('input[data-id]') : null;
    if (!input) return;
    post('/api/panel', {
      id: input.getAttribute('data-id'),
      patch: { url: input.value },
    });
  });

  // Anything typed into the settings box stops the three-second poll from
  // redrawing that box underneath the person typing. The focus guard in refresh()
  // is not enough on its own: a checkbox loses focus the instant it is clicked,
  // so a tick would be reverted by the very next poll.
  var settingsDirty = false;

  function markDirty() {
    settingsDirty = true;
    var el = $('sdirty');
    if (el) el.textContent = 'unsaved';
  }
  document.addEventListener('input', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-setting')) markDirty();
  });
  document.addEventListener('change', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-setting')) markDirty();
  });

  function saveSettings() {
    var nodes = document.querySelectorAll('[data-setting]');
    var patch = {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var key = n.getAttribute('data-setting');
      if (n.type === 'checkbox') {
        patch[key] = n.checked;
        continue;
      }
      // The server validates as well, and its answer is the one that counts.
      // This only stops an empty field being posted as 0, which is a real
      // setting meaning "no limit" rather than "unset".
      if (n.value === '' || isNaN(Number(n.value))) {
        $('err').innerHTML = '<div class="err">' + esc(key) + ' must be a number</div>';
        return;
      }
      patch[key] = Number(n.value);
    }
    post('/api/settings', { patch: patch }, function () {
      settingsDirty = false;
    });
  }

  // Reports the operating system's answer beside the configured one. A box that
  // will not stay ticked has to be able to say why, or the setting reads as
  // broken.
  function autoStartNote(as) {
    if (!as) return '';
    if (as.blocked) return '<span class="warn">inert: ' + esc(as.reason) + '</span>';
    if (as.effective !== as.configured) {
      return '<span class="warn">the system says ' + (as.effective ? 'on' : 'off') + '</span>';
    }
    return '<span class="note">' + (as.effective ? 'registered' : 'not registered') + '</span>';
  }

  function drawSettings(s) {
    var st = s.settings || {};
    $('settings').innerHTML =
      '<div class="settings">' +
      '<h2>Settings</h2>' +
      '<div class="srow">' +
        '<label for="mlim">Memory limit</label>' +
        '<input type="number" min="0" step="50" id="mlim" data-setting="memoryLimitMb" value="' +
          esc(st.memoryLimitMb) + '">' +
        '<span class="note">MB &middot; 0 turns the countermeasure off</span>' +
      '</div>' +
      '<div class="srow">' +
        '<label for="mhard">Hard limit</label>' +
        '<input type="number" min="0" step="50" id="mhard" data-setting="memoryHardLimitMb" value="' +
          esc(st.memoryHardLimitMb) + '">' +
        '<span class="note">MB &middot; must be above the limit &middot; 0 = none</span>' +
      '</div>' +
      '<div class="srow">' +
        '<label for="autostart">Start at login</label>' +
        '<input type="checkbox" id="autostart" data-setting="autoStart"' +
          (st.autoStart ? ' checked' : '') + '>' +
        autoStartNote(s.autoStart) +
      '</div>' +
      '<div class="srow">' +
        '<button data-action="save-settings">Save</button>' +
        '<span class="dirty" id="sdirty"></span>' +
      '</div>' +
      '</div>';
  }

  function draw(s) {
    $('mode').textContent = s.mode;
    var byType = s.memoryByType || {};
    var split = Object.keys(byType)
      .sort(function (a, b) { return byType[b] - byType[a]; })
      .map(function (t) { return t + ' ' + byType[t]; })
      .join(', ');
    $('sub').textContent =
      s.panels.length + ' panels \\u00b7 ' + s.memoryMb + 'MB' +
      (s.memoryPeakMb ? ' (peak ' + s.memoryPeakMb + ')' : '') +
      (split ? ' \\u00b7 ' + split : '') +
      ' \\u00b7 up ' + Math.floor(s.uptimeSec / 60) + 'm \\u00b7 ' +
      s.wall.width + 'x' + s.wall.height + ' at ' + s.wall.scale + 'x' +
      (s.counters ? ' \\u00b7 ' + s.counters.crashes + ' crashes, ' +
        s.counters.watchdogReloads + ' watchdog reloads, ' +
        s.counters.recycles + ' recycles' : '');
    // Deliberately NOT #err. That one belongs to the last POST and nothing else
    // may clear it: this function runs every three seconds, so writing here used
    // to erase a refusal before anyone had read it. The settings box refuses
    // patches by design - a hard limit under the soft limit, a key that is not a
    // setting - so a message with a three-second life is not good enough.
    $('pressure').innerHTML = s.memoryPressure
      ? '<div class="err">Over the memory limit for ' + s.memoryPressureSec +
        's. The wall is recycling idle panels.</div>'
      : '';

    if (!settingsDirty) drawSettings(s);

    $('presets').innerHTML = s.presets.length
      ? s.presets
          .map(function (p) {
            return '<button data-action="preset" data-id="' + esc(p.id) + '" class="' +
              (p.id === s.activePreset ? 'on' : '') + '">' + esc(p.name) + '</button>';
          })
          .join('')
      : '<span class="sub">No saved montages</span>';

    $('panels').innerHTML = s.panels
      .map(function (p) {
        // Flag a panel that has wandered from its configured URL, or that the
        // watchdog has been fighting with.
        var drifted = p.currentUrl && p.url && p.currentUrl !== p.url;
        var notes = [];
        if (p.crashed) notes.push('<span class="warn">renderer gone</span>');
        if (p.gaveUp) {
          notes.push('<span class="warn">unrecoverable: ' + esc(p.lastError) + '</span>');
        }
        if (p.memoryMb) notes.push(p.memoryMb + 'MB' + (p.pidShared ? ' (shared)' : ''));
        // Cumulative, so a panel that crashed and recovered overnight still says so.
        if (p.crashes) notes.push('<span class="warn">' + p.crashes + ' crashes</span>');
        if (p.recycleCount) notes.push(p.recycleCount + ' recycles');
        if (p.loading) notes.push('loading');
        if (p.reloadAttempts) {
          notes.push('<span class="warn">' + p.reloadAttempts + ' reload attempts</span>');
        }
        if (p.reloadDeferred) notes.push('reload deferred, in use');
        if (p.lastUsedSecAgo !== null) notes.push('used ' + p.lastUsedSecAgo + 's ago');

        return '<div class="panel">' +
          '<h2>' + esc(p.label || p.id) + '</h2>' +
          '<div class="meta">' + esc(p.id) + ' \\u00b7 ' +
            p.grid.width + 'x' + p.grid.height + ' at ' + p.grid.x + ',' + p.grid.y +
            ' \\u00b7 zoom ' + p.zoom +
            (notes.length ? ' \\u00b7 ' + notes.join(' \\u00b7 ') : '') +
            (drifted ? '<br><span class="warn">now at ' + esc(p.currentUrl) + '</span>' : '') +
          '</div>' +
          '<input value="' + esc(p.url) + '" data-id="' + esc(p.id) + '">' +
          '<button data-action="promote" data-id="' + esc(p.id) + '">Open fullscreen</button> ' +
          '<button data-action="reload" data-id="' + esc(p.id) + '">Reload</button> ' +
          '<button data-action="recycle" data-id="' + esc(p.id) + '">Rebuild</button>' +
          '</div>';
      })
      .join('');
  }

  function refresh() {
    // Do not stomp on a URL someone is halfway through typing.
    if (busy || document.activeElement.tagName === 'INPUT') return;
    fetch('/api/status')
      .then(function (r) { return r.json(); })
      .then(draw)
      .catch(function () {});
  }

  refresh();
  setInterval(refresh, 3000);
</script>`;

// ---- the tablet surface -----------------------------------------------------
//
// Which transport the tablet should use, given what its <img> has done so far.
//
// Defined here as a function and injected into the page below by name, so there
// is exactly one copy of the rule: the tests exercise this one, and the browser
// runs this one. A second inline copy would drift the first time either changed.
//
// The measured engine behaviour is in docs/tablet-control-surface-plan.md.
// WebKit and Blink both decode multipart in an <img> and fire load. An engine
// that cannot either fires error or does nothing at all, and the two need
// different detection: error is immediate, doing nothing is only visible as time
// passing. Hence a timeout as well as an error handler.
function transportDecision(state) {
  // Checked before `loaded`, so a stream that broke after its first frame falls
  // back rather than sitting on a still image and calling it live.
  if (state.errored) return 'poll';
  if (state.loaded) return 'stream';
  if (state.elapsedMs >= state.timeoutMs) return 'poll';
  return 'waiting';
}

// Where on the panel a touch landed, in the panel's own window-pixel space.
//
// Measured against the rendered frame rather than the element box: the frame is
// capped at 1600x1200 by the screencast and the element is whatever the tablet's
// screen allows, so neither matches the panel and the two do not match each
// other. Working in fractions makes all three irrelevant except `rect`, which is
// the only one the wall agrees with.
//
// `box` is the element's rectangle, `natural` the frame's own pixel size, `rect`
// the panel's size in window pixels from /api/status. object-fit: contain means
// the frame is letterboxed inside the box, so the offset has to come out before
// the fraction goes in, or every click is skewed toward the centre.
function touchToPanel(point, box, natural, rect) {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const drawnW = natural.width * scale;
  const drawnH = natural.height * scale;
  const padX = (box.width - drawnW) / 2;
  const padY = (box.height - drawnH) / 2;
  const fx = (point.x - box.left - padX) / drawnW;
  const fy = (point.y - box.top - padY) / drawnH;
  return {
    x: Math.round(fx * rect.width),
    y: Math.round(fy * rect.height),
    // A touch in the letterbox is not a touch on the panel. Reporting it would
    // clamp to an edge and click something the operator never aimed at.
    inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1,
  };
}

const TOUCH_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Wallwright touch</title>
<style>
  /* Same tokens as src/overlay.html and the status page above. */
  :root {
    color-scheme: dark;
    --accent:#f04e23; --ground:#0d1117; --surface:#161b22; --surface-raised:#21262d;
    --text:#e6edf3; --muted:#8b949e; --line:#30363d; --alarm:#f85149;
  }
  html,body { height:100%; }
  body { margin:0; background:var(--ground); color:var(--text);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;
    display:flex; flex-direction:column; }
  #bar { display:flex; align-items:center; gap:12px; padding:10px 14px;
    border-bottom:1px solid var(--line); background:var(--surface); flex:none;
    flex-wrap:wrap; }
  #name { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px;
    letter-spacing:0.12em; text-transform:uppercase; }
  #picker { display:flex; gap:6px; flex-wrap:wrap; }
  /* Sized for a finger, not a mouse: this is the one part of the page an
     operator actually presses. */
  #picker button { font:inherit; font-size:13px; padding:7px 12px; border-radius:6px;
    border:1px solid var(--line); background:var(--surface-raised); color:var(--text);
    cursor:pointer; touch-action:manipulation; }
  #picker button.on { border-color:var(--accent); color:var(--accent); }
  #q, #fit { font:inherit; font-size:13px; padding:7px 12px; border-radius:6px;
    border:1px solid var(--line); background:var(--surface-raised); color:var(--text);
    cursor:pointer; touch-action:manipulation; }
  #fit { border-color:var(--accent); color:var(--accent); }
  #kb { font:inherit; font-size:13px; padding:7px 12px; border-radius:6px;
    border:1px solid var(--line); background:var(--surface-raised); color:var(--text);
    cursor:pointer; touch-action:manipulation; }
  #kb.on { border-color:var(--accent); color:var(--accent); }
  #keys { flex:none; padding:8px 14px; border-top:1px solid var(--line);
    background:var(--surface); }
  /* 16px or iOS zooms the whole page when the field takes focus. */
  #field { width:100%; box-sizing:border-box; font:16px/1.4 inherit; padding:10px 12px;
    border-radius:7px; border:1px solid var(--line); background:var(--ground);
    color:var(--text); }
  #field:focus { outline:none; border-color:var(--accent); }
  #mode { font-size:12px; color:var(--muted); margin-left:auto; }
  #mode.poll { color:var(--accent); }
  #mode.dead { color:var(--alarm); }
  #stage { flex:1; min-height:0; display:flex; align-items:center;
    justify-content:center; overflow:hidden; padding:8px; }
  /* touch-action so the browser does not swallow gestures as page scroll. */
  #view { max-width:100%; max-height:100%; touch-action:none;
    border:1px solid var(--line); background:var(--surface);
    transform-origin:center center; }
</style>
<div id="bar">
  <span id="name"></span>
  <div id="picker"></div>
  <button id="q" type="button">Quality</button>
  <button id="fit" type="button" hidden>Fit</button>
  <button id="kb" type="button">Keyboard</button>
  <span id="mode">connecting</span>
</div>
<div id="stage"><img id="view" alt=""></div>
<div id="keys" hidden>
  <input id="field" type="text" autocapitalize="off" autocorrect="off"
    autocomplete="off" spellcheck="false" enterkeyhint="send"
    placeholder="typing here goes to the panel, not to this page">
</div>
<script>
${transportDecision.toString()}
${touchToPanel.toString()}

(function () {
  var img = document.getElementById('view');
  var modeEl = document.getElementById('mode');
  var nameEl = document.getElementById('name');
  var pickerEl = document.getElementById('picker');

  var STREAM_TIMEOUT_MS = 2500;
  var POLL_MS = 500;
  var POLL_BACKOFF_MS = 1500;
  // Long enough for the server to notice the old socket closed and free the one
  // stream slot. Asking for the new stream before that is answered with a 400,
  // which the transport probe would read as "this browser cannot stream" and
  // drop to polling for the rest of the session.
  var RELEASE_MS = 150;
  var STATUS_MS = 3000;
  // Used both for retrying a dead server and for re-attaching a stream that
  // dropped. Short enough that a restart is barely noticed.
  var RETRY_MS = 1500;

  var id = new URLSearchParams(location.search).get('id') || '';
  var rect = null;

  // Bumped on every switch, and checked by everything that can outlive one. A
  // polling chain, a pending stream load and a transport timeout all belong to
  // the panel that started them; left running, a stale one fights the new panel
  // for the single image element and wins at random.
  var session = 0;
  var started = 0;
  var loaded = false;
  var errored = false;
  var settled = false;

  function setMode(text, cls) {
    modeEl.textContent = text;
    modeEl.className = cls || '';
  }

  // Built with DOM calls rather than markup: panel ids and labels come from the
  // config file, and this way there is no escaping to get wrong.
  function drawPicker(panels) {
    pickerEl.textContent = '';
    panels.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label || p.id;
      b.setAttribute('data-id', p.id);
      if (p.id === id) b.className = 'on';
      pickerEl.appendChild(b);
    });
  }

  // One delegated listener, as on the status page.
  pickerEl.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-id]') : null;
    if (b) attach(b.getAttribute('data-id'));
  });

  // The status poll doubles as the heartbeat that drives reconnection.
  //
  // The app restarts - a deploy, a crash, somebody pressing Rebuild - and the
  // stream socket dies with it. The <img> cannot notice on its own: a multipart
  // stream that ended is indistinguishable from one that has merely gone quiet,
  // which is the ordinary state of a still dashboard, so nothing fires and the
  // tablet sits on a frozen picture believing it is live. Polling mode recovered
  // by itself because each still is a fresh request that fails and retries; the
  // stream had no such path at all.
  //
  // So this is the signal. While the poll fails the surface says so, and the
  // first poll that succeeds re-attaches from scratch.
  //
  // Not session-guarded on purpose: it looks the panel up by whatever id is
  // current when the answer arrives, so a reply that crosses a switch still
  // carries the right rect.
  var serverUp = true;
  var pollTimer = null;

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(readStatus, ms);
  }

  function readStatus() {
    fetch('/api/status')
      .then(function (r) {
        // A 5xx from a half-started app is as much "not ready" as a dead socket.
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      })
      .then(function (s) {
        drawPicker(s.panels);
        var p = s.panels.filter(function (x) { return x.id === id; })[0];
        if (p) rect = p.rect;
        if (!serverUp) {
          serverUp = true;
          // Whatever the old socket was doing, it belonged to a process that is
          // gone. attach() tears it down and starts again, which also re-runs
          // the transport probe: the new process need not behave like the old.
          if (id) attach(id);
        }
        schedulePoll(STATUS_MS);
      })
      .catch(function () {
        if (serverUp) {
          serverUp = false;
          setMode('reconnecting', 'dead');
        }
        // Faster while it is down. Coming back promptly is the whole point, and
        // a request to a closed port is cheap.
        schedulePoll(RETRY_MS);
      });
  }

  // A stream that errors AFTER it had settled has died on us. Re-attach, but on
  // a timer and never more than one in flight: if the app is genuinely gone this
  // would otherwise spin, and the heartbeat above is what recovers properly.
  var reconnectTimer = null;
  function reconnectSoon(mine) {
    if (mine !== session || reconnectTimer) return;
    setMode('reconnecting', 'dead');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (mine === session && id) attach(id);
    }, RETRY_MS);
  }

  function decide(mine) {
    if (mine !== session || settled) return;
    var d = transportDecision({
      loaded: loaded,
      errored: errored,
      elapsedMs: Date.now() - started,
      timeoutMs: STREAM_TIMEOUT_MS
    });
    if (d === 'waiting') return;
    settled = true;
    if (d === 'stream') { setMode('streaming'); return; }
    poll(mine);
  }

  function poll(mine) {
    setMode('polling', 'poll');
    // Let go of the stream socket before opening anything else, or it holds the
    // slot for as long as this page is open.
    img.removeAttribute('src');
    var tick = function () {
      if (mine !== session) return;
      img.onload = function () { if (mine === session) setTimeout(tick, POLL_MS); };
      img.onerror = function () { if (mine === session) setTimeout(tick, POLL_BACKOFF_MS); };
      img.src =
        '/api/frame?id=' +
        encodeURIComponent(id) +
        '&q=' +
        PRESETS[preset].q +
        '&w=' +
        PRESETS[preset].w +
        '&t=' +
        Date.now();
    };
    tick();
  }

  // The only way a panel is ever selected, including the first one.
  function attach(next) {
    if (!next) return;
    session++;
    var mine = session;
    id = next;
    // A rect belongs to the panel it came from. Keeping the old one would place
    // every touch on the new panel using the old panel's geometry.
    rect = null;
    loaded = false;
    errored = false;
    settled = false;
    started = Date.now();

    // Both transports drive the same element, so clearing it cancels a stream
    // socket and a polling chain alike.
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');

    nameEl.textContent = id;
    setMode('connecting');
    // A zoom belongs to the panel it was set on.
    resetView();
    // Keeps the address bar honest, so a reload comes back to the same panel and
    // the link is worth sending to somebody.
    history.replaceState(null, '', '?id=' + encodeURIComponent(id));
    readStatus();

    setTimeout(function () {
      if (mine !== session) return;
      img.onload = function () { if (mine === session) { loaded = true; decide(mine); } };
      img.onerror = function () {
        if (mine !== session) return;
        // Before the probe settles, an error means "this browser cannot stream"
        // and the fallback handles it. After it settles the stream was working
        // and has now stopped, which is a different thing and wants a reconnect.
        if (settled) return reconnectSoon(mine);
        errored = true;
        decide(mine);
      };
      img.src =
        '/api/stream?id=' +
        encodeURIComponent(id) +
        '&q=' +
        PRESETS[preset].q +
        '&w=' +
        PRESETS[preset].w;
      // The engine that renders nothing and reports nothing is only detectable
      // as time passing, so the decision has to be driven as well as awaited.
      setTimeout(function () { decide(mine); }, STREAM_TIMEOUT_MS + 50);
    }, RELEASE_MS);
  }

  // ---- input ----------------------------------------------------------------

  // A drag fires dozens of moves a second and each one would be a POST, so moves
  // are coalesced. Everything else goes immediately.
  //
  // Not requestAnimationFrame, which was the first attempt: rAF does not run at
  // all while a page is hidden, and a tablet that had been backgrounded for a
  // moment would stack up taps and deliver none of them. Measured in Chrome with
  // the window occluded - visibilityState 'hidden', rAF never fired, every
  // queued event stranded. A tap must not wait on a frame that may not come.
  var queue = [];
  var timer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, 32);
    fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, events: batch })
    }).catch(function () {});
  }

  function send(kind, ev, extra) {
    if (!rect || !img.naturalWidth) return;
    var box = img.getBoundingClientRect();
    var at = touchToPanel(
      { x: ev.clientX, y: ev.clientY },
      box,
      { width: img.naturalWidth, height: img.naturalHeight },
      rect
    );
    if (!at.inside) return;
    var e = { kind: kind, x: at.x, y: at.y };
    if (extra) for (var k in extra) e[k] = extra[k];
    queue.push(e);
    // A down, an up or a wheel is a thing the operator did and expects to see
    // answered. Only a move is worth holding back.
    if (kind !== 'move') return flush();
    if (!timer) timer = setTimeout(flush, 16);
  }

  img.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      // The first finger already sent a press. Release it, or the panel is left
      // holding a button down for the whole gesture.
      send('up', ev);
      var pts = Array.from(pointers.values());
      pinch = {
        spread: spread(pts[0], pts[1]),
        middle: middle(pts[0], pts[1]),
        scale: scale,
        panX: panX,
        panY: panY,
      };
      return;
    }
    if (pointers.size > 2) return;
    // The input goes out before pointer capture is attempted, and the capture is
    // guarded. Capture is a convenience - it keeps a drag alive when the finger
    // leaves the image - but it can throw, and a throw here would abort the
    // handler before the press was ever sent. A tap that silently does nothing
    // is far worse than a drag that stops at the edge.
    send('move', ev);
    send('down', ev, { clickCount: ev.detail === 2 ? 2 : 1 });
    try {
      img.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* not worth failing a tap over */
    }
  });
  img.addEventListener('pointermove', function (ev) {
    if (pointers.has(ev.pointerId)) {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (pinch && pointers.size >= 2) {
      var pts = Array.from(pointers.values());
      var now = spread(pts[0], pts[1]);
      var mid = middle(pts[0], pts[1]);
      if (pinch.spread > 0) {
        // Clamped: below 1 the image would shrink inside a box that already fits
        // it, and past 8 a wall pixel is bigger than a fingertip.
        scale = Math.min(8, Math.max(1, (pinch.scale * now) / pinch.spread));
      }
      panX = pinch.panX + (mid.x - pinch.middle.x);
      panY = pinch.panY + (mid.y - pinch.middle.y);
      drawTransform();
      return;
    }
    if (ev.buttons) send('move', ev);
  });
  function lift(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
  }
  img.addEventListener('pointercancel', lift);
  img.addEventListener('pointerup', function (ev) {
    ev.preventDefault();
    var wasGesture = pinch !== null || pointers.size > 1;
    lift(ev);
    // The up for a gesture was already sent when the second finger landed.
    if (!wasGesture) send('up', ev, { clickCount: ev.detail === 2 ? 2 : 1 });
  });
  img.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    send('wheel', ev, { deltaX: ev.deltaX, deltaY: ev.deltaY });
  }, { passive: false });

  // ---- quality --------------------------------------------------------------
  //
  // One control, not two, because the two are not independent in practice.
  //
  // Measured against a panel running WebGL, a canvas and a rotating globe - the
  // content class the exhibit actually uses - where every pixel changes every
  // frame and a JPEG cannot delta anything away:
  //
  //   q=90 w=1600   0.6 fps   3800 KB/s
  //   q=70 w=1600   2.2 fps   2287 KB/s
  //   q=40 w=640    8.7 fps    433 KB/s
  //
  // Width is the stronger lever: pixels dominate, and dropping them buys frame
  // rate and bandwidth together. Pairing the two into presets keeps an operator
  // from choosing the corner that is sharp, slow and expensive all at once.
  var PRESETS = [
    { name: 'smooth', q: 40, w: 640 },
    { name: 'normal', q: 70, w: 960 },
    { name: 'sharp', q: 90, w: 1600 },
  ];
  var preset = 1;
  var qEl = document.getElementById('q');

  function drawQuality() {
    qEl.textContent = 'View: ' + PRESETS[preset].name;
  }
  qEl.addEventListener('click', function () {
    preset = (preset + 1) % PRESETS.length;
    drawQuality();
    // The stream carries these as start-up parameters, so it has to be started
    // again for a change to take.
    if (id) attach(id);
  });
  drawQuality();

  // ---- pinch and pan --------------------------------------------------------
  //
  // Two fingers zoom and pan; one finger is input to the panel. The split is
  // what keeps them unambiguous: there is no gesture that could be either.
  //
  // The transform goes on the image, and the coordinate mapping needs no changes
  // at all for it. touchToPanel measures against getBoundingClientRect, which
  // already reports the transformed box, so a touch on a zoomed image maps
  // through the same fractions it always did.
  var fitEl = document.getElementById('fit');
  var scale = 1;
  var panX = 0;
  var panY = 0;
  var pointers = new Map();
  var pinch = null;

  function drawTransform() {
    img.style.transform =
      'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
    fitEl.hidden = scale === 1 && panX === 0 && panY === 0;
  }

  function resetView() {
    scale = 1;
    panX = 0;
    panY = 0;
    drawTransform();
  }
  fitEl.addEventListener('click', resetView);

  function spread(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function middle(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // ---- keyboard -------------------------------------------------------------
  //
  // A local field is the only way to raise a tablet's on-screen keyboard, but it
  // must never keep what is typed into it: these are logins. Every insertion is
  // forwarded and then cancelled, so the field is always empty, nothing is
  // retained on the tablet, and no autofill or autocorrect store ever sees it.
  //
  // The keys that matter here are the ones a password contains. Accents and
  // symbols do not arrive as key names - a long-press accent menu, dictation and
  // an IME all produce insertions, never keydowns - so text goes out as text and
  // only the non-printing keys go out by name.
  var kbEl = document.getElementById('kb');
  var keysEl = document.getElementById('keys');
  var fieldEl = document.getElementById('field');
  var keyboardOn = false;

  // Keys that produce no character, so they never appear as an insertion.
  // Backspace and Enter are here rather than read from beforeinput because the
  // field is always empty: there is nothing to delete, so no deletion event is
  // raised to notice.
  var NAMED = {
    Backspace: 1, Tab: 1, Enter: 1, Escape: 1, Delete: 1,
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1
  };

  function modsOf(ev) {
    var m = [];
    if (ev.shiftKey) m.push('shift');
    if (ev.ctrlKey) m.push('control');
    if (ev.altKey) m.push('alt');
    if (ev.metaKey) m.push('meta');
    return m;
  }

  function queueEvent(e) {
    if (!id) return;
    queue.push(e);
    flush();
  }

  function setKeyboard(on) {
    keyboardOn = on;
    keysEl.hidden = !on;
    kbEl.className = on ? 'on' : '';
    if (on) fieldEl.focus();
    else fieldEl.blur();
  }
  kbEl.addEventListener('click', function () { setKeyboard(!keyboardOn); });

  // An IME composes over several events and only the finished string is worth
  // sending. Forwarding the intermediate ones would type the phonetic spelling
  // into the panel and then leave it there.
  var composing = false;
  fieldEl.addEventListener('compositionstart', function () { composing = true; });
  fieldEl.addEventListener('compositionend', function (ev) {
    composing = false;
    if (ev.data) queueEvent({ kind: 'text', text: ev.data });
    fieldEl.value = '';
  });

  fieldEl.addEventListener('beforeinput', function (ev) {
    if (composing) return;
    if (ev.inputType === 'insertText' && ev.data) {
      queueEvent({ kind: 'text', text: ev.data });
    }
    // Cancelled whatever it was: the field stays empty, so a password is never
    // held by this page even for a moment.
    ev.preventDefault();
  });

  // Paste, from the tablet's own clipboard.
  //
  // This is the only path that gets at it. navigator.clipboard.readText needs a
  // secure context and the control surface is plain HTTP, but a paste event is
  // user-initiated so its clipboardData is readable anywhere. What arrives goes
  // straight across as text and is never written into the field.
  fieldEl.addEventListener('paste', function (ev) {
    var data = ev.clipboardData && ev.clipboardData.getData('text/plain');
    ev.preventDefault();
    if (data) queueEvent({ kind: 'paste', text: data });
  });

  // Clipboard and selection commands, which are NOT keystrokes: injecting the
  // chord reaches the page as a keydown and does nothing at all. These go over
  // as commands instead. Cmd+V is absent on purpose - the paste handler above
  // has already dealt with it, and sending both would paste twice from two
  // different clipboards.
  var EDIT_CHORDS = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' };

  fieldEl.addEventListener('keydown', function (ev) {
    if (composing) return;
    var command = (ev.ctrlKey || ev.metaKey) && EDIT_CHORDS[ev.key.toLowerCase()];
    if (command) {
      ev.preventDefault();
      return queueEvent({ kind: 'edit', command: command });
    }
    if (!NAMED[ev.key]) return;
    ev.preventDefault();
    queueEvent({ kind: 'key', key: ev.key, modifiers: modsOf(ev) });
  });

  // Tapping the panel moves the tablet's own focus off the field, which is
  // exactly what an operator does to put the cursor in a login box before
  // typing into it. Give the field its focus back so the next keystroke has
  // somewhere to go.
  img.addEventListener('pointerup', function () {
    if (keyboardOn) fieldEl.focus();
  });

  // ---- start ----------------------------------------------------------------

  readStatus();
  schedulePoll(STATUS_MS);
  if (id) {
    attach(id);
  } else {
    // No id is not an error: the picker is right there.
    nameEl.textContent = 'no panel';
    setMode('pick a panel', 'dead');
  }
})();
</script>`;

module.exports = {
  statusPage: () => PAGE,
  touchPage: () => TOUCH_PAGE,
  transportDecision,
  touchToPanel,
};
