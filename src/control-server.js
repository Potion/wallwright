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

// Nothing posted here is big, and an administrator is the only caller, so the cap
// is a misconfiguration guard rather than hardening.
const MAX_BODY_BYTES = 1e6;

// readBody resolves rather than rejects, because a rejection would land in the
// catch-all below and turn a client mistake into a 500. It signals failure three
// ways the caller must answer differently: `null` for malformed JSON, and these.
const TOO_LARGE = Symbol('body over the cap');
const ABORTED = Symbol('client went away mid-body');

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    // Every path below has to go through this. Resolving twice is harmless, but
    // 'close' fires after a normal 'end' too, so without the latch a good request
    // would be reported as aborted.
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Over the cap we stop accumulating but keep draining, rather than destroying
    // the request. The cap is there to bound memory, not socket reads, and
    // destroying it cost more than it saved: 'end' never fires on a destroyed
    // request, so the await never settled, and killing the socket mid-upload means
    // the 413 cannot be delivered at all - the client sees EPIPE instead of a
    // status line. Draining keeps memory bounded and still answers properly.
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        over = true;
        raw = '';
      }
    });

    req.on('end', () => {
      if (over) return done(TOO_LARGE);
      if (!raw) return done({});
      try {
        done(JSON.parse(raw));
      } catch {
        done(null); // signals a malformed body
      }
    });

    // A client that disappears mid-body fires one of these and never 'end'.
    req.on('aborted', () => done(ABORTED));
    req.on('error', () => done(ABORTED));
    req.on('close', () => done(ABORTED));
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
        // The socket is already gone, so there is nobody to answer.
        if (body === ABORTED) return;
        if (body === TOO_LARGE) return json(res, 413, { error: 'body too large' });
        if (body === null) return json(res, 400, { error: 'body is not valid JSON' });

        if (path === '/api/preset') {
          if (!body.id) return json(res, 400, { error: 'id is required' });
          const ok = actions.applyPreset(String(body.id));
          return json(res, ok ? 200 : 404, ok ? actions.status() : { error: 'no such preset' });
        }

        // The one action that can be refused for a reason other than "no such
        // panel": a url with a scheme no panel may load, or a partition that
        // would not survive a rebuild. It answers with the verdict so those are
        // a 400 that says why, rather than a 200 that did nothing.
        if (path === '/api/panel') {
          if (!body.id) return json(res, 400, { error: 'id is required' });
          const verdict = actions.updatePanel(String(body.id), body.patch || {});
          if (verdict.ok) return json(res, 200, actions.status());
          if (verdict.notFound) return json(res, 404, { error: 'no such panel' });
          return json(res, 400, { error: verdict.reason || 'patch refused' });
        }

        // The settings the wall will accept while running. Same shape as
        // /api/panel: a verdict, so a refused patch is a 400 that says why rather
        // than a 200 that quietly did nothing. There is no 404 here - there is
        // only one settings object - so an unknown key is a 400 like any other
        // refusal.
        if (path === '/api/settings') {
          const verdict = actions.updateSettings(body.patch || {});
          if (verdict.ok) return json(res, 200, actions.status());
          return json(res, 400, { error: verdict.reason || 'patch refused' });
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
