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
<title>Forge control</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:20px; background:#0d1117; color:#e6edf3;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h1 span { color:#f04e23; }
  .sub { color:#8b949e; margin-bottom:18px; font-size:13px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
  button { font:inherit; padding:8px 13px; border-radius:7px; cursor:pointer;
    background:#21262d; color:#e6edf3; border:1px solid #30363d; }
  button:hover { border-color:#f04e23; }
  button.on { background:#f04e23; border-color:#f04e23; color:#fff; }
  .panel { border:1px solid #30363d; border-radius:9px; padding:14px;
    margin-bottom:11px; background:#161b22; }
  .panel h2 { font-size:15px; margin:0 0 3px; }
  .meta { color:#8b949e; font-size:12.5px; word-break:break-all; margin-bottom:9px; }
  .warn { color:#ffa198; }
  input { font:inherit; width:100%; box-sizing:border-box; padding:8px 10px;
    margin-bottom:8px; border-radius:7px; border:1px solid #30363d;
    background:#0d1117; color:#e6edf3; }
  .err { background:#f851491f; border:1px solid #f85149; padding:9px 12px;
    border-radius:7px; margin-bottom:14px; }
</style>

<h1>Forge <span id="mode"></span></h1>
<div class="sub" id="sub"></div>
<div id="err"></div>
<div class="row" id="presets"></div>
<div class="row">
  <button data-action="grid">Back to grid</button>
  <button data-action="reload-all">Reload every panel</button>
</div>
<div id="panels"></div>

<script>
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function post(path, body) {
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
    else if (action === 'grid') post('/api/promote', {});
    else if (action === 'reload-all') post('/api/reload', {});
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

  function draw(s) {
    $('mode').textContent = s.mode;
    $('sub').textContent =
      s.panels.length + ' panels \\u00b7 ' + s.memoryMb + 'MB \\u00b7 up ' +
      Math.floor(s.uptimeSec / 60) + 'm \\u00b7 ' + s.wall.width + 'x' + s.wall.height +
      ' at ' + s.wall.scale + 'x';

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
          '<button data-action="reload" data-id="' + esc(p.id) + '">Reload</button>' +
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
