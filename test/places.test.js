import assert from "node:assert/strict";
import test from "node:test";
import { nearestPlace } from "../js/places.js";

test("home coordinates are labelled Home", () => {
  assert.equal(nearestPlace({ lat: -43.09274, lon: 147.26189 }).name, "Home");
});

test("Hobart centre is labelled Hobart", () => {
  assert.equal(nearestPlace({ lat: -42.8821, lon: 147.3251 }).name, "Hobart");
});

test("a point in Snug is closer to Snug than to Home", () => {
  assert.equal(nearestPlace({ lat: -43.0668, lon: 147.2526 }).name, "Snug");
});
