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
  const map = { setView() { return this; }, getCenter: () => ({ lat: -34.93, lng: 138.6 }), zoom: 8, handlers: {}, getZoom() { return this.zoom; }, getBounds: () => bounds, on(event, fn) { this.handlers[event]=fn; }, hasLayer: () => false, removeLayer() {} };
  const layer = () => ({ addTo() { return this; }, clearLayers() {}, removeLayer() {}, setLatLng() { return this; } });
  const markers = [];
  const trails = [];
  const L = { map: () => map, tileLayer: layer, control: { zoom: layer }, layerGroup: layer, circle: layer, polyline: points => {trails.push(points);return layer();}, divIcon: x => x, marker: (_point, options) => {
    const marker = { ...layer(), options, handlers: {}, on(event, fn) { this.handlers[event] = fn; }, bindTooltip() {}, setIcon() {}, setTooltipContent() {} }; markers.push(marker); return marker;
  } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  const context = { window: { ATLAS_CONFIG: config }, document: { getElementById: get, querySelectorAll: () => [] }, L, WebSocket: Socket, AbortController, Date, console,
    setTimeout(fn, delay) { const id = ++timerId; fn.delay=delay; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { fn.delay=delay;intervals.push(fn);return intervals.length; }, clearInterval(id) { if(id) intervals[id-1]=null; },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject, options })); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { get, sockets, requests, markers, trails, intervals, map, bounds,
    runTimeout(delay) {for(const [id,fn] of [...timers]) if(fn.delay===delay){timers.delete(id);fn();}},
    runInterval(delay) {for(const fn of [...intervals]) if(fn?.delay===delay) fn();},
    flush() { const pending = [...timers]; timers.clear(); for (const [,fn] of pending) fn(); } };
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

const vessel = (id = '123456789', lat = -34.8, time = Date.now()) => ({ kind: 'vessel', id, lat, lon: 138.5, name: 'TEST SHIP', speedKt: 8.5, heading: 90, updatedAt: time });
const settle = () => new Promise(setImmediate);
const marineRequests = app => app.requests.filter(request => request.url.includes('/api/vessels'));
const snapshot = async (request, vessels = [vessel()]) => {request.resolve({ ok: true, json: async () => ({ vessels, attribution: ['AISHub'] }) });await settle();};
const message = (socket, data) => socket.onmessage({ data: JSON.stringify(data) });

for(const reason of ['abnormal-close','no-subscription','quiet-subscription','upstream-reconnecting','unconfigured']) {
  test(`AIS ${reason} enables Open Waters fallback`, async () => {
    const app=load({API_BASE:'http://localhost:3000'});
    const socket=app.sockets[0];socket.readyState=1;socket.onopen();
    if(reason==='abnormal-close') socket.onclose({code:1006});
    if(reason==='no-subscription') app.runTimeout(20000);
    if(reason==='quiet-subscription') {message(socket,{type:'status',state:'connected'});app.runTimeout(60000);}
    if(reason==='upstream-reconnecting') message(socket,{type:'status',state:'reconnecting'});
    if(reason==='unconfigured') message(socket,{type:'status',state:'unconfigured'});
    assert.equal(marineRequests(app).length,1);
    assert.equal(new URL(marineRequests(app)[0].url).searchParams.get('bbox'),'-35,138,-34,139');
    await snapshot(marineRequests(app)[0]);app.runTimeout(220);
    assert.equal(app.get('vessel-status').textContent,'Open Waters live');
    assert.equal(app.get('vessel-count').textContent,'1');
    app.runInterval(25000);assert.equal(marineRequests(app).length,2);
  });
}

test('AIS recovery deduplicates MMSI, retains trails, and ignores late snapshot replies', async () => {
  const app=load({API_BASE:'http://localhost:3000'});const socket=app.sockets[0];socket.readyState=1;
  message(socket,{type:'status',state:'reconnecting'});
  const time=Date.now();
  await snapshot(marineRequests(app)[0],[vessel('123456789',-34.8,time),vessel(123456789,-34.8,time)]);
  app.runTimeout(220);assert.equal(app.get('vessel-count').textContent,'1');
  app.runInterval(25000);const pending=marineRequests(app)[1];
  message(socket,{type:'status',state:'connected'});
  assert.equal(app.get('vessel-status').textContent,'Open Waters live');
  message(socket,{type:'vessel',vessel:vessel('123456789',-34.79,time+1000)});
  assert.equal(pending.options.signal.aborted,true);
  assert.equal(app.get('vessel-status').textContent,'AISstream live');
  await snapshot(pending,[vessel('123456789',-34.7,time+2000),vessel('987654321')]);
  app.runTimeout(220);assert.equal(app.get('vessel-count').textContent,'1');
  assert.ok(app.trails.some(points=>points.length===2 && points[0][0]===-34.8 && points[1][0]===-34.79));
  app.runInterval(25000);assert.equal(marineRequests(app).length,2);
});

for(const reason of ['disabled','zoomed-out','oversized','demo']) {
  test(`fallback stops for ${reason} and ignores late replies`, async () => {
    const app=load({API_BASE:'http://localhost:3000'});
    message(app.sockets[0],{type:'status',state:'unconfigured'});
    const pending=marineRequests(app)[0];
    if(reason==='disabled') {app.get('toggle-vessels').checked=false;app.get('toggle-vessels').handlers.change();}
    if(reason==='zoomed-out') {app.map.zoom=3;app.map.handlers.moveend();app.runTimeout(900);}
    if(reason==='oversized') {app.bounds.getNorth=()=>0;app.map.handlers.moveend();app.runTimeout(900);}
    if(reason==='demo') app.get('demo-button').handlers.click();
    assert.equal(pending.options.signal.aborted,true);
    await snapshot(pending);app.runTimeout(220);
    app.runInterval(25000);assert.equal(marineRequests(app).length,1);
    assert.notEqual(app.get('vessel-status').textContent,'Open Waters live');
  });
}

test('Open Waters failures show unavailable and polling retries', async () => {
  const app=load({API_BASE:'http://localhost:3000'});
  message(app.sockets[0],{type:'status',state:'unconfigured'});
  marineRequests(app)[0].resolve({ok:false,json:async()=>({error:'unavailable'})});await settle();
  assert.equal(app.get('vessel-status').textContent,'Marine feed unavailable');
  app.runInterval(25000);await snapshot(marineRequests(app)[1]);
  assert.equal(app.get('vessel-status').textContent,'Open Waters live');
});

test('healthy AIS confirmation and vessel messages keep fallback polling off', () => {
  const app=load({API_BASE:'http://localhost:3000'});
  message(app.sockets[0],{type:'status',state:'connected'});
  message(app.sockets[0],{type:'vessel',vessel:vessel()});
  app.runTimeout(220);
  assert.equal(app.get('vessel-status').textContent,'AISstream live');
  assert.equal(app.get('vessel-count').textContent,'1');
  assert.equal(marineRequests(app).length,0);
});

test('snapshot polls do not overlap and a timeout allows the next retry', async () => {
  const app=load({API_BASE:'http://localhost:3000'});
  message(app.sockets[0],{type:'status',state:'unconfigured'});
  app.runInterval(25000);assert.equal(marineRequests(app).length,1);
  app.runTimeout(12000);assert.equal(marineRequests(app)[0].options.signal.aborted,true);
  marineRequests(app)[0].reject(Object.assign(new Error('aborted'),{name:'AbortError'}));await settle();
  assert.equal(app.get('vessel-status').textContent,'Marine feed unavailable');
  app.runInterval(25000);assert.equal(marineRequests(app).length,2);
});

test('viewport changes refresh fallback immediately with the new bounds', async () => {
  const app=load({API_BASE:'http://localhost:3000'});
  message(app.sockets[0],{type:'status',state:'unconfigured'});
  const previous=marineRequests(app)[0];
  app.bounds.getWest=()=>138.1;app.map.handlers.moveend();app.runTimeout(900);
  assert.equal(previous.options.signal.aborted,true);
  const next=marineRequests(app)[1];assert.equal(new URL(next.url).searchParams.get('bbox'),'-35,138.1,-34,139');
  await snapshot(previous,[vessel('987654321')]);await snapshot(next);app.runTimeout(220);
  assert.equal(app.get('vessel-count').textContent,'1');
});
