'use strict';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validLatLon(lat, lon) {
  return finite(lat) && finite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function validateBoundingBox(input) {
  if (!Array.isArray(input) || input.length !== 4) return null;
  if (!input.every(finite)) return null;
  const vals = input;
  if (!vals.every(Number.isFinite)) return null;
  const [south, west, north, east] = vals;
  if (!validLatLon(south, west) || !validLatLon(north, east)) return null;
  if (south >= north || west >= east) return null;
  if (north - south > 8 || east - west > 12) return null;
  return [south, west, north, east];
}

function inBounds(lat, lon, bbox) {
  const [south, west, north, east] = bbox;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function normalizeAircraft(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !validLatLon(raw.lat, raw.lon)) return null;
  if (finite(raw.seen_pos) && raw.seen_pos > 90) return null;
  const id = String(raw.hex || '').toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
  if (!id) return null;
  return {
    kind: 'aircraft', id,
    lat: raw.lat, lon: raw.lon,
    callsign: String(raw.flight || '').trim().slice(0, 24),
    registration: String(raw.r || '').trim().slice(0, 24),
    type: String(raw.t || '').trim().slice(0, 20),
    altitudeFt: raw.alt_baro === 'ground' ? 0 : (finite(raw.alt_baro) ? Math.round(raw.alt_baro) : null),
    speedKt: finite(raw.gs) ? Math.round(raw.gs) : null,
    heading: finite(raw.track) ? ((raw.track % 360) + 360) % 360 : null,
    seenSeconds: finite(raw.seen_pos) ? raw.seen_pos : null,
    updatedAt: now,
  };
}

const AIS_POSITION_TYPES = new Set([
  'PositionReport', 'StandardClassBPositionReport',
  'ExtendedClassBPositionReport', 'LongRangeAisBroadcastMessage'
]);

function normalizeVessel(event, now = Date.now()) {
  if (!event || !AIS_POSITION_TYPES.has(event.MessageType)) return null;
  const meta = event.MetaData || {};
  const payload = event.Message?.[event.MessageType] || {};
  const lat = payload.Latitude ?? meta.Latitude;
  const lon = payload.Longitude ?? meta.Longitude;
  const id = String(meta.MMSI ?? payload.UserID ?? '').trim();
  if (!/^\d{9}$/.test(id) || !validLatLon(lat, lon)) return null;
  if (payload.Valid === false) return null;
  const speed = payload.Sog;
  const course = payload.Cog;
  const heading = payload.TrueHeading;
  return {
    kind: 'vessel', id, lat, lon,
    name: String(meta.ShipName || '').trim().slice(0, 70),
    speedKt: Number.isFinite(speed) && speed < 102.3 && speed >= 0 ? speed : null,
    heading: Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading
      : (Number.isFinite(course) && course >= 0 && course < 360 ? course : null),
    updatedAt: now,
  };
}

function normalizeOpenWatersVessel(feature, now = Date.now()) {
  if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point') return null;
  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lon, lat] = coordinates;
  const props = feature.properties || {};
  if (props.kind && props.kind !== 'vessel') return null;
  const id = String(props.mmsi ?? feature.id ?? '').trim();
  if (!/^\d{9}$/.test(id) || !validLatLon(lat, lon)) return null;
  const reportedAt = typeof props.seen === 'string' ? Date.parse(props.seen) : NaN;
  return {
    kind: 'vessel', id, lat, lon,
    name: String(props.name || '').trim().slice(0, 70),
    speedKt: finite(props.sog) && props.sog >= 0 && props.sog < 102.3 ? props.sog : null,
    heading: finite(props.heading) && props.heading >= 0 && props.heading < 360 ? props.heading
      : (finite(props.cog) && props.cog >= 0 && props.cog < 360 ? props.cog : null),
    updatedAt: Number.isFinite(reportedAt) ? Math.min(reportedAt, now) : now,
    source: String(props.source || '').slice(0, 100)
  };
}

module.exports = { clamp, validLatLon, validateBoundingBox, inBounds, normalizeAircraft, normalizeVessel, normalizeOpenWatersVessel };
