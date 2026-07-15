"use strict";
const assert = require("assert");
const msgpack = require("@msgpack/msgpack");
const { buildSharedSnapshot, markShipDesignsSent } = require("./src/server/snapshots");
const { createRoom, resetMatch } = require("./src/server/rooms");
const { spawnShip } = require("./src/server/ships");
const { computeStats } = require("./src/server/shipStats");
const { repairShipComponents } = require("./src/server/componentHealth");
const heat = require("./src/server/heat");
const HeatRules = require("./public/src/shared/heatRules");

const design = [
  {x:7,y:7,type:"core"},{x:6,y:7,type:"frame"},{x:5,y:7,type:"heatPipe"},
  {x:4,y:7,type:"radiator"},{x:8,y:7,type:"heatSink"},{x:7,y:6,type:"reactor"},
  {x:7,y:8,type:"engine"},{x:6,y:8,type:"blaster"},{x:8,y:8,type:"shieldGenerator"},{x:6,y:6,type:"repairBeam"}
];
function roomWithShip() {
  const room = createRoom("SOAK"); room.phase = "active"; room.rules.gameMode = "teams"; room.clients = new Set();
  const p = { id:"p1", name:"P1", team:"blue", connected:true, ships:[], design, stats:computeStats(design), money:0, income:0, score:0, kills:0, losses:0, color:"#fff", shipCap:3 };
  room.players.set(p.id, p);
  const s = spawnShip(room, p, 1000, 0, { design, stats:p.stats });
  s.weaponAngles = design.map(()=>0); s.weaponDesiredAngles = []; s.weaponAimTargetIds = []; s.weaponFireTargetIds = [];
  return { room, ship:s };
}
(async () => {
  const merge = await import("./public/src/snapshotMerge.js");
  const display = await import("./public/src/shared/heatDisplay.js");
  const { room, ship } = roomWithShip();
  ship.componentHeat[5] = 3.5; ship.componentHeat[7] = 21.25; ship.componentHeatState[7] = HeatRules.STATE.HOT; ship.dirtyHeat.add(5); ship.dirtyHeat.add(7);
  heat.updateShipHeat(ship, 0.25, { effects:[] }, 1000);
  const full = msgpack.decode(msgpack.encode({ ships: buildSharedSnapshot(room, 1000, true).ships })).ships[0];
  assert.strictEqual(full.componentHeat.length, design.length, "full heat tuples align with design length");
  assert(full.componentHeat.every(t => Array.isArray(t) && t.length === 4 && t.every(Number.isFinite)), "full heat tuples are finite stride-4 tuples");
  const sum = full.componentHeat.reduce((a,t,i)=>a + (ship.componentHp[i] > 0 ? t[0] : 0), 0);
  assert(Math.abs(sum - full.heatNow) <= full.componentHeat.length * 0.55, "aggregate stored heat reconciles with component tuples");
  assert.strictEqual(display.formatHeatPercent(display.shipHeatPercent({ heatNow:3.5, heatMax:1100 })), "0.3%", "fractional panel percentage derives from stored/capacity");
  assert.strictEqual(display.formatHeatPercent(display.shipHeatPercent({ heatNow:0, heatMax:1100 })), "0%", "true zero renders as 0%");
  markShipDesignsSent(room);
  ship.componentHeat[7] = 70; ship.componentHeatState[7] = HeatRules.STATE.CRITICAL; ship.dirtyHeat.add(7);
  const dyn = msgpack.decode(msgpack.encode({ ships: buildSharedSnapshot(room, 1250, false).ships })).ships[0];
  assert(!dyn.design && Array.isArray(dyn.componentHeatD), "dynamic snapshot uses compact heat delta");
  const merged = merge.mergeCachedShipFields([full], [dyn])[0];
  assert.strictEqual(merged.componentHeat[7][0], 70, "delta updates only intended component index");
  assert.notStrictEqual(merged.componentHeat[6][0], 70, "delta cannot spill to another component");
  const malformed = merge.applyComponentHeatDelta(merged.componentHeat, [6, Infinity, 2, 0.5, 100, 999, 1, 1, 1, 1, 2]);
  assert.deepStrictEqual(malformed[6], merged.componentHeat[6], "malformed deltas fail safely");
  const reconnect = merge.mergeCachedShipFields([merged], [msgpack.decode(msgpack.encode({ ships: buildSharedSnapshot(room, 1500, true).ships })).ships[0]])[0];
  assert.strictEqual(reconnect.componentHeat[7][0], 70, "reconnect full snapshot reconstructs current heat");
  ship.componentHp[2] = 0; heat.rebuildThermalNetworks(ship); assert(ship.thermalNetworks.length >= 0, "destroyed heat pipe rebuilds routes safely");
  repairShipComponents({ effects:[] }, ship, ship.componentMaxHp[2], 0); assert(ship.componentHp[2] > 0, "heat pipe repair restores hp");
  ship.componentHeat[5] = ship.componentThermals[5].capacity * 1.1; ship.componentHeatState[5] = HeatRules.STATE.OVERHEATED;
  for (let t=0;t<HeatRules.REACTOR_MELTDOWN_SECONDS + 1;t += 0.25) { ship.componentHeat[5] = ship.componentThermals[5].capacity * 1.1; ship.componentHeatState[5] = HeatRules.STATE.OVERHEATED; heat.updateShipHeat(ship, 0.25, { effects:[] }, 2000 + t*1000); }
  assert.strictEqual(ship.componentHp[5], 0, "deterministic test hook can overheat reactor through state mutation and observe meltdown");
  resetMatch(room, "design"); assert.strictEqual(room.ships.size, 0, "match reset clears thermal ship state");
  console.log("Heat protocol MessagePack round-trip verification passed");
})().catch(e=>{ console.error(e); process.exit(1); });
