// A small HTTP surface for administrators.
//
// Only administrators have keyboard, mouse and remote access, and without this
// "change a URL" means an RDP session and a keyboard at the wall. Both Userful
// and Hiperwall offer browser and phone control for the same reason, and
// Hiperwall exposes an API so other systems can drive the wall; this is the
// small version of both.
//
// Deliberately unauthenticated and bound to loopback by default. It can drive
// the wall, so exposing it on a LAN is a decision to make on purpose, not by
// accident. There is no auth to get wrong because there is no auth: the guard
// is the bind address.
//
// No dependencies. This runs on a show PC that must not need a package install
// to come up.

const http = require('node:http');

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // nothing here is big
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null); // signals a malformed body
      }
    });
  });
}

// `actions` is supplied by the main process: this file knows nothing about
// Electron, which keeps it readable and testable on its own.
function createControlServer(actions, options = {}) {
  const log = options.log || (() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = actions.page();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        });
        return res.end(html);
      }

      if (req.method === 'GET' && path === '/api/status') {
        return json(res, 200, actions.status());
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return json(res, 400, { error: 'body is not valid JSON' });

        if (path === '/api/preset') {
          if (!body.id) return json(res, 400, { error: 'id is required' });
          const ok = actions.applyPreset(String(body.id));
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such preset' });
        }

        if (path === '/api/panel') {
          if (!body.id) return json(res, 400, { error: 'id is required' });
          const ok = actions.updatePanel(String(body.id), body.patch || {});
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such panel' });
        }

        if (path === '/api/promote') {
          const ok = actions.promote(body.id === undefined ? null : String(body.id));
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such panel' });
        }

        if (path === '/api/reload') {
          const ok = actions.reload(body.id === undefined ? null : String(body.id));
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such panel' });
        }

        // Rebuilds the view rather than reloading the document, which is the only
        // way to hand a renderer process back. It also loses sessionStorage, so it
        // is the thing to press when a panel is wedged, and the thing to test a
        // dashboard against before turning recycleMs on for it.
        if (path === '/api/recycle') {
          const ok = actions.recycle(body.id === undefined ? null : String(body.id));
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such panel' });
        }
      }

      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (e) {
      log(`control server error on ${req.method} ${path}: ${e.message}`);
      json(res, 500, { error: e.message });
    }
  });

  return server;
}

module.exports = { createControlServer };
