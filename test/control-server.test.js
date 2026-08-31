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
    },
  };
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
      { method, hostname: url.hostname, port: url.port, path: url.pathname },
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
