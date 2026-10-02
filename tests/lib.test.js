'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBoundingBox, inBounds, normalizeAircraft, normalizeVessel } = require('../backend/lib');

test('accepts a local AIS bounding box, rejects huge or malformed boxes', () => {
  assert.deepEqual(validateBoundingBox([-35, 138, -34, 139]), [-35, 138, -34, 139]);
  assert.equal(validateBoundingBox([-40, 130, 40, 160]), null);
  assert.equal(validateBoundingBox([-35, 139, -34, 138]), null);
  assert.equal(validateBoundingBox(['not-a-number', 138, -34, 139]), null);
  assert.equal(inBounds(-34.9, 138.6, [-35, 138, -34, 139]), true);
  assert.equal(inBounds(-33, 138.6, [-35, 138, -34, 139]), false);
});

test('normalizes a fresh ADS-B aircraft', () => {
  const a = normalizeAircraft({ hex: '7c2345', lat: -34.92, lon: 138.6, flight: 'QFA123 ', alt_baro: 32000, gs: 431.9, track: 220, seen_pos: 4 }, 1000);
  assert.equal(a.id, '7C2345'); assert.equal(a.callsign, 'QFA123'); assert.equal(a.speedKt, 432);
  assert.equal(a.altitudeFt, 32000); assert.equal(a.updatedAt, 1000);
  assert.equal(normalizeAircraft({ hex: '123abc', lat: 10, lon: 10, seen_pos: 500 }), null);
  assert.equal(normalizeAircraft({ hex: '123abc', lat: undefined, lon: 10 }), null);
});

test('normalizes AIS position with metadata and rejects invalid messages', () => {
  const message = { MessageType: 'PositionReport', MetaData: { MMSI: 123456789, ShipName: 'TEST SHIP', Latitude: -34.8, Longitude: 138.5 }, Message: { PositionReport: { Sog: 8.5, Cog: 90, TrueHeading: 511 } } };
  const v = normalizeVessel(message, 2000);
  assert.equal(v.id, '123456789'); assert.equal(v.name, 'TEST SHIP');
  assert.equal(v.speedKt, 8.5); assert.equal(v.heading, 90); assert.equal(v.updatedAt, 2000);
  assert.equal(normalizeVessel({ ...message, MessageType: 'ShipStaticData' }), null);
  assert.equal(normalizeVessel({ ...message, MetaData: { ...message.MetaData, MMSI: 11 } }), null);
});

test('rejects coerced bounding-box coordinates', () => {
  for (const value of [null, false, '', '0', [], {}]) {
    assert.equal(validateBoundingBox([value, 0, 1, 1]), null);
  }
});

test('AIS uses the report position and preserves unknown numeric fields', () => {
  const event = { MessageType: 'PositionReport', MetaData: { MMSI: 123456789, Latitude: 10, Longitude: 20 }, Message: { PositionReport: { Latitude: 0, Longitude: 0, Sog: null, Cog: null, TrueHeading: null } } };
  const vessel = normalizeVessel(event);
  assert.equal(vessel.lat, 0); assert.equal(vessel.lon, 0);
  assert.equal(vessel.speedKt, null); assert.equal(vessel.heading, null);
  event.Message.PositionReport.Latitude = null;
  event.MetaData.Latitude = null;
  assert.equal(normalizeVessel(event), null);
});
