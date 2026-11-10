import assert from "node:assert/strict";
import test from "node:test";
import { recordsFromImport, tripDocument } from "../js/transfer.js";

const trip = {
  id: 4,
  startedAt: 1_000,
  endedAt: 61_000,
  distanceM: 1200,
  start: { lat: -43.09274, lon: 147.26189 },
  end: { lat: -42.8821, lon: 147.3251 },
  startAddress: "kept out",
  endAddress: "kept out",
};

test("an export keeps the times and points", () => {
  const document = tripDocument([trip]);
  assert.equal(document.layby, 1);
  assert.equal(document.trips.length, 1);
  assert.deepEqual(document.trips[0], {
    startedAt: 1_000,
    endedAt: 61_000,
    start: trip.start,
    end: trip.end,
  });
});

test("an import accepts the export and a bare list", () => {
  const exported = JSON.stringify(tripDocument([trip]));
  const fromDocument = recordsFromImport(exported);
  assert.equal(fromDocument.trips.length, 1);
  assert.equal(fromDocument.trips[0].startedAt, 1000);
  const fromList = recordsFromImport(JSON.stringify([trip]));
  assert.equal(fromList.trips.length, 1);
});

test("an import skips duplicates and unreadable rows", () => {
  const text = JSON.stringify({
    trips: [trip, trip, { startedAt: 5 }, { note: "no" }],
  });
  const result = recordsFromImport(text, [trip]);
  assert.equal(result.trips.length, 0);
  assert.equal(result.duplicate, 2);
  assert.equal(result.unreadable, 2);
});

test("postcodes, addresses, and distance are dropped", () => {
  const withExtras = { ...trip, startPostcode: "7054", endPostcode: "7000" };
  const exported = tripDocument([withExtras]);
  assert.equal("distanceM" in exported.trips[0], false);
  assert.equal("startAddress" in exported.trips[0], false);
  assert.equal("endAddress" in exported.trips[0], false);
  assert.equal("startPostcode" in exported.trips[0], false);
  const imported = recordsFromImport(JSON.stringify([withExtras]));
  assert.deepEqual(Object.keys(imported.trips[0]).sort(), ["end", "endedAt", "start", "startedAt"]);
});

test("text that is not a trip list is refused", () => {
  assert.throws(() => recordsFromImport("{"), /not JSON/);
  assert.throws(() => recordsFromImport("{}"), /no trip list/);
});
