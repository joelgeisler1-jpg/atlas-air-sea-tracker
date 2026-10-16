/* ATLAS — view-scoped aircraft + AIS vessel map.
 * Github Pages is static. Live API calls go to the separately hosted backend.
 * Never paste provider API keys into this or config.js.
 */
(() => {
  'use strict';
  const cfg = window.ATLAS_CONFIG || {};
  const H=window.ATLAS_TARGETS;
  const base = String(cfg.API_BASE || '').replace(/\/$/, '');
  const refreshMs = Math.max(15000, Number(cfg.AIRCRAFT_REFRESH_MS) || 20000);
  const minZoom = Math.max(4, Number(cfg.MIN_LIVE_ZOOM) || 6);
  const get = id => document.getElementById(id);
  const state = {
    demo: !base, tagsOn:true, militaryOnly:false, airOn: true, seaOn: true, trailsOn: true, auto: true,
    aircraft: new Map(), vessels: new Map(), history: new Map(), markers: new Map(),
    selection: null, socket: null, reconnectTimer: null, moveTimer: null,
    renderTimer: null, demoTimer: null, fetchController: null, pollTimer: null,
    lastAisMessage: 0, lastUpdate: 0, flightRegion: null, demoStep: 0,
    aisConnected: false, aisError: false, aisOutOfRange: false,
    flightError: false, lastFetchRegion: '', requestTimer: null,
    marineFallback: false, marinePollTimer: null, marineController: null,
    marineRequestTimer: null, aisWatchTimer: null,
    enrichment:new Map(), selectionRequest:null, selectionController:null
  };
  const places = {
    adelaide: [-34.93, 138.60, 8], singapore: [1.29, 103.85, 9],
    rotterdam: [51.92, 4.48, 9], newyork: [40.70, -74.00, 9]
  };
  const map = L.map('map', {
    preferCanvas: true, zoomControl: false, worldCopyJump: true,
    minZoom: 2, maxZoom: 15
  }).setView([-34.93, 138.60], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19, className: 'atlas-map-tile'
  }).addTo(map);
  L.control.zoom({ position:'topleft' }).addTo(map);
  const markerGroup = L.layerGroup().addTo(map);
  const trailGroup = L.layerGroup().addTo(map);
  const coverageRing = L.circle([-34.93,138.6], {radius:250*1852, color:'#e8ad62', weight:1, dashArray:'6,8', opacity:.28, fill:false, interactive:false});

  const numberText = n => Number.isFinite(n) ? n.toLocaleString('en-AU') : '—';
  const safe = val => String(val ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const coord = (n, pos, neg) => `${Math.abs(n).toFixed(2)}°${n >= 0 ? pos : neg}`;
  const label=H.label;
  const infoTime = time => time ? new Date(time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '—';
  const validPoint = x => Number.isFinite(x?.lat) && Number.isFinite(x?.lon) && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180;
  const targetKey = x => `${x.kind}:${x.id}`;
  const displayPoint=x=>[x.lat,H.longitudeNear(x.lon,map.getCenter().lng)];
  const inViewport=(bounds,x)=>bounds.contains(displayPoint(x));

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
    const visible=x=>H.matchesFilter(x,search,state.militaryOnly);
    const bounds = map.getBounds();
    get('aircraft-count').textContent = state.airOn ? numberText([...state.aircraft.values()].filter(x=>inViewport(bounds,x)&&visible(x)).length) : 'OFF';
    get('vessel-count').textContent = state.seaOn ? numberText([...state.vessels.values()].filter(x=>inViewport(bounds,x)&&visible(x)).length) : 'OFF';
  }
  let lastCard='';
  function selectionKey(item) {return `${targetKey(item)}:${item.registration||''}`;}
  function selectTarget(key) {
    if(state.selectionController)state.selectionController.abort();
    state.selectionController=null;state.selectionRequest=null;state.selection=key;
    renderSelected();queueRender();
  }
  function loadSelected(item) {
    if(state.demo || !base)return;
    const key=selectionKey(item),cached=state.enrichment.get(key);
    if(cached&&cached.expires>Date.now() || state.selectionRequest===key)return;
    if(state.selectionController)state.selectionController.abort();
    const controller=new AbortController();state.selectionController=controller;state.selectionRequest=key;
    const timer=setTimeout(()=>controller.abort(),12000);
    const url=item.kind==='aircraft'?`${base}/api/aircraft-photo?hex=${encodeURIComponent(item.id)}&registration=${encodeURIComponent(item.registration||'')}`:`${base}/api/vessels/${encodeURIComponent(item.id)}/details`;
    (async()=>{
      let value=null;
      try {
        const response=await fetch(url,{signal:controller.signal});
        if(!response.ok)throw new Error('Selected metadata unavailable');
        const body=await response.json();value=item.kind==='aircraft'?body.photo:body.vessel;
        if(controller!==state.selectionController)return;
        if(item.kind==='vessel'&&value?.id===item.id) {
          const current=state.vessels.get(item.id);
          if(current)state.vessels.set(item.id,H.mergeTarget(current,{...current,...value}));
        }
      } catch { /* Optional enrichment must never disrupt position rendering. */ }
      finally {
        clearTimeout(timer);
        if(controller===state.selectionController){
          state.enrichment.set(key,{value,expires:Date.now()+(value?3600000:300000)});
          while(state.enrichment.size>200)state.enrichment.delete(state.enrichment.keys().next().value);
          state.selectionRequest=null;state.selectionController=null;queueRender();
        }
      }
    })();
  }
  function renderSelected() {
    const selection=state.selection;
    const item=selection?.startsWith('aircraft:')?state.aircraft.get(selection.slice(9)):selection?.startsWith('vessel:')?state.vessels.get(selection.slice(7)):null;
    let html;
    if(!item) html='<div class="empty-target"><div class="empty-target-icon">⌖</div><strong>No target selected</strong><span>Tap an aircraft or vessel on the map to inspect its live position.</span></div>';
    else {
      loadSelected(item);
      const aircraft=item.kind==='aircraft';
      const rows=aircraft?[
        ['CALLSIGN',item.callsign||'—'],['REGISTRATION',item.registration||'—'],['ICAO HEX',item.id],...(item.military===true?[['CLASSIFICATION','MILITARY']]:[]),['AIRCRAFT TYPE',item.type||'—'],
        ['ALTITUDE',H.altitudeText(item)],['TRACK',H.trackText(item.trackDeg)],['GROUND SPEED',H.speedText(item)],['LAST POSITION',infoTime(item.updatedAt)]
      ]:[
        ['CALLSIGN',item.callsign||'—'],['VESSEL NAME',item.name||'—'],['VESSEL TYPE',item.typeName||'VESSEL'],['MMSI',item.id],
        ['FLAG STATE / COUNTRY',`${item.flagEmoji||''} ${item.flagCountry||item.country||'Unknown'}`.trim()],
        ['TRACK',H.trackText(item.trackDeg)],...(Number.isFinite(item.headingDeg)?[['HEADING',H.trackText(item.headingDeg)]]:[]),
        ['SPEED OVER GROUND',H.speedText(item)],['LATITUDE',coord(item.lat,'N','S')],['LONGITUDE',coord(item.lon,'E','W')],['LAST POSITION',infoTime(item.updatedAt)],['PROVIDER',item.provider||item.source||'—']
      ];
      const photo=aircraft?state.enrichment.get(selectionKey(item))?.value:null;
      let media='';
      if(photo?.thumbnailUrl&&photo?.sourcePage&&photo?.photographer) media=`<figure class="target-photo" id="aircraft-photo-wrap"><a href="${safe(photo.sourcePage)}" target="_blank" rel="noopener noreferrer"><img id="target-photo" src="${safe(photo.thumbnailUrl)}" loading="lazy" alt="${safe(item.registration||item.id)} aircraft photograph"></a><figcaption>© ${safe(photo.photographer)} · <a href="${safe(photo.sourcePage)}" target="_blank" rel="noopener noreferrer">Planespotters.net</a></figcaption></figure>`;
      else if(!aircraft)media='<div class="vessel-silhouette" role="img" aria-label="Generic vessel silhouette"><svg viewBox="0 0 180 60" aria-hidden="true"><path d="M10 36h155l-22 20H38Z M40 33V19h49v14 M65 19V8h14v11 M97 33V24h40v9 M5 59h165"/></svg></div>';
      html=`<div class="target-title"><div><span class="label">${aircraft?'AIRCRAFT TARGET':'MARITIME TARGET'}</span><strong>${safe(label(item))}</strong></div><span class="type-pill ${aircraft?'':'vessel'}">${aircraft?'ADS-B':'AIS'}</span></div>${media}<dl class="target-grid">${rows.map(([k,v])=>`<div><dt>${safe(k)}</dt><dd>${k==='CLASSIFICATION'?`<span class="military-badge">${safe(v)}</span>`:safe(v)}</dd></div>`).join('')}</dl>${aircraft?'':'<p class="helper">Flag state identifies vessel registration, not owner, operator or crew nationality.</p>'}${!aircraft&&Array.isArray(item.attribution)?`<p class="helper">${safe(item.attribution.join(' · '))}</p>`:''}`;
    }
    if(html!==lastCard){get('target-card').innerHTML=html;lastCard=html;
      const image=get('target-photo');if(image)image.onerror=()=>{const wrapper=get('aircraft-photo-wrap');if(wrapper)wrapper.hidden=true;};
    }
  }

  function symbol(x, selected, showTag=false, layout=null) {
    const angle=H.orientation(x);
    const path = x.kind === 'aircraft'
      ? '<path d="M12 1.2c-.6 0-1.1.6-1.1 1.5v7l-8 5v2l8-2.5v5.4l-2.4 1.8V23l3.5-1.1 3.5 1.1v-1.6l-2.4-1.8v-5.4l8 2.5v-2l-8-5v-7c0-.9-.5-1.5-1.1-1.5Z"/>'
      : '<path d="M12 1 19.6 20.3 12 16.9 4.4 20.3 12 1Z"/><path d="M9 19.5 12 21l3-1.5" fill="none" stroke-width="1.5"/>';
    return L.divIcon({ className:'marker-wrap', html:`<div class="traffic-marker ${x.kind} ${x.kind==='aircraft'&&x.military===true?'military':''} ${selected?'selected':''}"><svg viewBox="0 0 24 24" style="transform:rotate(${angle}deg)">${path}</svg>${showTag?`<div class="target-tag ${layout?.alignLeft?'tag-left':''}" style="--tag-width:${layout?.width||190}px" aria-hidden="true">${H.tagLines(x).map((line,i)=>`<div class="tag-line-${i}">${i===0&&x.kind==='aircraft'&&x.military===true?`<span class="mil-badge">MIL</span> ${safe(line.slice(4))}`:safe(line)}</div>`).join('')}</div>`:''}</div>`, iconSize:[27,27],iconAnchor:[13,13] });
  }

  function markHistory(x) {
    const key = targetKey(x);
    let track = state.history.get(key);
    if (!track) { track=[]; state.history.set(key,track); }
    const previous = track.at(-1);
    const moved = !previous || Math.abs(previous[0]-x.lat) + Math.abs(H.wrapLongitude(previous[1]-x.lon)) > 0.0002;
    const plausible = !previous || Math.abs(previous[0]-x.lat) < 5 && Math.abs(H.wrapLongitude(previous[1]-x.lon)) < 5;
    if (!plausible) track=[];
    if (moved) track.push([x.lat,x.lon, x.updatedAt]);
    if (track.length > 55) track.splice(0, track.length-55);
    state.history.set(key,track);
  }

  function upsert(x) {
    if (!validPoint(x) || !x.id || !['aircraft','vessel'].includes(x.kind)) return;
    x={...x,id:String(x.id)};
    const collection=x.kind==='aircraft'?state.aircraft:state.vessels;
    const previous=collection.get(x.id);
    if(previous && x.updatedAt < previous.updatedAt) return;
    x=H.mergeTarget(previous,x);
    collection.set(x.id,x);
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
    const filtered=x=>inViewport(bounds,x)&&H.matchesFilter(x,search,state.militaryOnly);
    const next = new Set();
    let trackCount = 0,tagCount=0;const tagRects=[];
    const tagRect=x=>{
      const point=map.latLngToContainerPoint?.(displayPoint(x));if(!point)return null;
      const mapWidth=map.getSize().x,preferred=mapWidth>750?210:185;
      const rightSpace=mapWidth-point.x-30,leftSpace=point.x-30;
      const alignLeft=rightSpace<preferred&&leftSpace>rightSpace;
      const width=Math.max(110,Math.min(preferred,alignLeft?leftSpace:rightSpace));
      const left=alignLeft?point.x-22-width:point.x+22;
      return {left,top:point.y-22,right:left+width+4,bottom:point.y+40,alignLeft,width};
    };
    const selectedTarget=[...state.aircraft.values(),...state.vessels.values()].find(x=>targetKey(x)===state.selection);
    if(selectedTarget){const rect=tagRect(selectedTarget);if(rect)tagRects.push(rect);}
    trailGroup.clearLayers();
    for (const [enabled, collection] of [[state.airOn,state.aircraft],[state.seaOn,state.vessels]]) {
      if (!enabled) continue;
      let count=0;
      for (const x of [...collection.values()].sort((a,b)=>Number(targetKey(b)===state.selection)-Number(targetKey(a)===state.selection))) {
        if (count>=1800) break;
        if (!filtered(x)) continue;
        count++;
        const key = targetKey(x);
        next.add(key);
        const rect=tagRect(x);
        const overlaps=rect&&tagRects.some(r=>rect.left<r.right&&rect.right>r.left&&rect.top<r.bottom&&rect.bottom>r.top);
        const showTag=key===state.selection || (state.tagsOn && map.getZoom()>=9 && tagCount<80 && !overlaps);
        if(showTag){tagCount++;if(rect&&key!==state.selection)tagRects.push(rect);}
        let marker = state.markers.get(key);
        if (!marker) {
          marker = L.marker(displayPoint(x), {icon:symbol(x,key===state.selection,showTag,rect),keyboard:true, title:label(x)});
          marker.on('click',()=>selectTarget(key));
          marker.bindTooltip(safe(label(x)), {direction:'top', offset:[0,-11]});
          state.markers.set(key,marker);
          marker.addTo(markerGroup);
        } else {
          marker.setLatLng(displayPoint(x));
          marker.setIcon(symbol(x,key===state.selection,showTag,rect));
          marker.setTooltipContent(safe(label(x)));
        }
        marker.setZIndexOffset?.(key===state.selection?2000:0);
        if (state.trailsOn && trackCount < 220) {
          const points = state.history.get(key);
          if (points?.length>=2) {
            L.polyline(H.unwrapTrail(points,displayPoint(x)[1]), {
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
    get('coordinates').textContent = `${coord(center.lat,'N','S')} · ${coord(H.wrapLongitude(center.lng),'E','W')}`;
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
    if(state.selectionController)state.selectionController.abort();
    state.selectionController=null;state.selectionRequest=null;
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
    stopMarine();
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
      const lon=H.wrapLongitude(centre.lng+Math.cos(angle*Math.PI/180)*radial);
      const x={ kind:p.kind,id:String(900000+i),lat,lon,heading:(angle+65)%360,
        trackDeg:(angle+65)%360,headingDeg:p.kind==='vessel'?(angle+80)%360:null,
        speedKt:p.speed+(i%4)*(p.kind==='vessel'?1.5:10),updatedAt:Date.now() };
      if (p.kind==='aircraft') Object.assign(x,{callsign:`${p.prefix}${(200+i*13)}`,registration:`DEMO-${i+1}`,type:i%2?'B738':'A320',altitudeFt:p.alt+(i%6)*1100});
      else Object.assign(x,{name:`${p.prefix} ${String(i-15).padStart(2,'0')}`,callsign:`VHO${i}`,typeCode:70,typeName:'Cargo',country:'Australia',flagCountry:'Australia',flagEmoji:'🇦🇺'});
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
      x.lat+=dy;x.lon=H.wrapLongitude(x.lon+dx);x.updatedAt=Date.now();
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
    const requestLon=H.wrapLongitude(Number(H.wrapLongitude(center.lng).toFixed(4)));
    const region=`${center.lat.toFixed(2)},${requestLon.toFixed(2)}`;
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
      const response=await fetch(`${base}/api/aircraft?lat=${center.lat.toFixed(4)}&lon=${requestLon.toFixed(4)}&radius=250`, {signal:controller.signal,cache:'no-store'});
      const body=await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (state.demo || controller!==state.fetchController) return;
      if (!Array.isArray(body.aircraft)) throw new Error('Invalid aircraft response');
      const previousAircraft=new Map(state.aircraft);state.aircraft.clear();
      for (const x of body.aircraft) if (x?.kind==='aircraft') upsert(H.mergeTarget(previousAircraft.get(String(x.id)),x));
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
  const currentBboxes=()=>H.splitViewport(currentBbox());
  const subscription=()=>{const boxes=currentBboxes();return boxes?.length===1?{action:'subscribe',bbox:boxes[0]}:{action:'subscribe',bboxes:boxes};};
  const marineAllowed = () => !state.demo && state.seaOn && map.getZoom()>=minZoom && currentBboxes()!==null;
  function stopFallback() {
    state.marineFallback=false;
    clearInterval(state.marinePollTimer);state.marinePollTimer=null;
    if(state.marineController) state.marineController.abort();
    state.marineController=null;
    clearTimeout(state.marineRequestTimer);state.marineRequestTimer=null;
  }
  function stopMarine() {
    stopFallback();
    clearTimeout(state.aisWatchTimer);state.aisWatchTimer=null;
    clearTimeout(state.reconnectTimer);state.reconnectTimer=null;
    const socket=state.socket;state.socket=null;
    if(socket) socket.close();
    state.aisConnected=false;state.lastAisMessage=0;
  }
  function watchAis(delay) {
    clearTimeout(state.aisWatchTimer);
    state.aisWatchTimer=setTimeout(()=>{state.aisWatchTimer=null;startFallback();},delay);
  }
  async function refreshVessels(force=false) {
    if(!state.marineFallback || !marineAllowed()) return;
    if(state.marineController && !force) return;
    if(state.marineController) state.marineController.abort();
    const controller=new AbortController();state.marineController=controller;
    clearTimeout(state.marineRequestTimer);
    state.marineRequestTimer=setTimeout(()=>controller.abort(),12000);
    const boxes=currentBboxes(),region=JSON.stringify(boxes);
    try {
      const bodies=await Promise.all(boxes.map(async bbox=>{
        const response=await fetch(`${base}/api/vessels?bbox=${encodeURIComponent(bbox.join(','))}`, {signal:controller.signal,cache:'no-store'});
        const body=await response.json();
        if(!response.ok || !Array.isArray(body?.vessels))throw new Error('Marine feed unavailable');
        return body;
      }));
      if(controller!==state.marineController || !state.marineFallback || !marineAllowed() || region!==JSON.stringify(currentBboxes()))return;
      const unique=new Map(),credits=new Set();
      for(const body of bodies){
        for(const vessel of body.vessels)if(vessel?.kind==='vessel'){
          const id=String(vessel.id),previous=unique.get(id);
          if(!previous)unique.set(id,vessel);
          else {const newer=vessel.updatedAt>=previous.updatedAt;unique.set(id,H.mergeTarget(newer?previous:vessel,newer?vessel:previous));}
        }
        for(const credit of Array.isArray(body.attribution)?body.attribution:[])if(typeof credit==='string')credits.add(credit);
      }
      for(const vessel of unique.values())upsert(vessel);
      if(get('marine-attribution'))get('marine-attribution').textContent=[...credits].join(' · ');
      state.lastUpdate=Date.now();
      setFeedStatus('vessels','Open Waters live','active');queueRender();
    } catch {
      if(controller===state.marineController && state.marineFallback && marineAllowed()) setFeedStatus('vessels','Marine feed unavailable','warn');
    } finally {
      if(controller===state.marineController) {
        clearTimeout(state.marineRequestTimer);state.marineController=null;
      }
    }
  }
  function startFallback() {
    if(!marineAllowed() || state.marineFallback) return;
    state.marineFallback=true;
    setFeedStatus('vessels','Connecting to AIS…','warn');
    refreshVessels();
    state.marinePollTimer=setInterval(()=>refreshVessels(),25000);
  }
  function openAis() {
    if(state.demo || !state.seaOn) return;
    state.aisOutOfRange=currentBboxes()===null;
    if(!marineAllowed()) {
      stopMarine();setFeedStatus('vessels','Zoom in for marine traffic','warn');queueRender();return;
    }
    if(state.socket?.readyState===WebSocket.OPEN) {
      state.socket.send(JSON.stringify(subscription()));return;
    }
    if(state.socket?.readyState===WebSocket.CONNECTING) return;
    clearTimeout(state.reconnectTimer);
    if(!state.marineFallback) {
      setFeedStatus('vessels','Connecting to AIS…','warn');
      if(!state.aisWatchTimer) watchAis(20000);
    }
    const wsURL=base.replace(/^https:/,'wss:').replace(/^http:/,'ws:')+'/stream/ais';
    let socket;
    try { socket=new WebSocket(wsURL); } catch { startFallback();return; }
    state.socket=socket;
    socket.onopen=()=> {
      if(socket===state.socket && marineAllowed()) socket.send(JSON.stringify(subscription()));
    };
    socket.onmessage=event=>{
      if(socket!==state.socket || !marineAllowed()) return;
      let data;try {data=JSON.parse(event.data);}catch{return;}
      if(data?.type==='vessel' && data.vessel?.kind==='vessel' && validPoint(data.vessel) && /^\d{9}$/.test(String(data.vessel.id))) {
        state.aisConnected=true;state.lastAisMessage=Date.now();
        stopFallback();watchAis(60000);
        upsert(data.vessel);
        setFeedStatus('vessels','AISstream live','active');
      } else if(data?.type==='status') {
        state.aisConnected=data.state==='connected';
        if(data.state==='connected') {
          // A reconnect must produce vessel data before replacing a working snapshot feed.
          if(!state.marineFallback) {setFeedStatus('vessels','AISstream live','active');watchAis(60000);}
        } else if(data.state==='unconfigured' || data.state==='reconnecting') startFallback();
        else if(!state.marineFallback) setFeedStatus('vessels','Connecting to AIS…','warn');
      } else if(data?.type==='error') startFallback();
      queueRender();
    };
    socket.onclose=()=> {
      if(socket!==state.socket || state.demo) return;
      state.socket=null;state.aisConnected=false;
      if(!marineAllowed()) return;
      startFallback();
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer=setTimeout(openAis,6000);
    };
    socket.onerror=()=> {if(socket===state.socket) startFallback();};
  }

  function updateViewport() {
    queueRender();
    if (state.demo) { seedDemo();return; }
    if (map.getZoom()<minZoom) {
      if(state.fetchController) state.fetchController.abort();
      state.fetchController=null;clearTimeout(state.requestTimer);
      stopMarine();state.aisOutOfRange=false;
      state.aircraft.clear();state.vessels.clear();
      setFeedStatus('aircraft',state.airOn?'Zoom in for traffic':'Layer hidden','warn');
      setFeedStatus('vessels',state.seaOn?'Zoom in for traffic':'Layer hidden','warn');
      queueRender();return;
    }
    if(state.airOn) refreshAircraft(true);
    if(state.seaOn) {openAis();if(state.marineFallback) refreshVessels(true);}
    const bounds=map.getBounds();
    for(const [id,x] of state.vessels) if(!inViewport(bounds,x)) state.vessels.delete(id);
    queueRender();
  }
  function planViewport() { clearTimeout(state.moveTimer);state.moveTimer=setTimeout(updateViewport,900); }
  map.on('moveend',()=>{
    const center=map.getCenter(),lat=Math.max(-84,Math.min(84,center.lat));
    if(lat!==center.lat)map.panTo([lat,center.lng],{animate:false});
    planViewport();
  });
  map.on('move',queueRender);
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
        stopMarine();state.aisOutOfRange=false;
        state.vessels.clear();setFeedStatus('vessels','Layer hidden');
      } else openAis();
    }
    queueRender();
  }
  get('toggle-aircraft').addEventListener('change',handleLayerChange);
  get('toggle-vessels').addEventListener('change',handleLayerChange);
  get('toggle-military').addEventListener('change',event=>{state.militaryOnly=event.target.checked;queueRender();});
  get('toggle-tags').addEventListener('change',event=>{state.tagsOn=event.target.checked;queueRender();});
  get('toggle-trails').addEventListener('change',event=>{state.trailsOn=event.target.checked;queueRender();});
  get('toggle-auto').addEventListener('change',event=> {state.auto=event.target.checked;if(state.auto&&!state.demo)refreshAircraft(true);else if(!state.auto&&state.fetchController){state.fetchController.abort();state.fetchController=null;clearTimeout(state.requestTimer);setFeedStatus('aircraft','Auto refresh paused');}});
  get('search').addEventListener('input',queueRender);
  get('refresh-button').addEventListener('click',()=>{
    if(state.demo) { seedDemo();toast('Refreshed simulated targets'); }
    else {refreshAircraft(true);openAis();if(state.marineFallback)refreshVessels(true);toast('Refreshing traffic feeds.');}
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
