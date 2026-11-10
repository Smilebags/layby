import { haversineMeters } from "./geo.js";

export function tripDocument(trips) {
  return {
    layby: 1,
    trips: trips.map(exportTrip),
  };
}

export function recordsFromImport(text, existing = []) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON.");
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.trips;
  if (!Array.isArray(rows)) throw new Error("The file has no trip list.");
  const accepted = [];
  let unreadable = 0;
  let duplicate = 0;
  const seen = new Set(existing.map(tripKey));
  for (const row of rows) {
    const record = normalizeTrip(row);
    if (!record) {
      unreadable += 1;
      continue;
    }
    const key = tripKey(record);
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    accepted.push(record);
  }
  return { trips: accepted, unreadable, duplicate };
}

function exportTrip(trip) {
  return {
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    distanceM: trip.distanceM,
    start: { lat: trip.start.lat, lon: trip.start.lon },
    end: { lat: trip.end.lat, lon: trip.end.lon },
    startPostcode: text(trip.startPostcode),
    startAddress: text(trip.startAddress),
    endPostcode: text(trip.endPostcode),
    endAddress: text(trip.endAddress),
  };
}

function normalizeTrip(row) {
  if (!row || typeof row !== "object") return null;
  const startedAt = Number(row.startedAt);
  const endedAt = Number(row.endedAt);
  const start = point(row.start);
  const end = point(row.end);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return null;
  if (!start || !end) return null;
  const distance = Number(row.distanceM);
  return {
    startedAt,
    endedAt,
    distanceM: Number.isFinite(distance) && distance >= 0 ? Math.round(distance) : Math.round(haversineMeters(start, end)),
    start,
    end,
    startPostcode: text(row.startPostcode),
    startAddress: text(row.startAddress),
    endPostcode: text(row.endPostcode),
    endAddress: text(row.endAddress),
  };
}

function point(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function tripKey(trip) {
  const place = (pointValue) => `${pointValue.lat.toFixed(6)},${pointValue.lon.toFixed(6)}`;
  return `${trip.startedAt}:${trip.endedAt}:${place(trip.start)}:${place(trip.end)}`;
}
