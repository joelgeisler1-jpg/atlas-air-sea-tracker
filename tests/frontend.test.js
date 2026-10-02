'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(config = {}) {
  const elements = new Map();
  const timers = new Map();
  const intervals = [];
  const sockets = [];
  const requests = [];
  let timerId = 0;
  const classList = { add() {}, remove() {}, toggle() {} };
  const get = id => {
    if (!elements.has(id)) elements.set(id, { checked: true, value: '', classList, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  };
  const bounds = { contains: () => true, getSouth: () => -35, getWest: () => 138, getNorth: () => -34, getEast: () => 139 };
  const map = { setView() { return this; }, getCenter: () => ({ lat: -34.93, lng: 138.6 }), getZoom: () => 8, getBounds: () => bounds, on() {}, hasLayer: () => false, removeLayer() {} };
  const layer = () => ({ addTo() { return this; }, clearLayers() {}, removeLayer() {}, setLatLng() { return this; } });
  const markers = [];
  const L = { map: () => map, tileLayer: layer, control: { zoom: layer }, layerGroup: layer, circle: layer, polyline: layer, divIcon: x => x, marker: (_point, options) => {
    const marker = { ...layer(), options, handlers: {}, on(event, fn) { this.handlers[event] = fn; }, bindTooltip() {}, setIcon() {}, setTooltipContent() {} }; markers.push(marker); return marker;
  } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  const context = { window: { ATLAS_CONFIG: config }, document: { getElementById: get, querySelectorAll: () => [] }, L, WebSocket: Socket, AbortController, Date, console,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    fetch(_url, options) { return new Promise((resolve, reject) => requests.push({ resolve, reject, options })); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { get, sockets, requests, markers, intervals, flush() { const pending = [...timers]; timers.clear(); for (const [,fn] of pending) fn(); } };
}

test('frontend starts demo, filters targets and handles layer controls', () => {
  const app = load();
  assert.equal(app.get('mode-indicator').textContent, 'SIMULATED / DEMO');
  assert.equal(app.get('aircraft-count').textContent, '16');
  assert.equal(app.get('vessel-count').textContent, '18');
  app.get('search').value = 'ATD'; app.get('search').handlers.input(); app.flush();
  assert.equal(app.get('aircraft-count').textContent, '8');
  assert.equal(app.get('vessel-count').textContent, '0');
  app.get('toggle-aircraft').checked = false; app.get('toggle-aircraft').handlers.change(); app.flush();
  assert.equal(app.get('aircraft-count').textContent, 'OFF');
});

test('a late live response cannot overwrite demo mode', async () => {
  const app = load({ API_BASE: 'http://localhost:3000' });
  assert.equal(app.requests.length, 1); assert.equal(app.sockets.length, 1);
  app.get('demo-button').handlers.click();
  assert.equal(app.requests[0].options.signal.aborted, true);
  app.requests[0].resolve({ ok: true, json: async () => ({ aircraft: [] }) });
  await new Promise(setImmediate);
  assert.equal(app.get('mode-indicator').textContent, 'SIMULATED / DEMO');
  assert.equal(app.get('aircraft-count').textContent, '16');
});

test('frontend rejects malformed responses and renders empty successful feeds', async () => {
  const app = load({ API_BASE: 'http://localhost:3000' });
  app.requests[0].resolve({ ok: true, json: async () => ({ aircraft: {} }) });
  await new Promise(setImmediate);
  assert.equal(app.get('aircraft-status').textContent, 'Provider unavailable');
  app.get('refresh-button').handlers.click();
  app.requests[1].resolve({ ok: true, json: async () => ({ aircraft: [] }) });
  await new Promise(setImmediate);
  assert.equal(app.get('aircraft-status').textContent, 'Latest positions');
});

test('a stalled aircraft request times out with a useful status', async () => {
  const app = load({ API_BASE: 'http://localhost:3000' });
  app.flush();
  assert.equal(app.requests[0].options.signal.aborted, true);
  app.requests[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await new Promise(setImmediate);
  assert.equal(app.get('aircraft-status').textContent, 'Provider unavailable');
  assert.match(app.get('toast').textContent, /timed out/);
});
