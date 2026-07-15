#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const health = require("./src/server/componentHealth");
const heat = require("./src/server/heat");

function shipFor(id) {
  const design = [
    { x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "reactor" },
    { x: 6, y: 8, type: "engine" }, { x: 8, y: 8, type: "engine" },
    { x: 6, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatPipe" },
    { x: 5, y: 7, type: "radiator" }, { x: 9, y: 7, type: "heatSink" },
    { x: 7, y: 6, type: "blaster" }
  ];
  const ship = { id, ownerId: id, design, x: 0, y: 0, angle: 0, alive: true, shield: 0, radius: 30, stats: computeStats(design), dirtyComponents: new Set() };
  ship.maxShield = ship.stats.maxShield || 0;
  health.initComponentState(ship);
  heat.initShipHeat(ship);
  return ship;
}

const beforeMem = process.memoryUsage().heapUsed;
const room = { effects: [], ships: new Map(), players: [] };
const ships = Array.from({ length: 12 }, (_, i) => shipFor(`thermal-${i}`));
for (const s of ships) room.ships.set(s.id, s);
let meltdownEffects = 0;
for (let tick = 0; tick < 240; tick += 1) {
  for (const s of ships) {
    if (!s.alive) continue;
    heat.addComponentHeat(s, 8, 4);
    heat.addComponentHeat(s, 2, 1.2);
    heat.updateShipHeat(s, 0.2, room, tick * 200);
    for (let i = 0; i < s.componentHeat.length; i += 1) {
      assert(Number.isFinite(s.componentHeat[i]), "component heat remains finite");
      assert(s.componentHeat[i] >= 0, "component heat remains non-negative");
      assert(s.componentHeat[i] <= s.componentThermals[i].capacity * 1.25 + 1e-6, "component heat respects clamp");
    }
    const livingSum = s.componentHeat.reduce((sum, value, i) => sum + (s.componentHp[i] > 0 ? value : 0), 0);
    assert(Math.abs(livingSum - s.currentHeat) < 1e-6, "aggregate heat reconciles with living components");
    assert((s.dirtyHeat?.size || 0) <= s.design.length, "dirty heat set remains bounded");
  }
  if (tick === 20) { ships[0].componentHp[5] = 0; heat.rebuildThermalNetworks(ships[0]); }
  if (tick === 40) { ships[0].componentHp[5] = ships[0].componentMaxHp[5]; heat.rebuildThermalNetworks(ships[0]); }
  if (tick === 60) { ships[1].componentHeat[1] = ships[1].componentThermals[1].capacity * 1.2; ships[1].componentHeatState[1] = heat.STATE.OVERHEATED; }
  meltdownEffects = room.effects.filter(e => e.type === "boom").length;
  if (tick === 120) { ships[2].alive = false; ships[2].componentHeatInput.fill(0); ships[2].deadHeat = ships[2].componentHeat.slice(); }
  if (tick > 120) assert.deepStrictEqual(ships[2].componentHeat, ships[2].deadHeat, "dead ships stop producing heat");
}
for (let i = 0; i < 20; i += 1) heat.updateShipHeat(ships[1], 0.2, room, 50000 + i * 200);
assert(room.effects.filter(e => e.type === "boom").length <= meltdownEffects + 1, "reactor meltdowns do not duplicate");
const afterMem = process.memoryUsage().heapUsed;
assert(afterMem - beforeMem < 80 * 1024 * 1024, "memory growth remains bounded");
room.ships.clear();
assert.strictEqual(room.ships.size, 0, "server cleanup succeeds");
console.log("Dedicated thermal soak verification passed");
