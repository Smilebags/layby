import assert from "node:assert/strict";
import test from "node:test";
import { haversineMeters } from "../js/geo.js";
import { nearestPlace } from "../js/places.js";

test("home coordinates are labelled Home", () => {
  assert.equal(nearestPlace({ lat: -43.09274, lon: 147.26189 }).name, "Home");
});

test("Hobart centre is labelled Hobart", () => {
  assert.equal(nearestPlace({ lat: -42.8821, lon: 147.3251 }).name, "Hobart");
});

test("Kingston is 500m southwest of its previous centre", () => {
  const previous = { lat: -42.9786, lon: 147.3001 };
  const kingston = nearestPlace({ lat: -42.98178, lon: 147.29575 });
  assert.equal(kingston.name, "Kingston");
  assert.ok(Math.abs(haversineMeters(previous, kingston) - 500) < 1);
  assert.ok(kingston.lat < previous.lat);
  assert.ok(kingston.lon < previous.lon);
});

test("a point in Snug is closer to Snug than to Home", () => {
  assert.equal(nearestPlace({ lat: -43.0668, lon: 147.2526 }).name, "Snug");
});

test("added places are labelled from their own centre", () => {
  const places = [
    ["Chippendale", -33.8863, 151.1998],
    ["Surry Hills", -33.8845, 151.21],
    ["Camperdown", -33.8896, 151.1801],
    ["Centennial Park", -33.8978, 151.2339],
    ["Watsons Bay", -33.8433, 151.2826],
    ["Bowral", -34.4817, 150.4178],
    ["Canberra", -35.2976, 149.1013],
    ["Albury", -36.0738, 146.9135],
    ["Seddon", -37.8068, 144.8916],
    ["Geelong", -38.1493, 144.3598],
    ["Devonport", -41.1798, 146.3613],
  ];
  for (const [name, lat, lon] of places) {
    assert.equal(nearestPlace({ lat, lon }).name, name);
  }
});
