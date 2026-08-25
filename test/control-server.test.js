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
  const state = { mode: 'grid', panels: ['a', 'b'], presets: ['solo'] };
  return {
    calls,
    state,
    actions: {
      status: () => ({ mode: state.mode, panels: state.panels, presets: state.presets }),
      page: () => '<!doctype html><title>stub</title>',
      applyPreset: (id) => {
        calls.push(['applyPreset', id]);
        return state.presets.includes(id);
      },
      updatePanel: (id, patch) => {
        calls.push(['updatePanel', id, patch]);
        return state.panels.includes(id);
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
