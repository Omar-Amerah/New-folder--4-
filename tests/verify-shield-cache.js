"use strict";

const assert = require("assert");
const { effectiveShieldStats } = require("./src/server/componentPower");
const { updateRuntimeShield } = require("./src/server/runtimeShield");
const { resetRoomTelemetry, getRoomTelemetry } = require("./src/server/roomTelemetry");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { rebuildShipWiringState } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const HeatRules = require("./public/src/shared/heatRules");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });

function wiringFor(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const path of paths) wiring = WiringRules.addConnection(wiring, "power", path[0], path[1], path[2], design, PARTS);
  return wiring;
}

function makeShip(design, paths = []) {
  const ship = { design, wiring: wiringFor(design, paths), stats: computeStats(design), shield: 0, alive: true };
  initComponentState(ship);
  initShipHeat(ship);
  rebuildShipWiringState(ship, "test");
  return ship;
}

function makeRoom() {
  return { _roomTelemetry: null };
}

function run() {
  const design = [at("reactor", 0, 0), at("shield", 1, 0)];
  const ship = makeShip(design, [[0, 1, [{x:0, y:0}, {x:1, y:0}]]]);
  const room = makeRoom();

  // --- Cache miss on first call, hit on second -----------------------------
  ship._shieldStatsCache = null;
  resetRoomTelemetry(room);
  const first = effectiveShieldStats(ship, room);
  const second = effectiveShieldStats(ship, room);
  const telemetry = getRoomTelemetry(room);
  assert(telemetry.shieldDerivedStatCacheMisses > 0, "first call must be a cache miss");
  assert(telemetry.shieldDerivedStatCacheHits > 0, "second call must be a cache hit");
  assert.strictEqual(first.capacity, second.capacity, "cached capacity must match");
  assert.strictEqual(first.recharge, second.recharge, "cached recharge must match");

  // --- Component destruction invalidates cache -----------------------------
  ship._shieldStatsCache = null;
  resetRoomTelemetry(room);
  const before = effectiveShieldStats(ship, room);
  ship.componentHp[1] = 0;
  ship.componentAliveRevision = (ship.componentAliveRevision || 0) + 1;
  const after = effectiveShieldStats(ship, room);
  const t2 = getRoomTelemetry(room);
  assert(t2.shieldDerivedStatCacheMisses > 0, "cache must miss after component alive change");
  assert(after.capacity < before.capacity, "destroyed shield must reduce capacity");

  // --- Heat state change invalidates cache ---------------------------------
  const ship2 = makeShip(design, [[0, 1, [{x:0, y:0}, {x:1, y:0}]]]);
  ship2._shieldStatsCache = null;
  resetRoomTelemetry(room);
  const base = effectiveShieldStats(ship2, room);
  ship2.componentHeatState[1] = HeatRules.STATE.HOT;
  ship2.heatStateRevision = (ship2.heatStateRevision || 0) + 1;
  const hot = effectiveShieldStats(ship2, room);
  const t3 = getRoomTelemetry(room);
  assert(t3.shieldDerivedStatCacheMisses > 0, "cache must miss after heat state change");
  assert.strictEqual(hot.capacity, base.capacity, "heat must not change capacity");
  assert(hot.recharge < base.recharge, "heat must reduce recharge");

  // --- Runtime shield update uses the cache --------------------------------
  const ship3 = makeShip(design, [[0, 1, [{x:0, y:0}, {x:1, y:0}]]]);
  ship3._shieldStatsCache = null;
  resetRoomTelemetry(room);
  updateRuntimeShield(ship3, 0.1, 1000, room);
  const t4 = getRoomTelemetry(room);
  assert(t4.shieldDerivedStatCacheMisses > 0, "runtime shield first call computes");
  updateRuntimeShield(ship3, 0.1, 1100, room);
  const t5 = getRoomTelemetry(room);
  assert(t5.shieldDerivedStatCacheHits > t4.shieldDerivedStatCacheHits, "runtime shield second call hits cache");

  console.log("verify-shield-cache: OK");
}

run();
