/* Shared pure target helpers: browser and Node, no provider credentials. */
(function(root, factory) {
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.ATLAS_TARGETS=factory();
})(typeof window!=='undefined'?window:this, function() {
  'use strict';
  const staticFields=['dbFlags','military','callsign','registration','type','name','typeCode','typeName','country','flagCountry','flagEmoji','flagSource','attribution','photoUrl','photoThumbnailUrl','photoCredit','photoLink','photoSource'];
  const known=(key,value)=>value!==null && value!==undefined && value!=='' && (!Array.isArray(value)||value.length>0) && !(key==='typeName' && value==='VESSEL') && !(key==='typeCode' && value===0);
  function mergeTarget(previous, next) {
    const result={...next};
    for(const key of staticFields) if(!known(key,result[key]) && known(key,previous?.[key])) result[key]=previous[key];
    if(previous?.flagSource==='provider' && next.flagSource==='mid') for(const field of ['country','flagCountry','flagEmoji','flagSource'])result[field]=previous[field];
    if(next.kind==='aircraft') {
      // Missing provider flags are unknown; an explicit zero is authoritative.
      if(result.dbFlags!==null && result.dbFlags!==undefined)result.military=Boolean(Number(result.dbFlags)&1);
      else if(next.military===undefined)result.military=previous?.military===true;
    }
    return result;
  }
  const wrapLongitude=lon=>Number.isFinite(lon)?((lon+180)%360+360)%360-180:NaN;
  const longitudeNear=(lon,reference)=>lon+360*Math.round((reference-lon)/360);
  function splitViewport(bbox) {
    if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))return null;
    const [south,west,north,east]=bbox,width=east-west;
    if(south< -90||north>90||south>=north||north-south>8||width<=0||width>12)return null;
    const w=wrapLongitude(west),e=w+width;
    const round=box=>box.map(n=>Number(n.toFixed(5)));
    const boxes=e<=180+1e-9?[[south,w,north,Math.min(180,e)]]:[[south,w,north,180],[south,-180,north,e-360]];
    const rounded=boxes.map(round).filter(box=>box[1]<box[3]);
    return rounded.length?rounded:null;
  }
  function unwrapTrail(points,reference) {
    if(!points.length)return [];
    // Walk backward from the visible target to keep every segment local across ±180°.
    const result=new Array(points.length);let previous=reference;
    for(let i=points.length-1;i>=0;i--){const [lat,lon]=points[i];previous=longitudeNear(lon,previous);result[i]=[lat,previous];}
    return result;
  }
  const label=x=>x.kind==='aircraft'?(x.callsign||x.registration||x.id):(x.callsign&&x.name&&x.callsign!==x.name?`${x.callsign} · ${x.name}`:x.callsign||x.name||x.id);
  const matches=(x,query)=>!query || [x.id,x.callsign,x.registration,x.type,x.name,x.typeName,x.typeCode,x.country,x.flagCountry].some(v=>String(v??'').toLowerCase().includes(query.toLowerCase()));
  const matchesFilter=(x,query,militaryOnly=false)=>matches(x,query)&&(!militaryOnly||x.kind!=='aircraft'||x.military===true);
  const trackText=value=>Number.isFinite(value)?`${String(Math.round(((value%360)+360)%360)%360).padStart(3,'0')}°`:'—';
  const altitudeText=x=>x.onGround?'GND':Number.isFinite(x.altitudeFt)?`${x.altitudeFt.toLocaleString('en-AU')} FT`:'—';
  const speedText=x=>Number.isFinite(x.speedKt)?`${x.kind==='vessel'?x.speedKt.toFixed(1):Math.round(x.speedKt)} KT`:'—';
  const orientation=x=>x.kind==='aircraft'?(Number.isFinite(x.trackDeg)?x.trackDeg:x.heading??0):(Number.isFinite(x.headingDeg)?x.headingDeg:Number.isFinite(x.trackDeg)?x.trackDeg:x.heading??0);
  const tagLines=x=>[`${x.kind==='aircraft'&&x.military===true?'MIL ':''}${x.kind==='vessel'&&x.flagEmoji?x.flagEmoji+' ':''}${label(x)}`,x.kind==='aircraft'?`${x.type||'—'}  ${altitudeText(x)}`:(x.typeName||'VESSEL').toUpperCase(),`TRK ${trackText(x.trackDeg)}  ${speedText(x)}`];
  return {wrapLongitude,longitudeNear,splitViewport,unwrapTrail,staticFields, mergeTarget,label,matches,matchesFilter,trackText,altitudeText,speedText,orientation,tagLines};
});
