// Local mock dashboard server for development only. Never shipped to the wall.
//
// Serves four fake dashboards over http (not file://) so cookies and the
// `persist:` session partitions behave the way the real Honeywell apps will.
// Each page exercises one behavior the wall depends on: session persistence,
// Esc handling, an SSO-style popup, and per-panel zoom legibility.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.FORGE_MOCK_PORT || 8787);
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
    'Set-Cookie': `forge_mock_session=${encodeURIComponent(user)}; Path=/; Max-Age=86400; SameSite=Lax`,
    Location: url.searchParams.get('next') || '/dash-1.html',
  });
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/login') return handleLogin(req, res, url);

  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: readCookie(req, 'forge_mock_session') }));
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': 'forge_mock_session=; Path=/; Max-Age=0',
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
    });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] serving ${ROOT} at http://localhost:${PORT}`);
});
