#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { _test } = require("../src/server/drones");

const room = {
  world: { width: 500, height: 400 },
  map: { asteroids: [{ id: "rock", x: 250, y: 200, radius: 50 }] }
};

{
  const drone = { id: "edge", x: -30, y: 430, vx: -100, vy: 100, radius: 10 };
  _test.resolveDroneMapCollision(room, drone, 20, 390);
  assert.equal(drone.x, 10, "drone centre remains inside the left map edge");
  assert.equal(drone.y, 390, "drone centre remains inside the bottom map edge");
  assert.equal(drone.vx, 0, "outward horizontal velocity is removed at the map edge");
  assert.equal(drone.vy, 0, "outward vertical velocity is removed at the map edge");
}

{
  const drone = { id: "swept", x: 350, y: 200, vx: 400, vy: 0, radius: 10 };
  _test.resolveDroneMapCollision(room, drone, 150, 200);
  const clearance = Math.hypot(drone.x - 250, drone.y - 200);
  assert.ok(clearance >= 62 - 0.001, "fast drone cannot tunnel through an asteroid");
  assert.ok(drone.x < 250, "swept asteroid collision leaves the drone on its approach side");
}

{
  const drone = { id: "embedded", x: 250, y: 200, vx: 0, vy: 0, radius: 10 };
  _test.resolveDroneMapCollision(room, drone);
  assert.ok(Math.hypot(drone.x - 250, drone.y - 200) >= 62 - 0.001, "legacy embedded drone is pushed clear of map geometry");
}

{
  const a = { id: "d1", x: 100, y: 100, vx: 0, vy: 0, radius: 10, state: "active" };
  const b = { id: "d2", x: 100, y: 100, vx: 0, vy: 0, radius: 10, state: "active" };
  _test.resolveDroneSeparation([b, a]);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 22 - 0.001, "overlapping drones separate deterministically");
  const firstPositions = [a.x, a.y, b.x, b.y];
  const a2 = { id: "d1", x: 100, y: 100, vx: 0, vy: 0, radius: 10, state: "active" };
  const b2 = { id: "d2", x: 100, y: 100, vx: 0, vy: 0, radius: 10, state: "active" };
  _test.resolveDroneSeparation([a2, b2]);
  assert.deepEqual([a2.x, a2.y, b2.x, b2.y], firstPositions, "drone separation is independent of collection order");
}

console.log("Drone map-boundary, asteroid and separation verification passed");
