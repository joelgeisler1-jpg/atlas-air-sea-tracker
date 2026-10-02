/* ATLAS — view-scoped aircraft + AIS vessel map.
 * Github Pages is static. Live API calls go to the separately hosted backend.
 * Never paste provider API keys into this or config.js.
 */
(() => {
  'use strict';
  const cfg = window.ATLAS_CONFIG || {};
  const base = String(cfg.API_BASE || '').replace(/\/$/, '');
  const refreshMs = Math.max(15000, Number(cfg.AIRCRAFT_REFRESH_MS) || 20000);
  const minZoom = Math.max(4, Number(cfg.MIN_LIVE_ZOOM) || 6);
  const get = id => document.getElementById(id);
  const state = {
    demo: !base, airOn: true, seaOn: true, trailsOn: true, auto: true,
    aircraft: new Map(), vessels: new Map(), history: new Map(), markers: new Map(),
    selection: null, socket: null, reconnectTimer: null, moveTimer: null,
    renderTimer: null, demoTimer: null, fetchController: null, pollTimer: null,
    lastAisMessage: 0, lastUpdate: 0, flightRegion: null, demoStep: 0,
    aisConnected: false, aisError: false, aisOutOfRange: false,
    flightError: false, lastFetchRegion: '', requestTimer: null
  };
  const places = {
    adelaide: [-34.93, 138.60, 8], singapore: [1.29, 103.85, 9],
    rotterdam: [51.92, 4.48, 9], newyork: [40.70, -74.00, 9]
  };
  const map = L.map('map', {
    preferCanvas: true, zoomControl: false, worldCopyJump: false,
    minZoom: 2, maxZoom: 15, maxBounds: [[-84,-180],[84,180]], maxBoundsViscosity: .85
  }).setView([-34.93, 138.60], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19, noWrap: true, className: 'atlas-map-tile'
  }).addTo(map);
  L.control.zoom({ position:'topleft' }).addTo(map);
  const markerGroup = L.layerGroup().addTo(map);
  const trailGroup = L.layerGroup().addTo(map);
  const coverageRing = L.circle([-34.93,138.6], {radius:250*1852, color:'#e8ad62', weight:1, dashArray:'6,8', opacity:.28, fill:false, interactive:false});

  const numberText = n => Number.isFinite(n) ? n.toLocaleString('en-AU') : '—';
  const safe = val => String(val ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const coord = (n, pos, neg) => `${Math.abs(n).toFixed(2)}°${n >= 0 ? pos : neg}`;
  const label = x => x.kind === 'aircraft' ? (x.callsign || x.registration || x.id) : (x.name || x.id);
  const infoTime = time => time ? new Date(time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '—';
  const validPoint = x => Number.isFinite(x?.lat) && Number.isFinite(x?.lon) && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180;
  const targetKey = x => `${x.kind}:${x.id}`;

  let toastTimer;
  function toast(message) {
    get('toast').textContent = message;
    get('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => get('toast').classList.remove('visible'), 4900);
  }
  function setFeedStatus(feed, text, condition='') {
    const isAir = feed === 'aircraft';
    get(isAir ? 'aircraft-status' : 'vessel-status').textContent = text;
    get(isAir ? 'aircraft-led' : 'vessel-led').className = `led ${condition}`;
  }
  function updateHeader() {
    get('mode-indicator').textContent = state.demo ? 'SIMULATED / DEMO' : 'LIVE FEEDS';
    get('mode-indicator').className = `mode-badge ${state.demo ? 'demo':'live'}`;
    get('demo-button').textContent = state.demo && base ? 'EXIT DEMO' : 'VIEW DEMO';
    get('updated-at').textContent = state.lastUpdate ? `Updated ${infoTime(state.lastUpdate)}` : 'Awaiting update';
  }
  function showCounts() {
    const search = get('search').value.trim().toLowerCase();
    const visible = x => !search || [x.id, label(x), x.callsign, x.registration, x.type].some(s => String(s||'').toLowerCase().includes(search));
    const bounds = map.getBounds();
    get('aircraft-count').textContent = state.airOn ? numberText([...state.aircraft.values()].filter(x=>bounds.contains([x.lat,x.lon])&&visible(x)).length) : 'OFF';
    get('vessel-count').textContent = state.seaOn ? numberText([...state.vessels.values()].filter(x=>bounds.contains([x.lat,x.lon])&&visible(x)).length) : 'OFF';
  }
  function renderSelected() {
    const selection = state.selection;
    const item = selection?.startsWith('aircraft:') ? state.aircraft.get(selection.slice(9))
      : selection?.startsWith('vessel:') ? state.vessels.get(selection.slice(7)) : null;
    if (!item) {
      get('target-card').innerHTML = '<div class="empty-target"><div class="empty-target-icon">⌖</div><strong>No target selected</strong><span>Tap an aircraft or vessel on the map to inspect its live position.</span></div>';
      return;
    }
    const aircraft = item.kind === 'aircraft';
    const rows = aircraft ? [
      ['ICAO HEX',item.id], ['REGISTRATION',item.registration || 'Unknown'],
      ['ALTITUDE',item.altitudeFt == null ? '—' : `${numberText(item.altitudeFt)} ft`],
      ['GROUND SPEED',item.speedKt == null ? '—' : `${numberText(item.speedKt)} kt`],
      ['TRACK',item.heading == null ? '—' : `${Math.round(item.heading)}°`],
      ['AIRCRAFT TYPE',item.type || 'Unknown']
    ] : [
      ['MMSI',item.id], ['SPEED OVER GROUND',item.speedKt == null ? '—' : `${item.speedKt.toFixed(1)} kt`],
      ['COURSE / HEADING',item.heading == null ? '—' : `${Math.round(item.heading)}°`],
      ['LATITUDE',coord(item.lat,'N','S')], ['LONGITUDE',coord(item.lon,'E','W')],
      ['LAST MESSAGE',infoTime(item.updatedAt)]
    ];
    get('target-card').innerHTML = `<div class="target-title"><div><span class="label">${aircraft?'AIRBORNE TARGET':'MARITIME TARGET'}</span><strong>${safe(label(item))}</strong></div><span class="type-pill ${aircraft?'':'vessel'}">${aircraft?'ADS-B':'AIS'}</span></div><dl class="target-grid">${rows.map(([k,v])=>`<div><dt>${safe(k)}</dt><dd>${safe(v)}</dd></div>`).join('')}</dl>`;
  }

  function symbol(x, selected) {
    const angle = Number.isFinite(x.heading) ? x.heading : 0;
    const path = x.kind === 'aircraft'
      ? '<path d="M12 1.2c-.6 0-1.1.6-1.1 1.5v7l-8 5v2l8-2.5v5.4l-2.4 1.8V23l3.5-1.1 3.5 1.1v-1.6l-2.4-1.8v-5.4l8 2.5v-2l-8-5v-7c0-.9-.5-1.5-1.1-1.5Z"/>'
      : '<path d="M12 1 19.6 20.3 12 16.9 4.4 20.3 12 1Z"/><path d="M9 19.5 12 21l3-1.5" fill="none" stroke-width="1.5"/>';
    return L.divIcon({ className:'marker-wrap', html:`<div class="traffic-marker ${x.kind} ${selected?'selected':''}"><svg viewBox="0 0 24 24" style="transform:rotate(${angle}deg)">${path}</svg></div>`, iconSize:[27,27],iconAnchor:[13,13] });
  }

  function markHistory(x) {
    const key = targetKey(x);
    let track = state.history.get(key);
    if (!track) { track=[]; state.history.set(key,track); }
    const previous = track.at(-1);
    const moved = !previous || Math.abs(previous[0]-x.lat) + Math.abs(previous[1]-x.lon) > 0.0002;
    const plausible = !previous || Math.abs(previous[0]-x.lat) < 5 && Math.abs(previous[1]-x.lon) < 5;
    if (!plausible) track=[];
    if (moved) track.push([x.lat,x.lon, x.updatedAt]);
    if (track.length > 55) track.splice(0, track.length-55);
    state.history.set(key,track);
  }

  function upsert(x) {
    if (!validPoint(x) || !x.id || !['aircraft','vessel'].includes(x.kind)) return;
    (x.kind === 'aircraft' ? state.aircraft : state.vessels).set(x.id,x);
    markHistory(x);
    state.lastUpdate = Date.now();
    queueRender();
  }
  function queueRender() {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => { state.renderTimer=null; render(); }, 220);
  }
  function render() {
    const bounds = map.getBounds();
    const search = get('search').value.toLowerCase().trim();
    const filtered = x => bounds.contains([x.lat,x.lon]) && (!search ||
      [x.id,x.callsign,x.registration,x.name,x.type].some(t => String(t||'').toLowerCase().includes(search)));
    const next = new Set();
    let trackCount = 0;
    trailGroup.clearLayers();
    for (const [enabled, collection] of [[state.airOn,state.aircraft],[state.seaOn,state.vessels]]) {
      if (!enabled) continue;
      let count=0;
      for (const x of collection.values()) {
        if (count>=1800) break;
        if (!filtered(x)) continue;
        count++;
        const key = targetKey(x);
        next.add(key);
        let marker = state.markers.get(key);
        if (!marker) {
          marker = L.marker([x.lat,x.lon], {icon:symbol(x,key===state.selection),keyboard:true, title:label(x)});
          marker.on('click',()=> { state.selection=key; renderSelected(); queueRender(); });
          marker.bindTooltip(safe(label(x)), {direction:'top', offset:[0,-11]});
          state.markers.set(key,marker);
          marker.addTo(markerGroup);
        } else {
          marker.setLatLng([x.lat,x.lon]);
          marker.setIcon(symbol(x,key===state.selection));
          marker.setTooltipContent(safe(label(x)));
        }
        if (state.trailsOn && trackCount < 220) {
          const points = state.history.get(key);
          if (points?.length>=2) {
            L.polyline(points.map(p=>[p[0],p[1]]), {
              color:x.kind==='aircraft'?'#efab57':'#53d7e6', weight:key===state.selection?3:1.7,
              opacity:key===state.selection ? .9 : .38, dashArray:x.kind==='aircraft'?'5 5':null,
              interactive:false, smoothFactor:2
            }).addTo(trailGroup);
            trackCount++;
          }
        }
      }
    }
    for (const [k,marker] of state.markers) if (!next.has(k)) { markerGroup.removeLayer(marker); state.markers.delete(k); }
    showCounts(); renderSelected(); updateHeader();
    const center = map.getCenter();
    get('coordinates').textContent = `${coord(center.lat,'N','S')} · ${coord(center.lng,'E','W')}`;
    if (!state.demo && state.airOn && map.getZoom() >= minZoom) {
      coverageRing.setLatLng(center);
      if (!map.hasLayer(coverageRing)) coverageRing.addTo(map);
    } else if (map.hasLayer(coverageRing)) map.removeLayer(coverageRing);
    let note='';
    if (state.demo) note = 'DEMO · Synthetic positions only. Configure the backend for live traffic.';
    else if (map.getZoom() < minZoom) note = `Zoom to level ${minZoom}+ to request local ADS-B and AIS traffic.`;
    else if (state.aisOutOfRange) note = 'AIS: zoom in to a smaller area (max 8° latitude × 12° longitude). Aircraft search is within the dashed 250 NM circle.';
    else note = 'ADS-B: dashed 250 NM radius around map centre · AIS: current viewport · Trails build from received positions.';
    get('coverage-note').textContent = note;
  }

  function clearTraffic() {
    state.aircraft.clear(); state.vessels.clear(); state.history.clear();
    state.selection=null; state.lastUpdate=0;
    state.lastFetchRegion='';
    for (const marker of state.markers.values()) markerGroup.removeLayer(marker);
    state.markers.clear(); trailGroup.clearLayers(); queueRender();
  }
  function shutDownLive() {
    if (state.fetchController) state.fetchController.abort();
    clearTimeout(state.requestTimer);
    state.fetchController=null;
    state.aisOutOfRange=false;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer=null;
    const sock=state.socket; state.socket=null;
    if (sock) sock.close(1000,'Client switched modes');
    state.aisConnected=false;
  }
  function stopDemo() { clearInterval(state.demoTimer); state.demoTimer=null; }

  function seedDemo() {
    clearTraffic();
    state.demoStep=0;
    const centre = map.getCenter();
    const presets = [
      {kind:'aircraft',prefix:'ATD',speed:385,alt:32000},
      {kind:'aircraft',prefix:'FLY',speed:460,alt:37500},
      {kind:'vessel',prefix:'DEMO SHIP',speed:13,alt:null}
    ];
    for (let i=0;i<34;i++) {
      const p=i<16?presets[i%2]:presets[2];
      const angle=(i*137.51)%360;
      const spread=i<16?.12:.24;
      const radial=spread*(.28+(i%9)/9);
      const lat=Math.max(-80,Math.min(80,centre.lat+Math.sin(angle*Math.PI/180)*radial));
      const lon=Math.max(-179,Math.min(179,centre.lng+Math.cos(angle*Math.PI/180)*radial));
      const x={ kind:p.kind,id:String(900000+i),lat,lon,heading:(angle+65)%360,
        speedKt:p.speed+(i%4)*(p.kind==='vessel'?1.5:10),updatedAt:Date.now() };
      if (p.kind==='aircraft') Object.assign(x,{callsign:`${p.prefix}${(200+i*13)}`,registration:`DEMO-${i+1}`,type:i%2?'B738':'A320',altitudeFt:p.alt+(i%6)*1100});
      else x.name=`${p.prefix} ${String(i-15).padStart(2,'0')}`;
      upsert(x);
    }
    setFeedStatus('aircraft',state.airOn?'Simulated aircraft':'Layer hidden',state.airOn?'warn':'');
    setFeedStatus('vessels',state.seaOn?'Simulated vessels':'Layer hidden',state.seaOn?'warn':'');
    render();
  }
  function stepDemo() {
    if (!state.demo || !state.auto) return;
    state.demoStep++;
    for (const x of [...state.aircraft.values(),...state.vessels.values()]) {
      const distanceNm=(x.speedKt || 5)*4/3600;
      const theta=(x.heading||0)*Math.PI/180;
      const dy=(distanceNm/60)*Math.cos(theta);
      const dx=(distanceNm/60)*Math.sin(theta)/Math.max(.2,Math.cos(x.lat*Math.PI/180));
      x.lat+=dy;x.lon+=dx;x.updatedAt=Date.now();
      if (validPoint(x)) upsert(x);
    }
  }
  function startDemo() {
    shutDownLive(); stopDemo(); state.demo=true; clearTraffic();
    seedDemo(); state.demoTimer=setInterval(stepDemo,4000);
  }

  async function refreshAircraft(force=false) {
    if (state.demo || !state.airOn || !state.auto && !force || map.getZoom()<minZoom) return;
    const center=map.getCenter();
    const region=`${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
    if (!force && region===state.lastFetchRegion && Date.now()-state.flightRegion<refreshMs-2000) return;
    state.lastFetchRegion=region;
    state.flightRegion=Date.now();
    if (state.fetchController) state.fetchController.abort();
    const controller=new AbortController();state.fetchController=controller;
    clearTimeout(state.requestTimer);
    let timedOut=false;
    state.requestTimer=setTimeout(()=>{timedOut=true;controller.abort();},20000);
    setFeedStatus('aircraft','Fetching positions…','warn');
    try {
      const response=await fetch(`${base}/api/aircraft?lat=${center.lat.toFixed(4)}&lon=${center.lng.toFixed(4)}&radius=250`, {signal:controller.signal,cache:'no-store'});
      const body=await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (state.demo || controller!==state.fetchController) return;
      if (!Array.isArray(body.aircraft)) throw new Error('Invalid aircraft response');
      state.aircraft.clear();
      for (const x of body.aircraft) if (x?.kind==='aircraft') upsert(x);
      state.lastUpdate=Date.now();
      setFeedStatus('aircraft',body.stale?'Cached positions':'Latest positions',body.stale?'warn':'active');
      state.flightError=false;
      queueRender();
    } catch (err) {
      if (controller!==state.fetchController || state.demo || !state.airOn) return;
      if (err.name==='AbortError' && !timedOut) return;
      state.flightError=true;state.lastFetchRegion='';
      setFeedStatus('aircraft','Provider unavailable','warn');
      toast(`Aircraft feed: ${timedOut ? 'Request timed out. Retry shortly.' : err.message}`);
      queueRender();
    } finally {
      if (controller===state.fetchController) {
        clearTimeout(state.requestTimer);state.fetchController=null;
      }
    }
  }

  function currentBbox() {
    const b=map.getBounds();
    return [b.getSouth(),b.getWest(),b.getNorth(),b.getEast()].map(n=>Number(n.toFixed(5)));
  }
  function bboxAllowed(b) {
    return b[0]>=-90 && b[2]<=90 && b[1]>=-180 && b[3]<=180 &&
      b[0]<b[2] && b[1]<b[3] && b[2]-b[0]<=8 && b[3]-b[1]<=12;
  }
  function openAis() {
    if (state.demo || !state.seaOn || map.getZoom()<minZoom) return;
    const bbox=currentBbox();
    state.aisOutOfRange=!bboxAllowed(bbox);
    if (state.aisOutOfRange) {
      state.aisConnected=false;
      setFeedStatus('vessels','Zoom in for AIS','warn');
      if (state.socket) {const s=state.socket;state.socket=null;s.close();}
      queueRender();return;
    }
    if (state.socket?.readyState===WebSocket.OPEN) {
      state.socket.send(JSON.stringify({action:'subscribe',bbox}));
      return;
    }
    if (state.socket?.readyState===WebSocket.CONNECTING) return;
    clearTimeout(state.reconnectTimer);
    const wsURL=base.replace(/^https:/,'wss:').replace(/^http:/,'ws:')+'/stream/ais';
    const socket=new WebSocket(wsURL);
    state.socket=socket;
    setFeedStatus('vessels','Connecting to AIS…','warn');
    socket.onopen=()=> {
      if (socket!==state.socket) return;
      const b=currentBbox();
      socket.send(JSON.stringify({action:'subscribe',bbox:b}));
    };
    socket.onmessage=event=>{
      if (socket!==state.socket) return;
      let data;try {data=JSON.parse(event.data);}catch{return;}
      if (data.type==='vessel' && data.vessel) {
        state.aisConnected=true;
        state.lastAisMessage=Date.now();
        if(data.vessel.kind==='vessel') upsert(data.vessel);
        setFeedStatus('vessels','Receiving AIS messages','active');
      } else if (data.type==='status') {
        state.aisConnected=data.state==='connected';
        if(data.state==='connected') setFeedStatus('vessels','Listening for vessels','active');
        else if(data.state==='unconfigured') setFeedStatus('vessels','AIS key not configured','warn');
        else setFeedStatus('vessels','Connecting to AIS…','warn');
      } else if(data.type==='error') {setFeedStatus('vessels','AIS stream error','warn');toast(data.message);}
      queueRender();
    };
    socket.onclose=()=> {
      if(socket!==state.socket || state.demo) return;
      state.socket=null;state.aisConnected=false;
      if (!state.seaOn || map.getZoom()<minZoom) return;
      setFeedStatus('vessels','Reconnecting AIS…','warn');
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer=setTimeout(openAis,6000);
    };
    socket.onerror=()=> {if(socket===state.socket) setFeedStatus('vessels','AIS connection problem','warn');};
  }

  function updateViewport() {
    queueRender();
    if (state.demo) { seedDemo();return; }
    if (map.getZoom()<minZoom) {
      if(state.fetchController) state.fetchController.abort();
      state.fetchController=null;clearTimeout(state.requestTimer);
      clearTimeout(state.reconnectTimer);state.aisConnected=false;state.aisOutOfRange=false;
      if(state.socket) {const s=state.socket;state.socket=null;s.close();}
      state.aircraft.clear();state.vessels.clear();
      setFeedStatus('aircraft',state.airOn?'Zoom in for traffic':'Layer hidden','warn');
      setFeedStatus('vessels',state.seaOn?'Zoom in for traffic':'Layer hidden','warn');
      queueRender();return;
    }
    if(state.airOn) refreshAircraft(true);
    if(state.seaOn) openAis();
    const bounds=map.getBounds();
    for(const [id,x] of state.vessels) if(!bounds.contains([x.lat,x.lon])) state.vessels.delete(id);
    queueRender();
  }
  function planViewport() { clearTimeout(state.moveTimer);state.moveTimer=setTimeout(updateViewport,900); }
  map.on('moveend', planViewport);
  map.on('mousemove',()=>{});

  function handleLayerChange() {
    state.airOn=get('toggle-aircraft').checked;
    state.seaOn=get('toggle-vessels').checked;
    if(state.demo) {
      setFeedStatus('aircraft',state.airOn?'Simulated aircraft':'Layer hidden',state.airOn?'warn':'');
      setFeedStatus('vessels',state.seaOn?'Simulated vessels':'Layer hidden',state.seaOn?'warn':'');
    } else {
      if (!state.airOn) {state.aircraft.clear();if(state.fetchController)state.fetchController.abort();setFeedStatus('aircraft','Layer hidden');}
      else refreshAircraft(true);
      if (!state.seaOn) {
        if(state.socket){const s=state.socket;state.socket=null;s.close();}
        clearTimeout(state.reconnectTimer);state.aisConnected=false;state.aisOutOfRange=false;
        state.vessels.clear();setFeedStatus('vessels','Layer hidden');
      } else openAis();
    }
    queueRender();
  }
  get('toggle-aircraft').addEventListener('change',handleLayerChange);
  get('toggle-vessels').addEventListener('change',handleLayerChange);
  get('toggle-trails').addEventListener('change',event=>{state.trailsOn=event.target.checked;queueRender();});
  get('toggle-auto').addEventListener('change',event=> {state.auto=event.target.checked;if(state.auto&&!state.demo)refreshAircraft(true);else if(!state.auto&&state.fetchController){state.fetchController.abort();state.fetchController=null;clearTimeout(state.requestTimer);setFeedStatus('aircraft','Auto refresh paused');}});
  get('search').addEventListener('input',queueRender);
  get('refresh-button').addEventListener('click',()=>{
    if(state.demo) { seedDemo();toast('Refreshed simulated targets'); }
    else {refreshAircraft(true);openAis();toast('Refreshing aircraft; AIS is a continuous stream.');}
  });
  get('demo-button').addEventListener('click',()=>{
    if (!base) {toast('Demo mode: set API_BASE in config.js and deploy the backend to enable live data.');return;}
    if(state.demo) {
      stopDemo();state.demo=false;clearTraffic();updateViewport();
    } else startDemo();
    updateHeader();
  });
  document.querySelectorAll('[data-place]').forEach(button=>button.addEventListener('click',()=>{
    const place=places[button.dataset.place];map.setView([place[0],place[1]],place[2]);
    get('sidebar').classList.remove('open');get('sidebar-overlay').classList.remove('open');
  }));
  get('menu-button').addEventListener('click',()=>{get('sidebar').classList.toggle('open');get('sidebar-overlay').classList.toggle('open');});
  get('sidebar-overlay').addEventListener('click',()=>{get('sidebar').classList.remove('open');get('sidebar-overlay').classList.remove('open');});
  state.pollTimer=setInterval(()=>{
    if(!state.demo&&state.auto&&state.airOn&&map.getZoom()>=minZoom) refreshAircraft();
    if(!state.demo) {
      const oldest=Date.now();
      for(const [id,x] of state.aircraft) if(oldest-x.updatedAt>180000) state.aircraft.delete(id);
      for(const [id,x] of state.vessels) if(oldest-x.updatedAt>20*60000) state.vessels.delete(id);
      for(const key of state.history.keys()) {
        const collection=key.startsWith('aircraft:')?state.aircraft:state.vessels;
        if(!collection.has(key.slice(key.indexOf(':')+1))) state.history.delete(key);
      }
    }
    queueRender();
  },refreshMs);

  if(state.demo) {
    startDemo();
    toast('Demo is running with SIMULATED aircraft and vessels. Configure a backend for live feeds.');
  } else updateViewport();
  render();
})();
