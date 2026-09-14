// Local mock dashboard server for development only. Never shipped to the wall.
//
// Serves four fake dashboards over http (not file://) so cookies and the
// `persist:` session partitions behave the way the real Honeywell apps will.
// Each page exercises one behavior the wall depends on: session persistence,
// Esc handling, an SSO-style popup, and per-panel zoom legibility.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.WALLWRIGHT_MOCK_PORT || 8787);
const ROOT = path.join(__dirname, 'mock');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Fake login: POST /login sets a session cookie, GET /whoami reports it.
// Deliberately trivial; the point is only to prove the cookie survives.
function handleLogin(req, res, url) {
  const user = url.searchParams.get('user') || 'operator';
  res.writeHead(302, {
    'Set-Cookie': `ww_mock_session=${encodeURIComponent(user)}; Path=/; Max-Age=86400; SameSite=Lax`,
    Location: url.searchParams.get('next') || '/dash-1.html',
  });
  res.end();
}

// A redirect chain. /login can already issue one 302, but it takes `next` raw and
// cannot express a chain, and a chain is the interesting case: the question is
// what the main process is told about the hops in the middle, not the last one.
//   /redirect?to=/dash-2.html&n=3  ->  302, 302, 302, then /dash-2.html
function handleRedirect(req, res, url) {
  const to = url.searchParams.get('to') || '/dash-1.html';
  const n = Number(url.searchParams.get('n') || 1);
  const next = n > 1 ? `/redirect?to=${encodeURIComponent(to)}&n=${n - 1}` : to;
  res.writeHead(302, { Location: next });
  res.end();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

// id -> { frames, at }. Last report wins; the reader takes two and divides.
const fpsReports = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/login') return handleLogin(req, res, url);

  if (url.pathname === '/redirect') return handleRedirect(req, res, url);

  // A 302 whose destination is NOT written in the request URL. This is the shape
  // that matters: an origin policy inspecting the URL a page asked for cannot see
  // where the server is about to send it. A session that has expired and bounces
  // to an identity provider looks exactly like this.
  if (url.pathname === '/sso-bounce') {
    res.writeHead(302, { Location: '/dash-4.html' });
    return res.end();
  }

  // Frame-rate reports from soak-heavy.html, and only when it is asked for with
  // ?fps=1. Off by default so the 72h soak measures exactly what it always did.
  //
  // This is what makes the wall's own smoothness observable from outside the
  // app. The tablet control surface can be measured against it: attach a stream
  // and see whether the number moves. See src/dev/stream-cost.js.
  if (url.pathname === '/fps') {
    const id = url.searchParams.get('id') || 'panel';
    // Every numeric field the page chose to send, not just frames. globe.html
    // rides along with its drag figures, which are the thing that page exists to
    // measure.
    const report = { at: Date.now() };
    for (const [k, v] of url.searchParams) {
      if (k !== 'id') report[k] = Number.isFinite(Number(v)) ? Number(v) : v;
    }
    fpsReports.set(id, report);
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/fps-state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(Object.fromEntries(fpsReports)));
  }

  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: readCookie(req, 'ww_mock_session') }));
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': 'ww_mock_session=; Path=/; Max-Age=0',
      Location: '/dash-1.html',
    });
    return res.end();
  }

  const name = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found: ' + name);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // Never cached. These files are edited while the wall is running and a
      // panel is holding them, and a stale copy is a genuinely confusing bug:
      // the page looks right, behaves like an older version, and a reload does
      // not help because the reload is served from cache too.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] serving ${ROOT} at http://localhost:${PORT}`);
});
