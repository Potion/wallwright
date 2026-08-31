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

module.exports = { statusPage: () => PAGE };
