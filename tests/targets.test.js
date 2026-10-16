'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const H=require('../target-model');
const {normalizeAircraft,normalizeVessel,normalizeOpenWatersVessel}=require('../backend/lib');
const {vesselType,flagState,staticVesselMetadata,MetadataCache}=require('../backend/vessel-metadata');

test('aircraft maps all telemetry fields and distinguishes ground from zero altitude',()=>{
  const x=normalizeAircraft({hex:'7c1234',lat:0,lon:0,flight:' QFA741 ',r:' VH-TEST ',t:' B738 ',alt_baro:34000,gs:451.8,track:-278});
  assert.equal(x.callsign,'QFA741');assert.equal(x.registration,'VH-TEST');assert.equal(x.type,'B738');
  assert.equal(x.altitudeFt,34000);assert.equal(x.speedKt,452);assert.equal(x.trackDeg,82);assert.equal(x.heading,82);
  assert.equal(H.altitudeText(x),'34,000 FT');assert.equal(H.trackText(x.trackDeg),'082°');
  const grounded=normalizeAircraft({hex:'7c1234',lat:0,lon:0,alt_baro:'ground'});
  assert.equal(grounded.onGround,true);assert.equal(grounded.altitudeFt,0);assert.equal(H.altitudeText(grounded),'GND');
  assert.equal(H.altitudeText({...grounded,onGround:false}),'0 FT');
});

test('type categories use AIS ranges without inventing reserved classifications',()=>{
  for(const [code,name] of [[30,'Fishing'],[31,'Towing'],[32,'Towing'],[33,'Dredging / Underwater Operations'],[34,'Diving'],[35,'Military'],[36,'Sailing'],[37,'Pleasure Craft'],[41,'High-Speed Craft'],[50,'Pilot Vessel'],[51,'Search and Rescue'],[52,'Tug'],[55,'Law Enforcement'],[69,'Passenger'],[71,'Cargo'],[80,'Tanker'],[90,'Other Vessel']])assert.equal(vesselType(code),name);
  for(const code of [null,0,10,38,56,100,'70'])assert.equal(vesselType(code),'VESSEL');
});

test('MID and supplied ISO flag state are local, conservative and safe for unknown identifiers',()=>{
  assert.equal(flagState('503123456').country,'Australia');assert.equal(flagState('503123456').flagEmoji,'🇦🇺');
  assert.equal(flagState('563123456').country,'Singapore');
  assert.equal(flagState('999123456').country,'');assert.equal(flagState('111503001').flagEmoji,'');
  assert.equal(flagState('503123456','PA').country,'Panama');assert.equal(flagState('503123456','PA').flagEmoji,'🇵🇦');
  assert.equal(flagState('503123456','Singapore').flagEmoji,'🇸🇬');
  assert.equal(flagState('999123456','ZZ').flagEmoji,'');
});

test('Open Waters COG and heading stay distinct; optional static metadata survives',()=>{
  const x=normalizeOpenWatersVessel({type:'Feature',id:503123456,geometry:{type:'Point',coordinates:[138,-34]},properties:{callsign:' VHOZ ',name:' EVER GIVEN ',type:70,sog:12.1,cog:274,heading:280,flag:'AU'}});
  assert.equal(x.callsign,'VHOZ');assert.equal(x.name,'EVER GIVEN');assert.equal(x.typeCode,70);assert.equal(x.typeName,'Cargo');
  assert.equal(x.trackDeg,274);assert.equal(x.headingDeg,280);assert.equal(x.speedKt,12.1);assert.equal(x.provider,'openwaters');
  assert.equal(H.orientation(x),280);assert.match(H.tagLines(x)[2],/274°/);
  const ais=normalizeVessel({MessageType:'PositionReport',MetaData:{MMSI:503123456,Latitude:-34,Longitude:138},Message:{PositionReport:{Sog:12.1,Cog:274,TrueHeading:511}}});
  assert.equal(ais.headingDeg,null);assert.equal(ais.trackDeg,274);assert.equal(H.orientation(ais),274);
});

const staticEvent=(type,payload)=>({MessageType:type,MetaData:{MMSI:503123456},Message:{[type]:{UserID:503123456,Valid:true,...payload}}});
test('ShipStaticData and both StaticDataReport halves extract metadata',()=>{
  const a=staticVesselMetadata(staticEvent('ShipStaticData',{CallSign:' VHOZ@@ ',Name:' EXAMPLE ',Type:70}));
  assert.equal(a.callsign,'VHOZ');assert.equal(a.name,'EXAMPLE');assert.equal(a.typeCode,70);assert.equal(a.typeName,'Cargo');
  const partA=staticVesselMetadata(staticEvent('StaticDataReport',{PartNumber:false,ReportA:{Valid:true,Name:'PART A'},ReportB:{Valid:false,CallSign:'IGNORE',ShipType:80}}));
  assert.equal(partA.name,'PART A');assert.equal(partA.callsign,'');
  const partB=staticVesselMetadata(staticEvent('StaticDataReport',{PartNumber:true,ReportA:{Valid:false,Name:'IGNORE'},ReportB:{Valid:true,CallSign:'VHXX',ShipType:52}}));
  assert.equal(partB.callsign,'VHXX');assert.equal(partB.typeName,'Tug');assert.equal(partB.name,'');
  assert.equal(staticVesselMetadata(staticEvent('ShipStaticData',{Valid:false})),null);
});

test('six-hour metadata cache merges successive records without erasing static data',()=>{
  const cache=new MetadataCache();const first={kind:'vessel',id:'503123456',callsign:'VHOZ',name:'EXAMPLE',typeCode:70,typeName:'Cargo',...flagState('503123456','PA')};
  cache.merge(first,0);
  const next=cache.merge({kind:'vessel',id:first.id,callsign:'',name:'',typeCode:0,typeName:'VESSEL',...flagState(first.id),lat:-34,lon:138,speedKt:null,trackDeg:90},1000);
  assert.equal(next.callsign,'VHOZ');assert.equal(next.name,'EXAMPLE');assert.equal(next.typeCode,70);assert.equal(next.typeName,'Cargo');assert.equal(next.country,'Panama');
  assert.equal(next.speedKt,null);assert.equal(next.trackDeg,90);
  assert.equal(cache.merge({kind:'vessel',id:first.id},7*3600000).callsign,undefined);
  cache.merge({kind:'aircraft',id:'7C1234',callsign:'QFA1',registration:'VH-X',type:'B738'},0);
  assert.equal(cache.merge({kind:'aircraft',id:'7C1234',callsign:'',type:'',registration:''},1000).type,'B738');
});

test('labels, case-insensitive search, missing telemetry and track-versus-heading formatting',()=>{
  const x={kind:'vessel',id:'503123456',name:'EXAMPLE',callsign:'VHOZ',country:'Australia',typeName:'Cargo',trackDeg:7,headingDeg:200};
  assert.equal(H.label(x),'VHOZ · EXAMPLE');assert.equal(H.label({...x,callsign:''}),'EXAMPLE');assert.equal(H.label({...x,callsign:'',name:''}),x.id);
  for(const query of ['vhoz','example','503','australia','cargo'])assert.equal(H.matches(x,query),true);
  assert.equal(H.trackText(null),'—');assert.equal(H.speedText(x),'—');assert.equal(H.trackText(x.trackDeg),'007°');assert.equal(H.orientation(x),200);
  assert.equal(H.orientation({kind:'aircraft',trackDeg:82,heading:180}),82);
  assert.equal(H.tagLines({kind:'aircraft',id:'HEX'})[1],'—  —');
});

test('military classification uses only the database military bit',()=>{
  const raw={hex:'7c1234',lat:-34.8,lon:138.5,flight:'RFR7123',r:'ZZ123',t:'A400M'};
  for(const flags of [1,3,5,'1','9']){
    const x=normalizeAircraft({...raw,dbFlags:flags});
    assert.equal(x.military,true);assert.equal(x.dbFlags,Number(flags));
  }
  for(const flags of [0,2,4,6,8,16,'2']){
    const x=normalizeAircraft({...raw,dbFlags:flags});assert.equal(x.military,false);assert.equal(x.dbFlags,Number(flags));
  }
  for(const flags of [undefined,null,'','bad',{},true,Infinity,-1,1.5]){
    const x=normalizeAircraft({...raw,dbFlags:flags});assert.equal(x.military,false);assert.equal(x.dbFlags,null);
  }
});

test('military metadata survives missing flags but explicit non-military flags replace it',()=>{
  const raw={hex:'7c1234',lat:-34.8,lon:138.5};const cache=new MetadataCache();
  const flagged=normalizeAircraft({...raw,dbFlags:1});cache.merge(flagged,0);
  const partial=normalizeAircraft(raw);
  assert.equal(partial.military,false);assert.equal(partial.dbFlags,null);
  const preserved=cache.merge(partial,1000);assert.equal(preserved.military,true);assert.equal(preserved.dbFlags,1);
  const cleared=cache.merge(normalizeAircraft({...raw,dbFlags:0}),2000);
  assert.equal(cleared.military,false);assert.equal(cleared.dbFlags,0);
  assert.equal(cache.merge(partial,3000).military,false);
  assert.equal(H.mergeTarget(flagged,{kind:'aircraft',id:flagged.id}).military,true);
});

test('military filter applies only to aircraft and badges do not pollute text search',()=>{
  const army={kind:'aircraft',id:'43C123',callsign:'RFR7123',type:'A400M',military:true};
  assert.equal(H.matchesFilter(army,'',true),true);
  assert.equal(H.matchesFilter({...army,military:false},'',true),false);
  assert.equal(H.matchesFilter({...army,military:undefined},'',true),false);
  assert.equal(H.matchesFilter({kind:'vessel',id:'503123456',name:'CARGO SHIP'},'',true),true);
  assert.equal(H.matchesFilter(army,'qfa',true),false);
  assert.equal(H.matches(army,'MIL'),false);assert.equal(H.matches(army,'MILITARY'),false);
  assert.equal(H.tagLines(army)[0],'MIL RFR7123');
  assert.equal(H.tagLines({...army,military:false})[0],'RFR7123');
  assert.equal(H.tagLines({kind:'vessel',id:'503123456',name:'SHIP',military:true})[0],'SHIP');
});
