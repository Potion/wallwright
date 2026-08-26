// The three pages the app generates for itself: a placeholder for a panel with no
// URL, a diagnostic for one the watchdog gave up on, and the fatal-config screen.
// No electron import, so test/pages.test.js can exercise them directly.
//
// Extracted because `escapeHtml` is the only thing standing between an
// operator-supplied label or URL and a `data:` document, and it had no test at
// all. `src/control-page.js` is the precedent: the same job, already at full
// coverage.
//
// These are `data:` URLs loaded straight from the main process, which is why the
// scheme allow-list in src/policy.js does not apply to them, and why they are the
// one place inline styles are still used - a `data:` document has an opaque
// origin and no stylesheet to link to.

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Everything here is loaded this way rather than written to a temp file, so the
// page cannot be tampered with between being built and being shown, and there is
// nothing to clean up.
function dataUrl(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// A panel with no URL. It says how to fix it, because the person looking at the
// wall is the person who can.
function placeholderPage(v) {
  return `<body style="margin:0;height:100vh;display:flex;align-items:center;
    justify-content:center;background:#0d1117;color:#8b949e;
    font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;text-align:center">
    <div><div style="color:#f04e23;font-weight:600;margin-bottom:8px">
    ${escapeHtml(v.label || v.id)}</div>
    No URL set. Select this panel in layout edit mode and enter one.</div></body>`;
}

// The watchdog has stopped trying. `now` is passed in rather than read here so the
// page is a pure function of its inputs and can be tested without freezing time.
function unrecoverablePage(v, w, { retryMs, now = new Date() } = {}) {
  const retry = retryMs
    ? `Retrying every ${Math.round(retryMs / 60000)} minutes.`
    : 'Not retrying.';
  return `<body style="margin:0;height:100vh;display:flex;align-items:center;
    justify-content:center;background:#0d1117;color:#8b949e;
    font:15px/1.6 -apple-system,Helvetica,Arial,sans-serif;text-align:center">
    <div style="max-width:80%">
    <div style="color:#f04e23;font-weight:600;font-size:19px;margin-bottom:12px">
    ${escapeHtml(v.label || v.id)} could not be loaded</div>
    <div style="font-family:ui-monospace,Menlo,monospace;color:#e6edf3;
    word-break:break-all;margin-bottom:12px">${escapeHtml(v.url || '(no URL set)')}</div>
    <div>${escapeHtml(w.lastError || 'unknown error')}</div>
    <div style="margin-top:12px">Gave up after ${w.round + 1} rounds
    at ${escapeHtml(now.toLocaleTimeString())}. ${retry}</div>
    </div></body>`;
}

// Shown instead of a stack trace when the config will not load. The config path is
// on it because that is the first thing anyone needs to know.
function fatalPage(appName, message, configPath) {
  return `<body style="margin:0;padding:32px;background:#0d1117;color:#e6edf3;
    font:14px/1.5 ui-monospace,Menlo,monospace">
    <h1 style="font:600 20px sans-serif;color:#f04e23;margin:0 0 16px">${escapeHtml(appName)} cannot start</h1>
    <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
    <p style="color:#8b949e">Config: ${escapeHtml(configPath)}</p></body>`;
}

module.exports = {
  escapeHtml,
  dataUrl,
  placeholderPage,
  unrecoverablePage,
  fatalPage,
};
