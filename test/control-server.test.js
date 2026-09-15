// node --test test/control-server.test.js
//
// src/control-server.js takes its actions as an argument and imports no
// electron, specifically so it can be exercised over real HTTP with a stand-in.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createControlServer } = require('../src/control-server');

// A stand-in for the wall. Records what was asked of it, so the tests can check
// the server passes the right things through rather than only that it replies.
function fakeWall() {
  const calls = [];
  const state = {
    mode: 'grid',
    panels: ['a', 'b'],
    presets: ['solo'],
    settings: { memoryLimitMb: 2000, memoryHardLimitMb: 2750, autoStart: false },
  };
  return {
    calls,
    state,
    actions: {
      status: () => ({
        mode: state.mode,
        panels: state.panels,
        presets: state.presets,
        settings: state.settings,
      }),
      page: () => '<!doctype html><title>stub</title>',
      applyPreset: (id) => {
        calls.push(['applyPreset', id]);
        return state.presets.includes(id);
      },
      // Mirrors the real action's verdict shape: ok, notFound, or a reason.
      updatePanel: (id, patch) => {
        calls.push(['updatePanel', id, patch]);
        if (!state.panels.includes(id)) return { ok: false, notFound: true };
        if (patch && patch.url === 'file:///etc/passwd') {
          return { ok: false, reason: 'file: is not allowed for a panel' };
        }
        const patchable = ['url', 'label', 'zoom', 'partition'];
        const unknown = Object.keys(patch || {}).filter((k) => !patchable.includes(k));
        if (unknown.length) {
          return { ok: false, reason: 'not a patchable field: ' + unknown.join(', ') };
        }
        return { ok: true };
      },
      // Mirrors the real action: a verdict, and no notFound, because there is
      // only one settings object to address.
      updateSettings: (patch) => {
        calls.push(['updateSettings', patch]);
        const keys = Object.keys(patch || {});
        if (!keys.length) return { ok: false, reason: 'patch is empty' };
        if (keys.some((k) => k === 'views'))
          return { ok: false, reason: 'not an editable setting: views' };
        Object.assign(state.settings, patch);
        return { ok: true };
      },
      promote: (id) => {
        calls.push(['promote', id]);
        return id === null || state.panels.includes(id);
      },
      reload: (id) => {
        calls.push(['reload', id]);
        return id === null || state.panels.includes(id);
      },
      recycle: (id) => {
        calls.push(['recycle', id]);
        return id === null || state.panels.includes(id);
      },
      touchPage: () => '<!doctype html><title>touch stub</title>',
      sendPanelInput: (id, events) => {
        calls.push(['sendPanelInput', id, events]);
        if (!state.panels.includes(id)) return { notFound: true };
        if (!Array.isArray(events) || !events.length) {
          return { ok: false, reason: 'events must be a non-empty array' };
        }
        return { ok: true };
      },
      // Async, like the real one, so the route has to await it.
      capturePanelFrame: async (id, q, w) => {
        calls.push(['capturePanelFrame', id, q, w]);
        if (!state.panels.includes(id)) return { notFound: true };
        if (state.captureRefusal) return { ok: false, reason: state.captureRefusal };
        return { ok: true, jpeg: Buffer.from('JPEGBYTES', 'latin1') };
      },
      // Mirrors the real action: a verdict, and on success a stop() the server
      // owns. `emit` lets a test push frames at the moment it chooses, which is
      // the only way to test framing without waiting on a real capture.
      startPanelStream: (id, onFrame, q, w) => {
        calls.push(['startPanelStream', id, q, w]);
        if (!state.panels.includes(id)) return { notFound: true };
        if (state.streamRefusal) return { ok: false, reason: state.streamRefusal };
        state.emit = onFrame;
        state.stops = state.stops || [];
        const stop = () => state.stops.push(id);
        return { ok: true, stop };
      },
    },
  };
}

// Frames sent, counted off the wire. One boundary opens the stream and every
// frame supplies the one that closes it, so the frame count is one less than the
// number of boundaries.
const frameCount = (body) => body.split('--wallwrightframe').length - 2;

// A JPEG only in so far as anything downstream cares: the server writes the
// bytes it is handed and never looks inside them.
const jpegOf = (text) => Buffer.from(text, 'latin1');

// request() buffers to completion, which never happens on a stream. This one
// hands back the response as soon as the head arrives, plus the chunks as they
// land and a way to hang up like a tablet walking out of range.
function openStream(base, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        resolve({
          res,
          status: res.statusCode,
          type: res.headers['content-type'],
          body: () => Buffer.concat(chunks).toString('latin1'),
          hangUp: () => req.destroy(),
        });
      }
    );
    req.on('error', (e) => {
      // Expected once the test hangs up; anything before that is a real failure.
      if (e.code !== 'ECONNRESET') reject(e);
    });
    req.end();
  });
}

// The server writes each frame in one go, but TCP is free to split it, so a test
// that wants to count parts has to wait for the bytes rather than assume them.
function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

// Start on port 0 so tests never collide with anything already listening, which
// is how the first manual run of this server met a stray process on its port.
function withServer(actions, fn) {
  return new Promise((resolve, reject) => {
    const server = createControlServer(actions);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await fn(base);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

function request(base, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const payload = body === undefined ? null : body;
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, raw, type: res.headers['content-type'] })
        );
      }
    );
    req.on('error', reject);
    if (payload !== null)
      req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.end();
  });
}

const json = (r) => JSON.parse(r.raw);

test('GET / serves the page as html', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.raw, /<title>stub<\/title>/);
  });
});

test('GET /api/status returns the wall state', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/status');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /application\/json/);
    assert.strictEqual(json(r).mode, 'grid');
  });
});

test('a trailing slash is the same route', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'GET', '/api/status/')).status, 200);
  });
});

test('POST /api/preset recalls, and passes the id through', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/preset', { id: 'solo' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(w.calls[0], ['applyPreset', 'solo']);
    // Replies with fresh status, so a caller needs only one round trip.
    assert.strictEqual(json(r).mode, 'grid');
  });
});

test('an unknown preset is a 404, not a 500', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/preset', { id: 'nope' });
    assert.strictEqual(r.status, 404);
    assert.match(json(r).error, /no such preset/);
  });
});

test('POST /api/panel passes the patch through untouched', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const patch = { url: 'https://example.com/', zoom: 1.25 };
    const r = await request(base, 'POST', '/api/panel', { id: 'a', patch });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(w.calls[0], ['updatePanel', 'a', patch]);
  });
});

test('a panel POST with no patch still works', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    await request(base, 'POST', '/api/panel', { id: 'a' });
    assert.deepStrictEqual(w.calls[0], ['updatePanel', 'a', {}]);
  });
});

// null means "the whole wall": back to grid, or reload everything.
test('promote and reload treat a missing id as null', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    await request(base, 'POST', '/api/promote', {});
    await request(base, 'POST', '/api/reload', {});
    assert.deepStrictEqual(w.calls, [
      ['promote', null],
      ['reload', null],
    ]);
  });
});

test('promote and reload accept a specific panel', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'POST', '/api/promote', { id: 'b' })).status, 200);
    assert.deepStrictEqual(w.calls[0], ['promote', 'b']);
    assert.strictEqual(
      (await request(base, 'POST', '/api/reload', { id: 'nope' })).status,
      404
    );
  });
});

test('a missing id is a 400', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'POST', '/api/preset', {})).status, 400);
    assert.strictEqual((await request(base, 'POST', '/api/panel', {})).status, 400);
  });
});

test('a malformed body is a 400, and does not reach the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/panel', '{not json');
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /valid JSON/);
    assert.strictEqual(w.calls.length, 0);
  });
});

// The cap used to call req.destroy() while only 'end' could resolve the promise,
// and 'end' never fires on a destroyed request. The await never settled: the
// handler leaked a pending promise and the client got a dropped socket. A real
// status line is the proof it settles, so this test would hang on a regression
// rather than merely fail.
test('a body over the cap is a 413, and does not reach the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const huge = JSON.stringify({ id: 'a', patch: { label: 'x'.repeat(1.2e6) } });
    const r = await request(base, 'POST', '/api/panel', huge);
    assert.strictEqual(r.status, 413);
    assert.match(json(r).error, /too large/);
    assert.strictEqual(w.calls.length, 0);
  });
});

// A refused patch used to answer 200 with the wall's status, which reads as
// "done". The distinction that matters is 400 (I will not) versus 404 (there is
// no such thing).
test('a refused patch is a 400 saying why, not a 200', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/panel', {
      id: 'a',
      patch: { url: 'file:///etc/passwd' },
    });
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /file:/);
  });
});

test('a patch for a panel that does not exist is still a 404', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/panel', { id: 'nope', patch: { label: 'x' } });
    assert.strictEqual(r.status, 404);
    assert.match(json(r).error, /no such panel/);
  });
});

test('an unknown route is a 404 naming the method and path', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/nothing');
    assert.strictEqual(r.status, 404);
    assert.match(json(r).error, /GET \/api\/nothing/);
  });
});

test('a GET to an action route is a 404, not an accidental action', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'GET', '/api/reload')).status, 404);
    assert.strictEqual(w.calls.length, 0);
  });
});

// An action that throws must not take the wall's control surface down with it.
test('a throwing action becomes a 500, and the server survives', async () => {
  const w = fakeWall();
  w.actions.applyPreset = () => {
    throw new Error('boom');
  };
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/preset', { id: 'solo' });
    assert.strictEqual(r.status, 500);
    assert.match(json(r).error, /boom/);
    // Still serving.
    assert.strictEqual((await request(base, 'GET', '/api/status')).status, 200);
  });
});

test('POST /api/recycle rebuilds one panel, or the whole wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'POST', '/api/recycle', { id: 'a' })).status, 200);
    assert.deepStrictEqual(w.calls[0], ['recycle', 'a']);
    // No id means every panel, the same shape as reload.
    await request(base, 'POST', '/api/recycle', {});
    assert.deepStrictEqual(w.calls[1], ['recycle', null]);
    assert.strictEqual(
      (await request(base, 'POST', '/api/recycle', { id: 'nope' })).status,
      404
    );
  });
});

test('the status payload passes through untouched, counters and all', async () => {
  // The server must never become a filter: a field added to wallStatus() should
  // reach a sampler without anything here needing to know about it.
  const w = fakeWall();
  w.actions.status = () => ({
    mode: 'grid',
    panels: [],
    presets: [],
    counters: { crashes: 2 },
    memoryByType: { Tab: 400 },
    memoryPeakMb: 1234,
  });
  await withServer(w.actions, async (base) => {
    const body = json(await request(base, 'GET', '/api/status'));
    assert.deepStrictEqual(body.counters, { crashes: 2 });
    assert.deepStrictEqual(body.memoryByType, { Tab: 400 });
    assert.strictEqual(body.memoryPeakMb, 1234);
  });
});

// ---- settings ---------------------------------------------------------------

test('a settings patch is applied and answered with the new status', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'POST', '/api/settings', {
      patch: { memoryLimitMb: 2500 },
    });
    assert.equal(r.status, 200);
    assert.equal(json(r).settings.memoryLimitMb, 2500);
    assert.deepEqual(wall.calls, [['updateSettings', { memoryLimitMb: 2500 }]]);
  });
});

// The distinction the panel route already makes, and the reason both return a
// verdict rather than a boolean: a refusal has to say why.
test('a refused settings patch is a 400 carrying the reason', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'POST', '/api/settings', { patch: { views: [] } });
    assert.equal(r.status, 400);
    assert.match(json(r).error, /not an editable setting: views/);
  });
});

// There is only one settings object, so nothing here can 404. An absent patch is
// a client mistake and must not read as success.
test('a settings post with no patch is refused, not treated as a no-op', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'POST', '/api/settings', {});
    assert.equal(r.status, 400);
    assert.match(json(r).error, /empty/);
  });
});

test('settings is a POST route only', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'GET', '/api/settings');
    assert.equal(r.status, 404);
  });
});

// A field the wall cannot apply must come back as a 400 that names it. It used
// to be a 200: the caller was told the patch had been applied when nothing had
// happened, which for allowedOrigins means believing a navigation guard is in
// place when it is not.
test('a panel patch naming an unapplicable field is a 400, not a silent 200', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'POST', '/api/panel', {
      id: 'a',
      patch: { allowedOrigins: ['https://idp.example.com'] },
    });
    assert.equal(r.status, 400);
    assert.match(json(r).error, /allowedOrigins/);
  });
});

// The distinction the route has always drawn and must keep drawing: a panel that
// does not exist is a 404, a patch that is refused is a 400.
test('an unapplicable field on a missing panel is still a 404', async () => {
  const wall = fakeWall();
  await withServer(wall.actions, async (base) => {
    const r = await request(base, 'POST', '/api/panel', {
      id: 'nope',
      patch: { allowedOrigins: [] },
    });
    assert.equal(r.status, 404);
  });
});

// ---- panel stream -----------------------------------------------------------
//
// The one long-lived response on this server, and the only one that writes bytes
// rather than JSON. What these check is the framing and the handover to the
// wall: the server never looks inside a frame, so the fake's "JPEGs" are text.

test('GET /api/stream answers multipart and frames the bytes it is handed', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    assert.strictEqual(s.status, 200);
    assert.match(s.type, /multipart\/x-mixed-replace; boundary=wallwrightframe/);
    assert.deepStrictEqual(w.calls[0], ['startPanelStream', 'a', undefined, undefined]);

    w.state.emit(jpegOf('FIRSTFRAME'));
    w.state.emit(jpegOf('SECOND'));
    await settle();

    const body = s.body();
    // One boundary opens the stream and each frame is closed by its own, so two
    // frames means three boundaries.
    assert.strictEqual(frameCount(body), 2);
    assert.ok(body.startsWith('--wallwrightframe\r\n'), 'the stream opens with a boundary');
    // The last frame must be terminated, or a decoder holds it and renders
    // nothing. This is the whole reason the boundary trails rather than leads.
    assert.ok(body.endsWith('\r\n--wallwrightframe\r\n'), 'the last frame is closed');
    assert.match(body, /Content-Type: image\/jpeg\r\nContent-Length: 10\r\n\r\nFIRSTFRAME\r\n/);
    assert.match(body, /Content-Length: 6\r\n\r\nSECOND\r\n/);
    s.hangUp();
  });
});

// The whole of the cleanup contract: the wall keeps capturing until the server
// says otherwise, and the only signal that a tablet has gone is the socket.
test('the wall is told to stop when the client hangs up', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    w.state.emit(jpegOf('x'));
    await settle();
    assert.deepStrictEqual(w.state.stops, []);
    s.hangUp();
    await settle();
    assert.deepStrictEqual(w.state.stops, ['a']);
  });
});

test('a stream for a panel that does not exist is a 404, not an empty stream', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/stream?id=nope');
    assert.strictEqual(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.match(json(r).error, /no such panel/);
  });
});

// The distinction the POST routes already draw, held here too: 404 is "there is
// no such panel", 400 is "there is, and I will not". DevTools being attached to
// the panel is the refusal this exists for.
test('a refused stream is a 400 carrying the reason', async () => {
  const w = fakeWall();
  w.state.streamRefusal = 'DevTools is open on this panel';
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/stream?id=a');
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /DevTools is open/);
  });
});

test('a stream with no id is a 400 and never reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/stream');
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /id is required/);
    assert.strictEqual(w.calls.length, 0);
  });
});

// A wall that hands over a frame from inside startPanelStream, before the server
// has written a status line. Node would answer that write with an implicit 200
// and no content type, and the tablet would render nothing at all. The frame is
// dropped and the stream carries on.
test('a frame emitted before the head is dropped, not written ahead of it', async () => {
  const w = fakeWall();
  w.actions.startPanelStream = (id, onFrame) => {
    onFrame(jpegOf('TOOEARLY'));
    w.state.emit = onFrame;
    return { ok: true, stop: () => {} };
  };
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    assert.match(s.type, /multipart\/x-mixed-replace/);
    w.state.emit(jpegOf('INTIME'));
    await settle();
    const body = s.body();
    assert.ok(!body.includes('TOOEARLY'), 'the early frame should have been dropped');
    assert.match(body, /INTIME/);
    s.hangUp();
  });
});

// Frames keep arriving after the client has gone, because the wall only learns
// to stop on the next tick. Writing them must not throw.
test('frames after a hang-up are swallowed, and the server survives', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    s.hangUp();
    await settle();
    w.state.emit(jpegOf('late'));
    w.state.emit(jpegOf('later'));
    assert.strictEqual((await request(base, 'GET', '/api/status')).status, 200);
  });
});

// A wall action that throws on the way in is a 500 like any other, because the
// head has not gone out yet and there is still a status line to spend.
test('a throwing startPanelStream is a 500, and the server survives', async () => {
  const w = fakeWall();
  w.actions.startPanelStream = () => {
    throw new Error('boom');
  };
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/stream?id=a');
    assert.strictEqual(r.status, 500);
    assert.match(json(r).error, /boom/);
    assert.strictEqual((await request(base, 'GET', '/api/status')).status, 200);
  });
});

// Contrived on purpose: nothing in the wall throws from a property read today.
// The guard it exercises is not contrived, because once the head is out the
// catch-all has no status line left to write and trying anyway throws
// ERR_HTTP_HEADERS_SENT from inside the handler that is already reporting an
// error. That second throw is unhandled and takes the control surface down.
test('an error after the head drops the socket instead of the server', async () => {
  const w = fakeWall();
  w.actions.startPanelStream = () => ({
    ok: true,
    get stop() {
      throw new Error('after the head');
    },
  });
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    assert.strictEqual(s.status, 200);
    s.hangUp();
    await settle();
    // The surface is still answering, which is the whole point of the guard.
    assert.strictEqual((await request(base, 'GET', '/api/status')).status, 200);
  });
});

// The decision the stream rests on. A tablet that cannot keep up must fall
// behind by dropping frames, never by queueing them: a queue means the wall and
// the tablet drift apart without bound, and every frame in it is stale by the
// time it is drawn. Pausing the response is a client that has stopped reading.
test('frames are dropped, not queued, when the socket backs up', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    s.res.pause();

    const big = jpegOf('x'.repeat(1e6));
    for (let i = 0; i < 8; i++) w.state.emit(big);
    await settle();

    s.res.resume();
    await settle(150);
    const parts = frameCount(s.body());
    assert.ok(parts < 8, `expected frames to be dropped, got all ${parts} of them`);

    // And the stream recovers: once the socket drains, the next frame is written
    // rather than the stream being wedged shut by the first drop.
    w.state.emit(jpegOf('AFTERDRAIN'));
    await settle(150);
    assert.match(s.body(), /AFTERDRAIN/);
    s.hangUp();
  });
});

test('the stream is a GET route only', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'POST', '/api/stream', { id: 'a' })).status, 404);
    assert.strictEqual(w.calls.length, 0);
  });
});

// ---- single frame and the touch page ----------------------------------------
//
// The fallback transport. A browser that cannot decode multipart can still ask
// for one ordinary image at a time, so this route has to behave like an image
// endpoint and not like the stream.

test('GET /api/frame answers one JPEG with a real content length', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/frame?id=a');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /image\/jpeg/);
    assert.strictEqual(r.raw, 'JPEGBYTES');
    assert.deepStrictEqual(w.calls[0], ['capturePanelFrame', 'a', undefined, undefined]);
  });
});

// It must not go near the stream: a tablet polling stills while somebody else
// streams a different panel is the case this exists to allow.
test('a still does not take the stream slot', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    assert.strictEqual(s.status, 200);
    const r = await request(base, 'GET', '/api/frame?id=b');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /image\/jpeg/);
    s.hangUp();
  });
});

test('a still for a panel that does not exist is a 404', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/frame?id=nope');
    assert.strictEqual(r.status, 404);
    assert.match(json(r).error, /no such panel/);
  });
});

test('a refused still is a 400 carrying the reason', async () => {
  const w = fakeWall();
  w.state.captureRefusal = 'the panel has not composited a frame yet';
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/frame?id=a');
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /composited/);
  });
});

test('a still with no id is a 400 and never reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/frame');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(w.calls.length, 0);
  });
});

// The action is async and the route awaits it. A rejection has to land in the
// catch-all as a 500 rather than an unhandled rejection that takes the surface
// down.
test('a rejecting capture is a 500, and the server survives', async () => {
  const w = fakeWall();
  w.actions.capturePanelFrame = async () => {
    throw new Error('capture exploded');
  };
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/api/frame?id=a');
    assert.strictEqual(r.status, 500);
    assert.match(json(r).error, /capture exploded/);
    assert.strictEqual((await request(base, 'GET', '/api/status')).status, 200);
  });
});

test('GET /touch serves the tablet page as html', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'GET', '/touch');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.raw, /touch stub/);
  });
});

// A single frame on a panel that never paints again is the ordinary case on a
// wall: most dashboards are still. The part has to be complete on arrival, not
// when a second frame eventually turns up, or the tablet shows nothing at all.
test('one frame is complete on its own, not waiting on the next', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a');
    w.state.emit(jpegOf('ONLYFRAME'));
    await settle();
    const body = s.body();
    assert.strictEqual(frameCount(body), 1);
    assert.match(body, /Content-Length: 9\r\n\r\nONLYFRAME\r\n--wallwrightframe\r\n$/);
    s.hangUp();
  });
});

// ---- injected input ---------------------------------------------------------

test('POST /api/input passes the batch through untouched', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const events = [
      { kind: 'move', x: 10, y: 20 },
      { kind: 'down', x: 10, y: 20 },
    ];
    const r = await request(base, 'POST', '/api/input', { id: 'a', events });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(w.calls[0], ['sendPanelInput', 'a', events]);
  });
});

test('input for a panel that does not exist is a 404', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/input', {
      id: 'nope',
      events: [{ kind: 'move', x: 1, y: 1 }],
    });
    assert.strictEqual(r.status, 404);
  });
});

// The distinction every other route draws, held here too.
test('a refused batch is a 400 carrying the reason', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const r = await request(base, 'POST', '/api/input', { id: 'a', events: [] });
    assert.strictEqual(r.status, 400);
    assert.match(json(r).error, /non-empty array/);
  });
});

test('input with no id is a 400 and never reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'POST', '/api/input', {})).status, 400);
    assert.strictEqual(w.calls.length, 0);
  });
});

test('input is a POST route only', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    assert.strictEqual((await request(base, 'GET', '/api/input')).status, 404);
    assert.strictEqual(w.calls.length, 0);
  });
});

// ---- quality ----------------------------------------------------------------
//
// A preference, not an instruction: the server passes it through and the wall
// clamps it. Nothing here should refuse a picture over a silly number.

test('a quality on the stream url reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a&q=40');
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(w.calls[0], ['startPanelStream', 'a', 40, undefined]);
    s.hangUp();
  });
});

test('a quality on the still url reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    await request(base, 'GET', '/api/frame?id=a&q=90');
    assert.deepStrictEqual(w.calls[0], ['capturePanelFrame', 'a', 90, undefined]);
  });
});

// Absent and unparseable are the same thing: the wall picks its default.
test('a missing or nonsense quality is passed as undefined', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    await request(base, 'GET', '/api/frame?id=a');
    await request(base, 'GET', '/api/frame?id=a&q=lots');
    assert.strictEqual(w.calls[0][2], undefined);
    assert.strictEqual(w.calls[1][2], undefined);
  });
});

test('an out-of-range quality is still passed through, for the wall to clamp', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    await request(base, 'GET', '/api/frame?id=a&q=1000');
    assert.strictEqual(w.calls[0][2], 1000);
  });
});

// Width is the stronger of the two levers on animation-heavy content, so it
// travels the same way quality does: passed through, clamped by the wall.
test('a width on either url reaches the wall', async () => {
  const w = fakeWall();
  await withServer(w.actions, async (base) => {
    const s = await openStream(base, '/api/stream?id=a&q=40&w=640');
    assert.deepStrictEqual(w.calls[0], ['startPanelStream', 'a', 40, 640]);
    s.hangUp();
    await request(base, 'GET', '/api/frame?id=a&w=960');
    assert.deepStrictEqual(w.calls[1], ['capturePanelFrame', 'a', undefined, 960]);
  });
});
