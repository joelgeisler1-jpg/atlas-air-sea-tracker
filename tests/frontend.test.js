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
  const map = { setView(coords,zoom) { this.lastView={coords,zoom};return this; }, panTo(coords) {this.getCenter=()=>({lat:coords[0],lng:coords[1]});return this;}, getCenter: () => ({ lat: -34.93, lng: 138.6 }), zoom: 8, handlers: {}, getZoom() { return this.zoom; }, getBounds: () => bounds, on(event, fn) { this.handlers[event]=fn; }, hasLayer: () => false, removeLayer() {} };
  const layer = () => ({ addTo() { return this; }, clearLayers() {}, removeLayer() {}, setLatLng(point) {this.position=point;return this;} });
  const navButtons=['adelaide','singapore','rotterdam','newyork'].map(place=>({dataset:{place},handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}}));
  const markers = [];
  const trails = [];
  const L = { map: () => map, tileLayer: layer, control: { zoom: layer }, layerGroup: layer, circle: layer, polyline: points => {trails.push(points);return layer();}, divIcon: x => x, marker: (_point, options) => {
    const marker = { ...layer(), position:_point, options, handlers: {}, on(event, fn) { this.handlers[event] = fn; }, bindTooltip() {}, setIcon(icon) {this.options.icon=icon;}, setTooltipContent() {} }; markers.push(marker); return marker;
  } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(data) {this.lastSent=JSON.parse(data);}
  }
  const context = { window: { ATLAS_CONFIG: config }, document: { getElementById: get, querySelectorAll: () => navButtons }, L, WebSocket: Socket, AbortController, Date, console,
    setTimeout(fn, delay) { const id = ++timerId; fn.delay=delay; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { fn.delay=delay;intervals.push(fn);return intervals.length; }, clearInterval(id) { if(id) intervals[id-1]=null; },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject, options })); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../target-model.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { navButtons,get, sockets, requests, markers, trails, intervals, map, bounds,
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

test('persistent tags obey zoom/toggle and keep the selected tag visible',()=>{
  const app=load();assert.ok(app.markers.every(m=>!m.options.icon.html.includes('target-tag')));
  app.map.zoom=9;app.get('search').handlers.input();app.runTimeout(220);
  assert.ok(app.markers.some(m=>m.options.icon.html.includes('target-tag')));
  app.get('toggle-tags').handlers.change({target:{checked:false}});app.runTimeout(220);
  assert.ok(app.markers.every(m=>!m.options.icon.html.includes('target-tag')));
  app.map.zoom=8;app.markers[0].handlers.click();app.runTimeout(220);
  assert.ok(app.markers[0].options.icon.html.includes('target-tag'));
  assert.match(app.get('target-card').innerHTML,/CALLSIGN/);assert.match(app.get('target-card').innerHTML,/TRACK/);
});

test('photo fetch is selected-only, failure leaves aircraft details intact',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});
  app.requests[0].resolve({ok:true,json:async()=>({aircraft:[{kind:'aircraft',id:'7C1234',lat:-34.8,lon:138.5,callsign:'QFA741',registration:'VH-X',type:'B738',altitudeFt:34000,trackDeg:82,speedKt:452,updatedAt:Date.now()}]})});
  await settle();app.runTimeout(220);
  assert.equal(app.requests.filter(r=>r.url.includes('aircraft-photo')).length,0);
  app.markers[0].handlers.click();
  const photo=app.requests.find(r=>r.url.includes('aircraft-photo'));assert.ok(photo);
  photo.reject(new Error('Network failed'));await settle();app.runTimeout(220);
  assert.match(app.get('target-card').innerHTML,/QFA741/);assert.match(app.get('target-card').innerHTML,/082°/);assert.doesNotMatch(app.get('target-card').innerHTML,/<img/);
  app.runTimeout(220);assert.equal(app.requests.filter(r=>r.url.includes('aircraft-photo')).length,1);
});

test('photo success has attribution, lazy loading and clean image failure handling',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});
  app.requests[0].resolve({ok:true,json:async()=>({aircraft:[{kind:'aircraft',id:'7C1234',lat:-34.8,lon:138.5,updatedAt:Date.now()}]})});await settle();app.runTimeout(220);app.markers[0].handlers.click();
  app.requests.find(r=>r.url.includes('aircraft-photo')).resolve({ok:true,json:async()=>({photo:{thumbnailUrl:'https://cdn.planespotters.net/test.jpg',sourcePage:'https://www.planespotters.net/photo/test',photographer:'Test Author'}})});await settle();app.runTimeout(220);
  assert.match(app.get('target-card').innerHTML,/© Test Author/);assert.match(app.get('target-card').innerHTML,/loading="lazy"/);
  app.get('target-photo').onerror();assert.equal(app.get('aircraft-photo-wrap').hidden,true);
});

test('aircraft static fields survive less-complete snapshots',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});const now=Date.now();
  app.requests[0].resolve({ok:true,json:async()=>({aircraft:[{kind:'aircraft',id:'7C1234',lat:-34.8,lon:138.5,callsign:'QFA1',type:'B738',registration:'VH-X',updatedAt:now}]})});await settle();
  app.get('refresh-button').handlers.click();const request=app.requests.filter(r=>r.url.includes('/api/aircraft?')).at(-1);
  request.resolve({ok:true,json:async()=>({aircraft:[{kind:'aircraft',id:'7C1234',lat:-34.79,lon:138.5,callsign:'',type:'',registration:'',updatedAt:now+1000}]})});await settle();app.runTimeout(220);app.markers[0].handlers.click();
  assert.match(app.get('target-card').innerHTML,/QFA1/);assert.match(app.get('target-card').innerHTML,/B738/);assert.match(app.get('target-card').innerHTML,/VH-X/);
});

test('dense tags avoid collisions and place phone-edge labels to the left',()=>{
  const app=load();app.map.zoom=9;app.map.getSize=()=>({x:390,y:844});app.map.latLngToContainerPoint=()=>({x:330,y:400});
  app.get('search').handlers.input();app.runTimeout(220);
  const tagged=app.markers.filter(m=>m.options.icon.html.includes('target-tag'));
  assert.equal(tagged.length,1);assert.match(tagged[0].options.icon.html,/tag-left/);
  app.markers[16].handlers.click();app.runTimeout(220);
  const selected=app.markers.filter(m=>m.options.icon.html.includes('target-tag'));
  assert.equal(selected.length,1);assert.match(selected[0].options.icon.html,/selected/);
});

test('military aircraft have crimson styling and MIL badges; filter keeps vessels visible',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});const now=Date.now();
  const military={kind:'aircraft',id:'43C123',lat:-34.8,lon:138.5,callsign:'RFR7123',type:'A400M',altitudeFt:21000,trackDeg:164,speedKt:318,dbFlags:1,military:true,updatedAt:now};
  const civilian={...military,id:'7C1234',callsign:'QFA741',type:'B738',dbFlags:2,military:false};
  app.map.zoom=9;
  app.requests[0].resolve({ok:true,json:async()=>({aircraft:[military,civilian]})});await settle();
  message(app.sockets[0],{type:'vessel',vessel:vessel()});app.runTimeout(220);
  assert.equal(app.get('aircraft-count').textContent,'2');assert.equal(app.get('vessel-count').textContent,'1');
  const marker=app.markers.find(m=>m.options.title==='RFR7123');
  assert.match(marker.options.icon.html,/aircraft military/);assert.match(marker.options.icon.html,/mil-badge.*MIL/);
  assert.doesNotMatch(app.markers.find(m=>m.options.title==='QFA741').options.icon.html,/mil-badge|aircraft military/);
  assert.doesNotMatch(app.markers.find(m=>m.options.title==='TEST SHIP').options.icon.html,/mil-badge|vessel military/);
  marker.handlers.click();assert.match(app.get('target-card').innerHTML,/CLASSIFICATION/);assert.match(app.get('target-card').innerHTML,/military-badge.*MILITARY/);
  app.get('toggle-military').handlers.change({target:{checked:true}});app.runTimeout(220);
  assert.equal(app.get('aircraft-count').textContent,'1');assert.equal(app.get('vessel-count').textContent,'1');
  assert.doesNotMatch(app.markers.find(m=>m.options.title==='QFA741').options.icon.html,/mil-badge/);
  app.get('search').value='MILITARY';app.get('search').handlers.input();app.runTimeout(220);
  assert.equal(app.get('aircraft-count').textContent,'0');assert.equal(app.get('vessel-count').textContent,'0');
  app.get('search').value='';app.get('toggle-military').handlers.change({target:{checked:false}});app.runTimeout(220);
  assert.equal(app.get('aircraft-count').textContent,'2');assert.equal(app.get('vessel-count').textContent,'1');
});

test('repeated-world ADS-B requests and coordinate readouts use wrapped longitude',()=>{
  const app=load({API_BASE:'http://localhost:3000'});
  for(const [lon,expected,readout] of [[190,-170,'170.00°W'],[370,10,'10.00°E'],[-190,170,'170.00°E'],[179.99999,-180,'180.00°E']]){
    app.map.getCenter=()=>({lat:0,lng:lon});app.map.handlers.move();app.get('refresh-button').handlers.click();app.runTimeout(220);
    const route=app.requests.filter(r=>r.url.includes('/api/aircraft?')).at(-1);
    assert.equal(Number(new URL(route.url).searchParams.get('lon')),expected);
    assert.ok(app.get('coordinates').textContent.includes(readout));
  }
});

test('date-line AIS subscription uses two boxes on one socket and snapshots deduplicate MMSI',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});app.map.getCenter=()=>({lat:-34.5,lng:180});
  app.bounds.getWest=()=>179;app.bounds.getEast=()=>181;
  const socket=app.sockets[0];socket.readyState=1;socket.onopen();
  assert.deepEqual(socket.lastSent,{action:'subscribe',bboxes:[[-35,179,-34,180],[-35,-180,-34,-179]]});
  message(socket,{type:'status',state:'reconnecting'});
  const requests=marineRequests(app);assert.equal(requests.length,2);assert.equal(app.sockets.length,1);
  assert.equal(new URL(requests[0].url).searchParams.get('bbox'),'-35,179,-34,180');
  assert.equal(new URL(requests[1].url).searchParams.get('bbox'),'-35,-180,-34,-179');
  const time=Date.now();await snapshot(requests[0],[{...vessel(),lon:179.9,updatedAt:time}]);
  await snapshot(requests[1],[{...vessel(),lon:-179.9,updatedAt:time+1000}]);app.runTimeout(220);
  assert.equal(app.get('vessel-count').textContent,'1');
  const marker=app.markers.find(m=>m.options.title==='TEST SHIP');assert.ok(Math.abs(marker.position[1]-180.1)<1e-8);
  marker.handlers.click();assert.match(app.get('target-card').innerHTML,/179.90°W/);
});

test('aircraft markers, tags, selection and trails follow the visible world without duplicates',async()=>{
  const app=load({API_BASE:'http://localhost:3000'});app.map.getCenter=()=>({lat:0,lng:540});app.map.zoom=9;
  app.bounds.contains=point=>point[1]>=539&&point[1]<=541;
  const raw={kind:'aircraft',id:'43C123',callsign:'RFR7123',lat:0,lon:179.9,military:true,dbFlags:1,updatedAt:Date.now()};
  app.requests[0].resolve({ok:true,json:async()=>({aircraft:[raw]})});await settle();app.runTimeout(220);
  const marker=app.markers.find(m=>m.options.title==='RFR7123');assert.ok(marker);assert.ok(Math.abs(marker.position[1]-539.9)<1e-8);
  marker.handlers.click();assert.match(app.get('target-card').innerHTML,/CLASSIFICATION/);
  app.get('refresh-button').handlers.click();const request=app.requests.filter(r=>r.url.includes('/api/aircraft?')).at(-1);
  request.resolve({ok:true,json:async()=>({aircraft:[{...raw,lon:-179.9,updatedAt:raw.updatedAt+1000}]})});await settle();app.runTimeout(220);
  assert.equal(app.get('aircraft-count').textContent,'1');assert.equal(app.markers.filter(m=>m.options.title==='RFR7123').length,1);
  assert.ok(Math.abs(marker.position[1]-540.1)<1e-8);assert.match(marker.options.icon.html,/target-tag/);
  assert.ok(app.trails.some(points=>points.length===2&&Math.abs(points[1][1]-points[0][1])<0.21));
});

test('latitude stays bounded while quick navigation retains canonical coordinates',()=>{
  const app=load();app.map.getCenter=()=>({lat:89,lng:542});app.map.handlers.moveend();
  assert.equal(app.map.getCenter().lat,84);assert.equal(app.map.getCenter().lng,542);
  const expected={adelaide:[-34.93,138.60,8],singapore:[1.29,103.85,9],rotterdam:[51.92,4.48,9],newyork:[40.70,-74,9]};
  for(const button of app.navButtons){button.handlers.click();const coords=expected[button.dataset.place];assert.equal(app.map.lastView.coords[1],coords[1]);assert.equal(app.map.lastView.zoom,coords[2]);}
});
