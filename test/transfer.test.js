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
  startPostcode: "",
  startAddress: "",
  endPostcode: "",
  endAddress: "",
};

test("an export keeps the trip fields and drops the local id", () => {
  const document = tripDocument([trip]);
  assert.equal(document.layby, 1);
  assert.equal(document.trips.length, 1);
  assert.equal("id" in document.trips[0], false);
  assert.equal(document.trips[0].distanceM, 1200);
  assert.deepEqual(document.trips[0].start, trip.start);
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

test("a missing distance is filled from the two points", () => {
  const copy = { ...trip, distanceM: undefined };
  const result = recordsFromImport(JSON.stringify([copy]));
  assert.ok(result.trips[0].distanceM > 0);
});

test("text that is not a trip list is refused", () => {
  assert.throws(() => recordsFromImport("{"), /not JSON/);
  assert.throws(() => recordsFromImport("{}"), /no trip list/);
});
