 'use strict';
const mids = require('./mid-countries.json');
const { mergeTarget, staticFields } = require('../target-model');
const regions=new Intl.DisplayNames(['en'],{type:'region'});
const countryCodes=new Map();
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b);const name=regions.of(code);if(name!==code&&!['ZZ','XA','XB'].includes(code))countryCodes.set(name.toLowerCase(),code);}
const clean=(value,max=70)=>typeof value==='string'?value.trim().replace(/@+$/,'').trim().slice(0,max):'';
function vesselType(code) {
  if(!Number.isInteger(code)) return 'VESSEL';
  const exact={30:'Fishing',31:'Towing',32:'Towing',33:'Dredging / Underwater Operations',34:'Diving',35:'Military',36:'Sailing',37:'Pleasure Craft',50:'Pilot Vessel',51:'Search and Rescue',52:'Tug',53:'Port Tender',54:'Anti-pollution',55:'Law Enforcement',58:'Medical Transport',59:'Special Craft'};
  if(exact[code]) return exact[code];
  for(const [start,name] of [[40,'High-Speed Craft'],[60,'Passenger'],[70,'Cargo'],[80,'Tanker'],[90,'Other Vessel']]) if(code>=start&&code<=start+9)return name;
  return 'VESSEL';
}
function flagState(mmsi, supplied) {
  // Ordinary ship MMSIs begin with MID. Other identity formats are intentionally not guessed.
  const mid=/^[2-7]\d{8}$/.test(String(mmsi))?String(mmsi).slice(0,3):'';
  const fallback=mids[mid]||{};
  const candidate=typeof supplied==='string'?supplied.trim():'';
  let code=/^[A-Za-z]{2}$/.test(candidate)?candidate.toUpperCase():'';
  if(code && (regions.of(code)===code||['ZZ','XA','XB'].includes(code))) code='';
  if(candidate.length>2)code=countryCodes.get(candidate.toLowerCase())||'';
  else code=code||fallback.code||'';
  const country=candidate.length>2?clean(candidate):code?regions.of(code):fallback.country||'';
  return {country,flagCountry:country,flagSource:candidate?'provider':'mid',flagEmoji:code?String.fromCodePoint(...[...code].map(c=>127397+c.charCodeAt(0))):''};
}
function vesselMetadata(id, props={}) {
  const value=props.typeCode??props.type??props.ship_type;
  const typeCode=Number.isInteger(value)&&value>=0&&value<=99?value:null;
  return {callsign:clean(props.callsign??props.call_sign??props.CallSign,24),name:clean(props.name),typeCode,typeName:vesselType(typeCode),...flagState(id,props.flag??props.flag_country??props.country),photoUrl:null,photoThumbnailUrl:null,photoCredit:null,photoLink:null,photoSource:null};
}
function staticVesselMetadata(event) {
  if(!['ShipStaticData','StaticDataReport'].includes(event?.MessageType))return null;
  const body=event.Message?.[event.MessageType];
  if(!body || body.Valid===false)return null;
  const id=String(event.MetaData?.MMSI??body.UserID??'');
  if(!/^\d{9}$/.test(id))return null;
  let name, callsign, typeCode;
  if(event.MessageType==='ShipStaticData') {name=body.Name;callsign=body.CallSign;typeCode=body.Type;}
  else {
    if(body.ReportA?.Valid===true || (body.ReportA?.Valid!==false && body.PartNumber===false)) name=body.ReportA?.Name;
    if(body.ReportB?.Valid===true || (body.ReportB?.Valid!==false && body.PartNumber===true)) {callsign=body.ReportB?.CallSign;typeCode=body.ReportB?.ShipType;}
  }
  return {kind:'vessel',id,...vesselMetadata(id,{name,callsign,typeCode})};
}
class MetadataCache {
  constructor(ttl=6*3600000, max=10000){this.ttl=ttl;this.max=max;this.entries=new Map();}
  merge(target,now=Date.now()) {
    const key=`${target.kind}:${target.id}`;const entry=this.entries.get(key);
    const result=mergeTarget(entry&&now-entry.at<this.ttl?entry.value:null,target);
    const value={};for(const field of staticFields)if(result[field]!==undefined)value[field]=result[field];
    this.entries.delete(key);this.entries.set(key,{at:now,value});
    while(this.entries.size>this.max)this.entries.delete(this.entries.keys().next().value);
    return result;
  }
}
module.exports={clean,vesselType,flagState,vesselMetadata,staticVesselMetadata,MetadataCache};
