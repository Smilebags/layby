import assert from "node:assert/strict";
import test from "node:test";
import { haversineMeters } from "../js/geo.js";
import { formatClock, formatDuration, formatTripDuration, formatTripTime } from "../js/format.js";
import { createTracker } from "../js/tracker.js";

const origin = { lat: -37.8, lon: 144.96 };
const FIVE = 5 * 60 * 1000;

function at(meters, accuracy, t) {
  return {
    lat: origin.lat + meters / 111320,
    lon: origin.lon,
    accuracy,
    t,
  };
}

test("identical coordinates have no distance", () => {
  assert.equal(haversineMeters(origin, origin), 0);
});

test("duration and clock formatting", () => {
  assert.equal(formatDuration(48_000), "48 sec");
  assert.equal(formatDuration(90_000), "2 min");
  assert.equal(formatDuration(19 * 60_000), "19 min");
  assert.equal(formatDuration((60 + 12) * 60_000), "1 h 12 min");
  assert.equal(formatClock(75_000), "1:15");
  assert.equal(formatClock(3_661_000), "1:01:01");
  assert.equal(formatTripDuration(27 * 60_000), "27m");
  assert.equal(formatTripDuration(60 * 60_000), "1h0m");
  assert.equal(formatTripDuration((60 + 5) * 60_000), "1h5m");
  assert.equal(formatTripTime(new Date(2026, 10, 2, 8, 10, 5).getTime()), "08:10");
});

test("the default stop is five minutes", () => {
  assert.equal(createTracker().peek(0).stopMs, FIVE);
});

test("a coarse fix waits, then a precise fix becomes the start", () => {
  const tracker = createTracker();
  tracker.start(0);
  const waiting = tracker.fix(at(0, 400, 1_000));
  assert.equal(waiting.phase, "locating");
  assert.equal(waiting.startedAt, null);
  const started = tracker.fix(at(0, 12, 2_000));
  assert.equal(started.phase, "waiting");
  assert.equal(started.startedAt, 2_000);
  assert.equal(started.start.lat, origin.lat);
});

test("a better fix refines the start location before the car moves", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 20, 1_000));
  const better = at(11, 4, 2_000);
  const view = tracker.fix(better);
  assert.equal(view.startedAt, 1_000);
  assert.ok(Math.abs(view.start.lat - better.lat) < 1e-9);
});

test("one GPS spike does not count as driving", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 0));
  tracker.fix(at(500, 8, 1_000));
  tracker.fix(at(0, 8, 2_000));
  assert.equal(tracker.peek(2_000).distanceM, 0);
});

test("sitting at the start for five minutes does not file a trip", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  const view = tracker.tick(1_000 + FIVE + 1_000);
  assert.equal(view.finished, null);
  assert.equal(view.phase, "waiting");
});

test("a trip files five minutes after the car stops", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_200, 8, 60_000));
  tracker.fix(at(1_200, 8, 61_000));
  const early = tracker.tick(60_000 + FIVE - 1);
  assert.equal(early.finished, null);
  assert.equal(early.phase, "stationary");
  assert.equal(early.elapsedMs, 59_000);
  const filed = tracker.tick(60_000 + FIVE);
  assert.equal(filed.finished.startedAt, 1_000);
  assert.equal(filed.finished.endedAt, 60_000);
  assert.equal(filed.finished.durationMs, 59_000);
  assert.ok(Math.abs(filed.finished.start.lat - origin.lat) < 1e-9);
  assert.ok(Math.abs(filed.finished.end.lat - (origin.lat + 1200 / 111320)) < 1e-6);
  assert.equal(filed.phase, "parked");
  assert.equal(tracker.tick(60_000 + FIVE + 10_000).finished, null);
});

test("a short move under the minimum does not file on its own", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 0));
  tracker.fix(at(160, 8, 1_000));
  tracker.fix(at(220, 8, 2_000));
  tracker.fix(at(220, 8, 3_000));
  const view = tracker.tick(2_000 + FIVE);
  assert.equal(view.finished, null);
  assert.ok(view.distanceM > 200 && view.distanceM < 250);
});

test("a pause in traffic does not end the trip", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_200, 8, 10_000));
  assert.equal(tracker.tick(10_000 + 2 * 60_000).finished, null);
  tracker.fix(at(2_400, 8, 10_000 + 3 * 60_000));
  assert.equal(tracker.tick(10_000 + FIVE).finished, null);
});

test("coarse fixes do not block the five-minute stop or add distance", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_200, 8, 10_000));
  let view = null;
  for (let minute = 1; minute <= 5; minute += 1) {
    view = tracker.fix(at(5_000, 250, 10_000 + minute * 60_000));
  }
  assert.ok(view.finished);
  assert.equal(view.finished.endedAt, 10_000);
  assert.ok(view.finished.distanceM < 1_500);
});

test("ending the trip in the app records the stop immediately", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_200, 8, 10_000));
  const moving = tracker.stop(20_000);
  assert.equal(moving.finished.startedAt, 1_000);
  assert.equal(moving.finished.endedAt, 20_000);
  assert.equal(moving.mode, "idle");

  const held = createTracker();
  held.start(0);
  held.fix(at(0, 8, 1_000));
  held.fix(at(1_200, 8, 10_000));
  const mid = held.tick(40_000);
  assert.equal(mid.holding, true);
  assert.equal(mid.elapsedMs, 9_000);
  const stopped = held.stop(45_000);
  assert.equal(stopped.finished.endedAt, 10_000);
  assert.equal(stopped.finished.durationMs, 9_000);
});

test("an explicit end before any driving still records the start", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  const view = tracker.stop(4_000);
  assert.equal(view.finished.startedAt, 1_000);
  assert.equal(view.finished.endedAt, 4_000);
  assert.equal(view.finished.start.lat, view.finished.end.lat);
});

test("cancel before a fix records nothing", () => {
  const tracker = createTracker();
  tracker.start(0);
  assert.equal(tracker.stop(1_000).finished, null);
});

test("the next trip starts when the car moves again", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_000, 8, 50_000));
  tracker.fix(at(1_000, 8, 51_000));
  const first = tracker.tick(50_000 + FIVE);
  const leave = 50_000 + FIVE + 30 * 60_000;
  tracker.fix(at(2_000, 8, leave));
  tracker.fix(at(3_200, 8, leave + 120_000));
  tracker.fix(at(3_200, 8, leave + 121_000));
  const second = tracker.tick(leave + 120_000 + FIVE);
  assert.equal(second.finished.startedAt, leave);
  assert.equal(second.finished.endedAt, leave + 120_000);
  assert.equal(second.finished.durationMs, 120_000);
  assert.ok(Math.abs(second.finished.start.lat - first.finished.end.lat) < 1e-6);
});

test("a paused stop files when tracking resumes", () => {
  const tracker = createTracker();
  tracker.start(0);
  tracker.fix(at(0, 8, 1_000));
  tracker.fix(at(1_000, 8, 20_000));
  tracker.fix(at(1_000, 8, 21_000));
  const copy = createTracker();
  copy.restore(tracker.serialize());
  assert.equal(copy.tick(20_000 + FIVE).finished, null);
  assert.equal(copy.peek(20_000 + FIVE).phase, "paused");
  const filed = copy.resume(20_000 + FIVE);
  assert.equal(filed.finished.endedAt, 20_000);
  assert.equal(filed.finished.startedAt, 1_000);
});
