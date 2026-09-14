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

// The multipart boundary for the panel stream. Any token works; this one is
// distinctive enough to spot in a packet capture.
const BOUNDARY = 'wallwrightframe';
// Each part is CLOSED by the boundary that follows it, not merely introduced by
// the one before. A part is only complete to an image decoder once the next
// boundary arrives, so a stream that writes the boundary first leaves its most
// recent frame permanently unterminated. On a panel that keeps painting nobody
// notices, because the next frame closes the previous one. On a static dashboard
// it means exactly one frame is sent and none of it ever renders: the <img>
// fires neither load nor error and sits blank. Measured in Chrome against a
// still mock dashboard, which is the ordinary case on a wall.
const HEAD = Buffer.from(`--${BOUNDARY}\r\n`, 'latin1');
const TAIL = Buffer.from(`\r\n--${BOUNDARY}\r\n`, 'latin1');

// GET /api/stream?id=... : the one long-lived response on this server.
//
// Everything else answers and closes. This one holds the socket open and writes
// a JPEG part per frame for as long as the client is there, which is how a
// browser renders a live view in a plain <img> with no script in the render
// path. That also means it cannot go through json(), and it has to clean up
// after itself when the client disappears.
// A `q` on the query string, or undefined when it is absent or not a number.
// The wall clamps it; this only decides whether one was asked for at all.
function numeric(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function streamPanel(res, actions, id, q, w, log) {
  if (!id) return json(res, 400, { error: 'id is required' });

  // False until the head is out. A wall that hands us a frame synchronously from
  // startPanelStream would otherwise write a part before the headers, and node
  // would send an implicit 200 with no content type, which renders as nothing.
  // Dropping the frame is the right answer: another one is along shortly.
  let streaming = false;
  let stopped = false;
  // Set when the socket will not take any more. Frames are dropped rather than
  // queued while it is true: a frame that has to wait is already stale, and
  // queueing them means the tablet drifts further behind the wall the longer it
  // watches. This is the whole of the backpressure story.
  let backedUp = false;

  const onFrame = (jpeg) => {
    if (!streaming || stopped || backedUp) return;
    const head = Buffer.from(
      `Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      'latin1'
    );
    // One write for the whole part, so a part is never torn in half by
    // backpressure and the boundary always arrives with the bytes it closes.
    if (!res.write(Buffer.concat([head, jpeg, TAIL]))) {
      backedUp = true;
      res.once('drain', () => {
        backedUp = false;
      });
    }
  };

  const verdict = actions.startPanelStream(id, onFrame, q, w);
  if (verdict.notFound) return json(res, 404, { error: 'no such panel' });
  if (!verdict.ok) return json(res, 400, { error: verdict.reason || 'stream refused' });

  // No content-length is possible and none is wanted, so the connection is the
  // frame boundary of last resort: closing it is how the client learns the
  // stream ended.
  // No content length is possible on a stream, so node reaches for chunked
  // transfer encoding by default. Turn it off: chunked framing wrapped around
  // multipart framing is the combination WebKit is reported to mishandle, and
  // with `Connection: close` it buys nothing here anyway. Without it the body is
  // the parts and nothing else, and the close is what ends the stream.
  res.useChunkedEncodingByDefault = false;
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  // writeHead only sets the head; node holds it back until something writes a
  // body. On a stream that means the client learns nothing until the first frame
  // arrives, which on a static panel could be a long time, and it cannot tell a
  // stream that opened from one that is still connecting. Push it out now.
  res.flushHeaders();
  // The opening boundary. Every frame after this one supplies the boundary that
  // closes it and opens the next.
  res.write(HEAD);
  streaming = true;

  // Fires when the client goes away as well as on a normal end, so this is the
  // one hook that has to release the wall's capture. Wrapped because a stop that
  // throws would otherwise be an unhandled exception in an event handler, which
  // takes the process down rather than the stream.
  res.on('close', () => {
    if (stopped) return;
    stopped = true;
    try {
      verdict.stop();
    } catch (e) {
      log(`control server: stopping the stream for ${id} failed: ${e.message}`);
    }
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

      if (req.method === 'GET' && path === '/api/stream') {
        return streamPanel(
          res,
          actions,
          url.searchParams.get('id'),
          numeric(url, 'q'),
          numeric(url, 'w'),
          log
        );
      }

      // One frame, as an ordinary image response. The fallback for a browser
      // that cannot decode the stream: no multipart, no streaming body, nothing
      // but an <img> pointed at a URL. See the engine table in
      // docs/tablet-control-surface-plan.md for why that is worth having.
      if (req.method === 'GET' && path === '/api/frame') {
        const id = url.searchParams.get('id');
        if (!id) return json(res, 400, { error: 'id is required' });
        const shot = await actions.capturePanelFrame(id, numeric(url, 'q'), numeric(url, 'w'));
        if (shot.notFound) return json(res, 404, { error: 'no such panel' });
        if (!shot.ok) return json(res, 400, { error: shot.reason || 'capture refused' });
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': shot.jpeg.length,
          'Cache-Control': 'no-store',
        });
        return res.end(shot.jpeg);
      }

      // The tablet surface. Served from memory like the status page, and like it
      // needs nothing installed at the other end.
      if (req.method === 'GET' && path === '/touch') {
        const html = actions.touchPage();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        });
        return res.end(html);
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

        // Injected input from a tablet. The one POST route that is not an
        // administrative action: it is a person touching a page, and it arrives
        // at whatever rate a finger moves, so it takes a batch rather than one
        // event per request.
        if (path === '/api/input') {
          if (!body.id) return json(res, 400, { error: 'id is required' });
          const verdict = actions.sendPanelInput(String(body.id), body.events);
          if (verdict.ok) return json(res, 200, { ok: true });
          if (verdict.notFound) return json(res, 404, { error: 'no such panel' });
          return json(res, 400, { error: verdict.reason || 'input refused' });
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
      // A stream has already sent its status line, so there is none left to
      // change. Writing one throws ERR_HTTP_HEADERS_SENT from inside the handler
      // that is already reporting an error, and that one is unhandled: it takes
      // the whole control surface down instead of this one request. Dropping the
      // socket is what the client is going to see anyway.
      if (res.headersSent) return res.destroy();
      json(res, 500, { error: e.message });
    }
  });

  return server;
}

module.exports = { createControlServer };
