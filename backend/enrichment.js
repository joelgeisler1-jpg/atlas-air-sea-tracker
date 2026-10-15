'use strict';
const { vesselMetadata } = require('./vessel-metadata');
const USER_AGENT='Atlas-Air-Sea-Tracker/1.0 (+https://github.com/joelgeisler1-jpg/atlas-air-sea-tracker)';
function safePhotoURL(value, image=false) {
  try { const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && (image ? ['cdn.planespotters.net','t.plnspttrs.net'].includes(url.hostname) : ['planespotters.net','www.planespotters.net'].includes(url.hostname))?url.href:null; } catch {return null;}
}
function createEnrichment(fetchImpl) {
  const cache=new Map(),pending=new Map(),limits=new Map();let active=0;
  function limited(kind) {
    const now=Date.now(),old=limits.get(kind);const entry=old&&now-old.at<60000?old:{at:now,count:0};
    if(entry.count>=(kind==='vessel'?12:30)||active>=2){const error=new Error('Metadata request limit');error.status=429;throw error;}
    entry.count++;limits.set(kind,entry);
  }
  async function cached(key,kind,work) {
    const entry=cache.get(key);if(entry&&Date.now()<entry.expires)return entry.value;
    if(pending.has(key))return pending.get(key);
    limited(kind);active++;
    const task=(async()=>{try {
      const value=await work();const found=kind==='photo'?Boolean(value):Boolean(value?.callsign);
      cache.set(key,{value,expires:Date.now()+(found?(kind==='photo'?24:6):1)*3600000});
      while(cache.size>2000)cache.delete(cache.keys().next().value);
      return value;
    }finally{active--;pending.delete(key);}})();
    pending.set(key,task);return task;
  }
  const request=async url=>{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(4500),headers:{Accept:'application/json','User-Agent':USER_AGENT}});
    if(response.status===404)return null;
    if(!response.ok)throw new Error('Metadata provider unavailable');
    return response.json();
  };
  async function photo(hex,registration) {
    return cached(`photo:${hex}:${registration}`,'photo',async()=>{
      const endpoints=[];if(hex)endpoints.push(`https://api.planespotters.net/pub/photos/hex/${hex}`);
      if(registration)endpoints.push(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(registration)}`);
      for(const url of endpoints){
        const raw=await request(url);
        for(const item of Array.isArray(raw?.photos)?raw.photos:[]){
          const thumbnailUrl=safePhotoURL(item.thumbnail_large?.src||item.thumbnail?.src,true);
          const sourcePage=safePhotoURL(item.link);
          const photographer=typeof item.photographer==='string'?item.photographer.slice(0,150):'';
          if(thumbnailUrl && sourcePage && photographer)return {thumbnailUrl,sourcePage,photographer,sourceName:'Planespotters.net'};
        }
      }
      return null;
    });
  }
  async function vessel(id) {
    return cached(`vessel:${id}`,'vessel',async()=>{
      const raw=await request(`https://ais.openwaters.io/v1/vessels/${id}`);
      if(!raw)return null;
      if(raw.type!=='Feature'||!raw.properties)throw new Error('Invalid vessel details');
      const props=raw.properties,details=props.particulars||{};
      const metadata=vesselMetadata(id,{...details,...props,callsign:props.callsign??props.call_sign??details.callsign??details.call_sign});
      const attribution=raw.attribution&&typeof raw.attribution==='object'?Object.values(raw.attribution).filter(v=>typeof v==='string').map(v=>v.slice(0,500)):[];
      return {kind:'vessel',id,...metadata,attribution};
    });
  }
  return {photo,vessel};
}
module.exports={createEnrichment,safePhotoURL};
