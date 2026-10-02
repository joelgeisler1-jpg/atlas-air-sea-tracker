'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('../backend/node_modules/ws');
const { createServer } = require('../backend/server');

async function start(t, options = {}) {
  const instance = createServer({ env: { ALLOWED_ORIGIN: 'https://example.test', MAX_AIS_VIEWERS: '1' }, ...options });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  t.after(async () => {
    for (const client of instance.wsServer.clients) client.terminate();
    instance.server.closeAllConnections();
    await new Promise(resolve => instance.server.close(resolve));
  });
  const url = `http://127.0.0.1:${instance.server.address().port}`;
  return { ...instance, url };
}

test('HTTP validates queries, enforces origins and hides credentials', async t => {
  let requests = 0;
  const { url } = await start(t, { fetchImpl: async () => {
    requests++;
    return { ok: true, json: async () => ({ ac: [{ hex: '7c1234', lat: -34, lon: 138 }] }) };
  } });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.aisConfigured, false);
  assert.equal(Object.keys(body).some(k => /key|secret/i.test(k)), false);
  const denied = await fetch(`${url}/api/health`, { headers: { Origin: 'https://other.test' } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${url}/api/health`, { headers: { Origin: 'https://example.test' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.test');
  for (const query of ['lat=&lon=0', 'lat=0&lon=', 'lat=1&lat=2&lon=3', 'lat=91&lon=0', 'lat=0&lon=0&radius=bad', 'lat=0&lon=0&radius=']) {
    assert.equal((await fetch(`${url}/api/aircraft?${query}`)).status, 400, query);
  }
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${url}/api/aircraft?lat=-34&lon=138`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).aircraft[0].id, '7C1234');
  }
  assert.equal(requests, 1);
});

test('provider failures return a safe 502 response', async t => {
  const { url } = await start(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: [] }) }) });
  const response = await fetch(`${url}/api/aircraft?lat=0&lon=0`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /unavailable/);
});

test('pending sockets count toward viewer limit and malformed messages do not crash', async t => {
  const { url } = await start(t);
  const wsUrl = url.replace('http:', 'ws:') + '/stream/ais';
  const first = new WebSocket(wsUrl, { origin: 'https://example.test' });
  await once(first, 'open');
  t.after(() => first.terminate());
  const second = new WebSocket(wsUrl, { origin: 'https://example.test' });
  second.on('error', () => {});
  await new Promise(resolve => second.once('unexpected-response', (_req, res) => {
    assert.equal(res.statusCode, 503); res.resume(); second.terminate(); resolve();
  }));
  for (const data of ['null', '[]', '"hello"', '{', '{"action":"subscribe","bbox":[null,0,1,1]}']) first.send(data);
  const message = once(first, 'message');
  first.send(JSON.stringify({ action: 'subscribe', bbox: [-35,138,-34,139] }));
  const [data] = await message;
  assert.ok(['error', 'status'].includes(JSON.parse(data).type));
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('rejects invalid configured viewer limits', () => {
  for (const value of ['bad', '0', '-1', '1.5', 'Infinity']) {
    assert.throws(() => createServer({ env: { MAX_AIS_VIEWERS: value } }), /positive integer/);
  }
});
