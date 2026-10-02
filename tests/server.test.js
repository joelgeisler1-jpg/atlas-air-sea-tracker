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

const USER_AGENT = 'Atlas-Air-Sea-Tracker/1.0 (+https://github.com/joelgeisler1-jpg/atlas-air-sea-tracker)';
const AIRCRAFT = { hex: '7c1234', lat: -34, lon: 138, flight: 'QFA123 ', gs: 431.9, seen_pos: 4 };

test('primary point endpoint uses User-Agent and preserves normalization and cache', async t => {
  const calls = [];
  const { url } = await start(t, { fetchImpl: async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { ok: true, json: async () => ({ ac: [AIRCRAFT, { ...AIRCRAFT, seen_pos: 100 }] }) };
  } });
  const route = `${url}/api/aircraft?lat=-34&lon=138&radius=250`;
  const body = await (await fetch(route)).json();
  assert.equal(body.provider, 'adsb.lol'); assert.equal(body.aircraft.length, 1);
  assert.equal(body.aircraft[0].callsign, 'QFA123'); assert.equal(body.aircraft[0].speedKt, 432);
  assert.equal(calls[0].endpoint, 'https://api.adsb.lol/v2/point/-34.0000/138.0000/250');
  assert.equal(calls[0].options.headers['User-Agent'], USER_AGENT);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(await (await fetch(route)).json(), body);
  assert.equal(calls.length, 1);
});

for (const failure of ['http', 'timeout', 'network', 'invalid-json', 'invalid-body']) {
  test(`adsb.fi succeeds after primary ${failure} failure`, async t => {
    const calls = [];
    const { url } = await start(t, { logger: { warn() {} }, fetchImpl: async (endpoint, options) => {
      calls.push(endpoint);
      assert.equal(options.headers['User-Agent'], USER_AGENT);
      if (calls.length === 1) {
        if (failure === 'http') return { ok: false, status: 503 };
        if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        if (failure === 'network') throw new Error('Network unavailable');
        if (failure === 'invalid-json') return { ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } };
        return { ok: true, json: async () => ({ ac: null }) };
      }
      return { ok: true, json: async () => ({ ac: [AIRCRAFT] }) };
    } });
    const route = `${url}/api/aircraft?lat=-34&lon=138`;
    const response = await fetch(route); assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'adsb.fi'); assert.equal(body.aircraft[0].id, '7C1234');
    assert.deepEqual(calls, [
      'https://api.adsb.lol/v2/point/-34.0000/138.0000/250',
      'https://opendata.adsb.fi/api/v3/lat/-34.0000/lon/138.0000/dist/250'
    ]);
    await fetch(route); assert.equal(calls.length, 2, 'fallback responses are cached too');
  });
}

test('failure of both providers returns safe 502', async t => {
  const calls = [];
  const { url } = await start(t, { logger: { warn() {} }, fetchImpl: async endpoint => {
    calls.push(endpoint); return { ok: false, status: calls.length === 1 ? 429 : 503 };
  } });
  const response = await fetch(`${url}/api/aircraft?lat=-34&lon=138`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'ADS-B providers unavailable. Check rate limits or retry.' });
  assert.equal(calls.length, 2);
});

test('both-provider failure preserves stale cache window and expiry', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let healthy = true; let calls = 0;
  const { url } = await start(t, { logger: { warn() {} }, fetchImpl: async () => {
    calls++;
    return healthy ? { ok: true, json: async () => ({ ac: [AIRCRAFT] }) } : { ok: false, status: 503 };
  } });
  const route = `${url}/api/aircraft?lat=-34&lon=138`;
  const original = await (await fetch(route)).json();
  healthy = false; now += 21000;
  assert.deepEqual(await (await fetch(route)).json(), { ...original, stale: true });
  assert.equal(calls, 3); now += 40000;
  assert.equal((await fetch(route)).status, 502);
});

async function aisFixture(t) {
  const provider = new WebSocket.Server({ port: 0, host: '127.0.0.1', perMessageDeflate: true });
  await once(provider, 'listening');
  t.after(async () => {
    for (const socket of provider.clients) socket.terminate();
    await new Promise(resolve => provider.close(resolve));
  });
  // Disposable local fixture value, never a real API key or a remote credential.
  const fixtureValue = require('node:crypto').randomUUID();
  const logs = [];
  const { url } = await start(t, {
    env: { ALLOWED_ORIGIN: 'https://example.test', AISSTREAM_API_KEY: fixtureValue },
    upstreamURL: `ws://127.0.0.1:${provider.address().port}`,
    logger: { warn: (...args) => logs.push(args.join(' ')) }
  });
  const connection = once(provider, 'connection');
  const client = new WebSocket(url.replace('http:', 'ws:') + '/stream/ais', { origin: 'https://example.test' });
  const messages = [];
  client.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(client, 'open'); t.after(() => client.terminate());
  client.send(JSON.stringify({ action: 'subscribe', bbox: [-35,138,-34,139] }));
  const [upstream] = await connection;
  const [subscription] = await once(upstream, 'message');
  const health = async () => (await fetch(`${url}/api/health`)).json();
  return { upstream, subscription: JSON.parse(subscription), fixtureValue, messages, client, logs, health };
}

function nextMessage(client, predicate) {
  return new Promise(resolve => {
    const receive = data => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) { client.off('message', receive); resolve(message); }
    };
    client.on('message', receive);
  });
}

test('AIS subscription format, confirmation, normalization and timestamp remain compatible', { timeout: 5000 }, async t => {
  const { upstream, subscription, fixtureValue, client, health } = await aisFixture(t);
  assert.deepEqual(subscription, {
    APIKey: fixtureValue, BoundingBoxes: [[[-34,138],[-35,139]]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'LongRangeAisBroadcastMessage']
  });
  let diagnostic = await health();
  assert.equal(diagnostic.upstreamConnected, true); assert.equal(diagnostic.aisSubscribed, false);
  assert.equal(diagnostic.lastAisMessageAt, null); assert.equal(diagnostic.lastAisError, null);
  const confirmed = nextMessage(client, message => message.type === 'status' && message.state === 'connected');
  upstream.send(JSON.stringify({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: true } }));
  await confirmed; assert.equal((await health()).aisSubscribed, true);
  assert.equal((await health()).marineProvider, 'aisstream');
  const received = nextMessage(client, message => message.type === 'vessel');
  upstream.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 123456789, ShipName: 'TEST SHIP', Latitude: -34.8, Longitude: 138.5 }, Message: { PositionReport: { Sog: 8.5, Cog: 90, TrueHeading: 511 } } }));
  const { vessel } = await received;
  assert.equal(vessel.id, '123456789'); assert.equal(vessel.name, 'TEST SHIP');
  assert.equal(vessel.speedKt, 8.5); assert.equal(vessel.heading, 90);
  diagnostic = await health();
  assert.equal(diagnostic.lastAisMessageAt, vessel.updatedAt);
  assert.equal(JSON.stringify(diagnostic).includes(fixtureValue), false);
  const ordered = nextMessage(client, message => message.type === 'status' && message.state === 'connected');
  upstream.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 11, Latitude: -34.8, Longitude: 138.5 } }));
  upstream.send(JSON.stringify({ MessageType: 'SubscriptionConfirmation' }));
  await ordered; assert.equal((await health()).lastAisMessageAt, vessel.updatedAt);
});

test('AIS rejections and close reasons are logged, diagnosed and redacted', { timeout: 5000 }, async t => {
  const { upstream, fixtureValue, client, logs, messages, health } = await aisFixture(t);
  const rejection = nextMessage(client, message => message.type === 'error');
  upstream.send(JSON.stringify({ error: `Invalid subscription APIKey=${fixtureValue}` }));
  await rejection;
  let diagnostic = await health();
  assert.match(diagnostic.lastAisError, /Subscription rejected/); assert.match(diagnostic.lastAisError, /REDACTED/);
  const closed = nextMessage(client, message => message.type === 'status' && message.state === 'reconnecting');
  upstream.close(1008, `Rejected ${fixtureValue}`); await closed;
  diagnostic = await health();
  assert.equal(diagnostic.upstreamConnected, false); assert.equal(diagnostic.aisSubscribed, false);
  assert.equal(diagnostic.marineProvider, null);
  assert.match(diagnostic.lastAisError, /WebSocket closed \(1008\): Rejected \[REDACTED\]/);
  assert.ok(logs.some(line => line.includes('Subscription rejected')));
  assert.ok(logs.some(line => line.includes('WebSocket closed (1008)')));
  assert.equal(JSON.stringify({ diagnostic, logs, messages }).includes(fixtureValue), false);
});

test('both stalled providers time out within the frontend budget', { timeout: 19000 }, async t => {
  let calls = 0;
  const started = performance.now();
  const { url } = await start(t, { logger: { warn() {} }, fetchImpl: async (_endpoint, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const response = await fetch(`${url}/api/aircraft?lat=-34&lon=138`);
  assert.equal(response.status, 502);
  assert.equal(calls, 2);
  assert.ok(performance.now() - started < 20000);
});

const feature = (mmsi = 123456789, lon = 138.5, seen = new Date().toISOString()) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, -34.8] },
  properties: { mmsi, name: 'TEST SHIP', sog: 8.5, cog: 90, seen }
});

test('anonymous vessel snapshot uses bbox, normalizes, deduplicates and caches', async t => {
  const calls = [];
  const { url } = await start(t, { fetchImpl: async (endpoint, options) => {
    calls.push(endpoint);
    assert.equal(options.headers.Authorization, undefined);
    const query = new URL(endpoint);
    assert.equal(query.origin + query.pathname, 'https://ais.openwaters.io/v1/vessels');
    assert.equal(query.searchParams.get('bbox'), '-35,138,-34,139');
    assert.equal(query.searchParams.get('max_age'), '20m');
    return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [feature(), feature(), feature(222222222, 140), feature(333333333, 138.5, '2000-01-01T00:00:00Z')], attribution: { aishub: 'AISHub' } }) };
  } });
  const route = `${url}/api/vessels?bbox=-35,138,-34,139`;
  const response = await fetch(route); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'openwaters'); assert.equal(body.vessels.length, 1);
  assert.equal(body.vessels[0].id, '123456789'); assert.equal(body.vessels[0].speedKt, 8.5);
  assert.deepEqual(body.attribution, ['AISHub']);
  assert.deepEqual(await (await fetch(route)).json(), body); assert.equal(calls.length, 1);
  const diagnostic = await (await fetch(`${url}/api/health`)).json();
  assert.equal(diagnostic.marineProvider, 'openwaters');
  assert.equal(diagnostic.lastOpenWatersSnapshotAt, body.updatedAt);
});

test('vessel snapshots reject oversized and malformed bounds before fetching', async t => {
  let calls = 0;
  const { url } = await start(t, { fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
  for (const query of ['', 'bbox=', 'bbox=,138,-34,139', 'bbox=-35,138,-34,139&bbox=-35,138,-34,139', 'bbox=-35,138,-20,139', 'bbox=-35,138,-34,151', 'bbox=-35,138,-34,139,1']) {
    assert.equal((await fetch(`${url}/api/vessels?${query}`)).status, 400);
  }
  assert.equal(calls, 0);
});

for (const failure of ['http', 'malformed', 'network']) {
  test(`Open Waters ${failure} failure returns safe unavailable status`, async t => {
    const { url } = await start(t, { logger: { warn() {} }, fetchImpl: async () => {
      if (failure === 'network') throw new Error('Network unavailable');
      return failure === 'http' ? { ok: false, status: 503 } : { ok: true, json: async () => ({ features: [] }) };
    } });
    const response = await fetch(`${url}/api/vessels?bbox=-35,138,-34,139`);
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'Marine feed unavailable' });
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.marineProvider, null); assert.ok(health.lastOpenWatersError);
  });
}

test('snapshot failure after cache expiry clears active marine provider', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  let healthy=true;
  const {url}=await start(t,{logger:{warn(){}},fetchImpl:async()=>healthy
    ? {ok:true,json:async()=>({type:'FeatureCollection',features:[]})}
    : {ok:false,status:503}});
  const route=`${url}/api/vessels?bbox=-35,138,-34,139`;
  assert.equal((await fetch(route)).status,200);
  assert.equal((await (await fetch(`${url}/api/health`)).json()).marineProvider,'openwaters');
  now+=21000;healthy=false;
  assert.equal((await fetch(route)).status,502);
  assert.equal((await (await fetch(`${url}/api/health`)).json()).marineProvider,null);
});
