import { haversineMeters } from "./geo.js";

const DEFAULTS = {
  stopRadiusM: 150,
  confirmRadiusM: 800,
  confirmFixes: 2,
  stopDurationMs: 5 * 60 * 1000,
  minTripDistanceM: 250,
  stillDisplayMs: 20 * 1000,
  maxAccuracyM: 100,
};

// A trip ends when the device stays within 150 m for five minutes, timed from
// the last real move. Ending the trip in the app records the stop immediately.
export function createTracker(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const state = blank();
  let pendingFinished = null;

  function start(now) {
    if (state.mode === "tracking") return view(now);
    if (state.mode === "paused") return resume(now);
    reset();
    state.mode = "tracking";
    state.locatingSince = now;
    return view(now);
  }

  function resume(now) {
    if (state.mode !== "paused") return view(now);
    state.mode = "tracking";
    if (!state.trip) state.locatingSince = state.locatingSince ?? now;
    return tick(now);
  }

  function stop(now) {
    if (state.mode !== "idle" && state.trip?.startedAt != null && state.trip.start) {
      const endedAt = isHolding(now) ? state.lastMovedAt : now;
      pendingFinished = buildFinished(endedAt);
    }
    reset();
    return view(now);
  }

  function discard() {
    pendingFinished = null;
    reset();
    return view(Date.now());
  }

  function fix(point) {
    if (state.mode !== "tracking" || !valid(point)) return view(point?.t ?? Date.now());
    const now = point.t;
    const accuracy = accuracyOf(point);
    state.lastAccuracy = accuracy;

    if (!state.trip) {
      state.lastFixAt = now;
      const waited = now - (state.locatingSince ?? now);
      if (accuracy <= cfg.maxAccuracyM || (waited >= 20_000 && accuracy <= 500)) {
        beginTrip(point, now);
      } else {
        state.provisional = latlon(point);
      }
      return view(now);
    }

    // Unusable fixes must not look like movement. Leaving lastFixAt alone lets
    // a stop complete when the only updates are too coarse to trust.
    if (accuracy > cfg.maxAccuracyM) {
      maybeClose(now);
      return view(now);
    }

    state.lastFixAt = now;
    state.lastGood = { ...latlon(point), accuracy };
    refineStart(point);

    const distance = haversineMeters(state.anchor, point);
    if (distance >= cfg.stopRadiusM) {
      state.outsideStreak += 1;
      if (distance >= cfg.confirmRadiusM || state.outsideStreak >= cfg.confirmFixes) {
        acceptMove(point, distance);
      }
    } else {
      state.outsideStreak = 0;
      state.sawStillFix = true;
      state.stillPoints.push(latlon(point));
      if (state.stillPoints.length > 30) state.stillPoints.shift();
    }

    maybeClose(now);
    return view(now);
  }

  function tick(now) {
    if (state.mode === "tracking") maybeClose(now);
    return view(now);
  }

  function peek(now) {
    return view(now);
  }

  function serialize() {
    if (state.mode === "idle") return null;
    return JSON.parse(JSON.stringify({
      trip: state.trip,
      anchor: state.anchor,
      outsideStreak: state.outsideStreak,
      lastMovedAt: state.lastMovedAt,
      lastFixAt: state.lastFixAt,
      lastGood: state.lastGood,
      sawStillFix: state.sawStillFix,
      stillPoints: state.stillPoints,
      startAccuracy: state.startAccuracy,
      locatingSince: state.locatingSince,
      provisional: state.provisional,
      lastAccuracy: state.lastAccuracy,
    }));
  }

  function restore(data) {
    pendingFinished = null;
    reset();
    if (!data || typeof data !== "object") return;
    const fields = [
      "trip",
      "anchor",
      "outsideStreak",
      "lastMovedAt",
      "lastFixAt",
      "lastGood",
      "sawStillFix",
      "stillPoints",
      "startAccuracy",
      "locatingSince",
      "provisional",
      "lastAccuracy",
    ];
    for (const key of fields) {
      if (key in data) state[key] = data[key];
    }
    if (!Array.isArray(state.stillPoints)) state.stillPoints = [];
    state.mode = "paused";
  }

  function beginTrip(point, now) {
    const here = latlon(point);
    state.trip = { startedAt: now, start: here, distanceM: 0 };
    state.anchor = here;
    state.lastMovedAt = now;
    state.sawStillFix = true;
    state.stillPoints = [here];
    state.outsideStreak = 0;
    state.startAccuracy = accuracyOf(point);
    state.provisional = null;
    state.lastGood = { ...here, accuracy: accuracyOf(point) };
  }

  function refineStart(point) {
    if (!state.trip?.startedAt || state.trip.distanceM !== 0 || !state.anchor) return;
    const accuracy = accuracyOf(point);
    if (accuracy + 5 >= (state.startAccuracy ?? Infinity)) return;
    if (haversineMeters(state.trip.start, point) > cfg.stopRadiusM) return;
    const here = latlon(point);
    state.trip.start = here;
    state.anchor = here;
    state.startAccuracy = accuracy;
  }

  function acceptMove(point, distance) {
    if (state.trip.startedAt == null) state.trip.startedAt = point.t;
    state.trip.distanceM += distance;
    const here = latlon(point);
    state.anchor = here;
    state.lastMovedAt = point.t;
    state.outsideStreak = 0;
    state.sawStillFix = false;
    state.stillPoints = [];
  }

  function maybeClose(now) {
    if (pendingFinished || state.mode !== "tracking") return;
    if (!isSavable() || state.lastMovedAt == null) return;
    if (now - state.lastMovedAt < cfg.stopDurationMs) return;
    const silent = state.lastFixAt == null || now - state.lastFixAt >= cfg.stopDurationMs;
    if (!state.sawStillFix && !silent) return;
    const finished = buildFinished(state.lastMovedAt);
    armNext(finished.end, now);
    pendingFinished = finished;
  }

  function buildFinished(endedAt) {
    const end = endPoint();
    return {
      startedAt: state.trip.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - state.trip.startedAt),
      distanceM: state.trip.distanceM,
      start: latlon(state.trip.start),
      end: latlon(end),
    };
  }

  function endPoint() {
    if (state.sawStillFix && state.stillPoints.length) return average(state.stillPoints);
    if (state.lastGood && state.anchor && haversineMeters(state.anchor, state.lastGood) <= cfg.stopRadiusM) {
      return latlon(state.lastGood);
    }
    return latlon(state.anchor || state.lastGood || state.trip.start);
  }

  function armNext(end, now) {
    const here = latlon(end);
    state.trip = { startedAt: null, start: here, distanceM: 0 };
    state.anchor = here;
    state.lastMovedAt = now;
    state.sawStillFix = true;
    state.stillPoints = [here];
    state.outsideStreak = 0;
  }

  function isSavable() {
    return state.trip?.startedAt != null && state.trip.distanceM >= cfg.minTripDistanceM;
  }

  function isHolding(now) {
    return isSavable() && state.lastMovedAt != null && now - state.lastMovedAt >= cfg.stillDisplayMs;
  }

  function isConfirming(now) {
    return isSavable()
      && state.lastMovedAt != null
      && now - state.lastMovedAt >= cfg.stopDurationMs
      && !pendingFinished;
  }

  function elapsedMs(now) {
    if (!state.trip?.startedAt || state.lastMovedAt == null) return 0;
    if (isHolding(now)) return Math.max(0, state.lastMovedAt - state.trip.startedAt);
    return Math.max(0, now - state.trip.startedAt);
  }

  function dwellMs(now) {
    if (!isSavable() || state.lastMovedAt == null) return 0;
    return Math.max(0, now - state.lastMovedAt);
  }

  function currentPhase(now) {
    if (state.mode === "idle") return "idle";
    if (state.mode === "paused") return "paused";
    if (!state.trip) return "locating";
    if (state.trip.startedAt == null) return "parked";
    if (state.trip.distanceM < cfg.minTripDistanceM) return "waiting";
    if (isHolding(now)) return "stationary";
    return "driving";
  }

  function view(now) {
    const dwell = dwellMs(now);
    const savable = isSavable();
    const finished = pendingFinished;
    pendingFinished = null;
    return {
      mode: state.mode,
      phase: currentPhase(now),
      startedAt: state.trip?.startedAt ?? null,
      start: state.trip?.start ? latlon(state.trip.start) : null,
      distanceM: state.trip?.distanceM ?? 0,
      elapsedMs: elapsedMs(now),
      dwellMs: dwell,
      remainingMs: savable ? Math.max(0, cfg.stopDurationMs - dwell) : null,
      confirming: isConfirming(now) && !finished,
      savable,
      holding: isHolding(now),
      stopMs: cfg.stopDurationMs,
      accuracy: state.lastAccuracy,
      finished,
    };
  }

  function reset() {
    const fresh = blank();
    for (const key of Object.keys(fresh)) state[key] = fresh[key];
  }

  return { start, resume, stop, discard, fix, tick, peek, serialize, restore };
}

function blank() {
  return {
    mode: "idle",
    trip: null,
    anchor: null,
    outsideStreak: 0,
    lastMovedAt: null,
    lastFixAt: null,
    lastGood: null,
    sawStillFix: false,
    stillPoints: [],
    startAccuracy: null,
    locatingSince: null,
    provisional: null,
    lastAccuracy: null,
  };
}

function valid(point) {
  return !!point
    && Number.isFinite(point.lat)
    && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90
    && Math.abs(point.lon) <= 180
    && Number.isFinite(point.t);
}

function accuracyOf(point) {
  return typeof point.accuracy === "number" && point.accuracy >= 0 ? point.accuracy : 40;
}

function latlon(point) {
  return { lat: point.lat, lon: point.lon };
}

function average(points) {
  let lat = 0;
  let lon = 0;
  for (const point of points) {
    lat += point.lat;
    lon += point.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}
