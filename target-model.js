/* Shared pure target helpers: browser and Node, no provider credentials. */
(function(root, factory) {
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.ATLAS_TARGETS=factory();
})(typeof window!=='undefined'?window:this, function() {
  'use strict';
  const staticFields=['callsign','registration','type','name','typeCode','typeName','country','flagCountry','flagEmoji','flagSource','attribution','photoUrl','photoThumbnailUrl','photoCredit','photoLink','photoSource'];
  const known=(key,value)=>value!==null && value!==undefined && value!=='' && (!Array.isArray(value)||value.length>0) && !(key==='typeName' && value==='VESSEL') && !(key==='typeCode' && value===0);
  function mergeTarget(previous, next) {
    const result={...next};
    for(const key of staticFields) if(!known(key,result[key]) && known(key,previous?.[key])) result[key]=previous[key];
    if(previous?.flagSource==='provider' && next.flagSource==='mid') for(const field of ['country','flagCountry','flagEmoji','flagSource'])result[field]=previous[field];
    return result;
  }
  const label=x=>x.kind==='aircraft'?(x.callsign||x.registration||x.id):(x.callsign&&x.name&&x.callsign!==x.name?`${x.callsign} · ${x.name}`:x.callsign||x.name||x.id);
  const matches=(x,query)=>!query || [x.id,x.callsign,x.registration,x.type,x.name,x.typeName,x.typeCode,x.country,x.flagCountry].some(v=>String(v??'').toLowerCase().includes(query.toLowerCase()));
  const trackText=value=>Number.isFinite(value)?`${String(Math.round(((value%360)+360)%360)%360).padStart(3,'0')}°`:'—';
  const altitudeText=x=>x.onGround?'GND':Number.isFinite(x.altitudeFt)?`${x.altitudeFt.toLocaleString('en-AU')} FT`:'—';
  const speedText=x=>Number.isFinite(x.speedKt)?`${x.kind==='vessel'?x.speedKt.toFixed(1):Math.round(x.speedKt)} KT`:'—';
  const orientation=x=>x.kind==='aircraft'?(Number.isFinite(x.trackDeg)?x.trackDeg:x.heading??0):(Number.isFinite(x.headingDeg)?x.headingDeg:Number.isFinite(x.trackDeg)?x.trackDeg:x.heading??0);
  const tagLines=x=>[`${x.kind==='vessel'&&x.flagEmoji?x.flagEmoji+' ':''}${label(x)}`,x.kind==='aircraft'?`${x.type||'—'}  ${altitudeText(x)}`:(x.typeName||'VESSEL').toUpperCase(),`TRK ${trackText(x.trackDeg)}  ${speedText(x)}`];
  return {staticFields, mergeTarget,label,matches,trackText,altitudeText,speedText,orientation,tagLines};
});
