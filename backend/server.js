'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const {
  clamp, validLatLon, validateBoundingBox, inBounds, normalizeAircraft, normalizeVessel
} = require('./lib');

function createServer({ env = process.env, fetchImpl = globalThis.fetch, upstreamURL = 'wss://stream.aisstream.io/v0/stream' } = {}) {
const app = express();
const server = http.createServer(app);
const AIS_KEY = env.AISSTREAM_API_KEY || '';
const ALLOWED_ORIGIN = (env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
const PORT = Number(env.PORT || 3000);
const viewerLimit = Number(env.MAX_AIS_VIEWERS || 3);
if (!Number.isSafeInteger(viewerLimit) || viewerLimit < 1) throw new Error('MAX_AIS_VIEWERS must be a positive integer');
const MAX_AIS_VIEWERS = viewerLimit;
const aircraftCache = new Map();

function isOriginAllowed(origin) {
  // Set ALLOWED_ORIGIN in Render for public deployments to restrict browser access.
  return !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN || (!origin && !ALLOWED_ORIGIN);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  if (origin && isOriginAllowed(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => res.json({
  ok: true, aisConfigured: Boolean(AIS_KEY), upstreamConnected: upstream?.readyState === WebSocket.OPEN,
  maxAisViewers: MAX_AIS_VIEWERS, aircraftProvider: 'adsb.lol'
}));

app.get('/api/aircraft', async (req, res) => {
  const numericQuery = value => typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const lat = numericQuery(req.query.lat), lon = numericQuery(req.query.lon);
  const radius = clamp(req.query.radius === undefined ? 250 : numericQuery(req.query.radius), 10, 250);
  if (!validLatLon(lat, lon) || !Number.isFinite(radius)) {
    return res.status(400).json({ error: 'Invalid centre coordinates or radius' });
  }
  // Rounding maximises cache reuse across nearby viewers; not a promise of exact coverage.
  const key = `${lat.toFixed(1)}:${lon.toFixed(1)}:${Math.round(radius)}`;
  const cached = aircraftCache.get(key);
  if (cached && Date.now() - cached.at < 20000) return res.json(cached.body);
  const url = `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(radius)}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`ADS-B provider returned HTTP ${response.status}`);
    const raw = await response.json();
    if (!Array.isArray(raw.ac)) throw new Error('Invalid ADS-B response');
    const now = Date.now();
    const aircraft = raw.ac.map(a => normalizeAircraft(a, now)).filter(Boolean);
    const body = { updatedAt: now, provider: 'adsb.lol', centre: { lat, lon, radiusNm: radius }, aircraft };
    aircraftCache.set(key, { at: now, body });
    while (aircraftCache.size > 120) aircraftCache.delete(aircraftCache.keys().next().value);
    return res.json(body);
  } catch (error) {
    if (cached && Date.now() - cached.at < 60000) return res.json({ ...cached.body, stale: true });
    console.error('Aircraft provider:', error.message);
    return res.status(502).json({ error: 'ADS-B provider unavailable. Check rate limits or retry.' });
  }
});

const wsServer = new WebSocket.Server({ noServer: true, maxPayload: 2048 });
const aisClients = new Map(); // browser socket → [south, west, north, east]
let upstream = null;
let reconnectTimer = null;
let updateTimer = null;
let reconnectDelay = 2000;
let lastSubscribeAt = 0;

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 500000) ws.send(JSON.stringify(msg));
}
function notify(msg) { for (const client of aisClients.keys()) send(client, msg); }
function currentBoxes() {
  return [...aisClients.values()].map(([south, west, north, east]) => [
    [north, west], [south, east]
  ]);
}
function stopUpstream() {
  clearTimeout(reconnectTimer); clearTimeout(updateTimer);
  reconnectTimer = null; updateTimer = null;
  const old = upstream; upstream = null;
  if (old) { old.removeAllListeners(); old.on('error', () => {}); old.terminate(); }
}
function writeSubscription() {
  if (!upstream || upstream.readyState !== WebSocket.OPEN || !AIS_KEY) return;
  const boxes = currentBoxes();
  if (!boxes.length) { stopUpstream(); return; }
  lastSubscribeAt = Date.now();
  upstream.send(JSON.stringify({
    APIKey: AIS_KEY,
    BoundingBoxes: boxes,
    FilterMessageTypes: [
      'PositionReport', 'StandardClassBPositionReport',
      'ExtendedClassBPositionReport', 'LongRangeAisBroadcastMessage'
    ]
  }));
}
function scheduleSubscription() {
  if (!aisClients.size) { stopUpstream(); return; }
  if (!upstream || upstream.readyState === WebSocket.CLOSED) return connectUpstream();
  if (upstream.readyState !== WebSocket.OPEN) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(writeSubscription, Math.max(1300, 1300 - (Date.now() - lastSubscribeAt)));
}
function connectUpstream() {
  if (!AIS_KEY || !aisClients.size || (upstream && upstream.readyState !== WebSocket.CLOSED)) return;
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(upstreamURL, { perMessageDeflate: true, handshakeTimeout: 12000 });
  upstream = socket;
  socket.on('open', () => {
    if (socket !== upstream) return;
    reconnectDelay = 2000;
    writeSubscription(); // Send immediately: AISstream requires this within 3 seconds.
  });
  socket.on('message', data => {
    if (socket !== upstream) return;
    let evt;
    try { evt = JSON.parse(data.toString()); } catch { return; }
    if (!evt || typeof evt !== 'object') return;
    if (evt.error || evt.Error) {
      notify({ type: 'error', message: 'AIS provider rejected the subscription. Check server configuration.' });
      return;
    }
    if (evt.MessageType === 'SubscriptionConfirmation') {
      notify({ type: 'status', state: 'connected' }); return;
    }
    const vessel = normalizeVessel(evt);
    if (!vessel) return;
    for (const [client, bbox] of aisClients) {
      if (inBounds(vessel.lat, vessel.lon, bbox)) send(client, { type: 'vessel', vessel });
    }
  });
  socket.on('error', () => console.warn('AIS upstream connection failed'));
  socket.on('close', () => {
    if (socket !== upstream) return;
    upstream = null;
    notify({ type: 'status', state: 'reconnecting' });
    if (aisClients.size) {
      reconnectTimer = setTimeout(connectUpstream, reconnectDelay);
      reconnectDelay = Math.min(30000, reconnectDelay * 2);
    }
  });
}

server.on('upgrade', (req, socket, head) => {
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (path !== '/stream/ais' || !isOriginAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  if (wsServer.clients.size >= MAX_AIS_VIEWERS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
  }
  wsServer.handleUpgrade(req, socket, head, client => wsServer.emit('connection', client));
});

wsServer.on('connection', client => {
  let subscribed = false;
  client.isAlive = true;
  client.on('pong', () => { client.isAlive = true; });
  const timeout = setTimeout(() => { if (!subscribed) client.close(1008, 'Subscribe within 10 seconds'); }, 10000);
  send(client, { type: 'status', state: AIS_KEY ? 'connecting' : 'unconfigured' });
  client.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || msg.action !== 'subscribe') return;
    const bbox = validateBoundingBox(msg.bbox);
    if (!bbox) { send(client, { type: 'error', message: 'Zoom in further: AIS area must be ≤8° latitude × 12° longitude.' }); return; }
    subscribed = true;
    clearTimeout(timeout);
    aisClients.set(client, bbox);
    if (!AIS_KEY) { send(client, { type: 'status', state: 'unconfigured' }); return; }
    if (!upstream) connectUpstream();
    else if (upstream.readyState === WebSocket.OPEN) {
      scheduleSubscription();
      send(client, { type: 'status', state: 'connected' });
    }
  });
  client.on('close', () => {
    clearTimeout(timeout);
    aisClients.delete(client);
    scheduleSubscription();
  });
  client.on('error', err => console.warn('Browser socket:', err.message));
});

const heartbeat = setInterval(() => {
  for (const client of wsServer.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    if (client.readyState === WebSocket.OPEN) client.ping();
  }
  if (upstream?.readyState === WebSocket.OPEN) upstream.ping();
}, 30000).unref();

server.on('close', () => { clearInterval(heartbeat); stopUpstream(); });
return { server, wsServer, port: PORT };
}

if (require.main === module) {
  const { server, port } = createServer();
  server.listen(port, () => console.log(`ATLAS backend listening on port ${port}, AIS configured: ${Boolean(process.env.AISSTREAM_API_KEY)}`));
}
module.exports = { createServer };
