"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { PARTS } = require("./src/server/components");
const WiringRules = require("./public/src/shared/wiringRules");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat } = require("./src/server/heat");
const { rebuildShipWiringState, applyShipPowerAllocation } = require("./src/server/componentPower");
const Data = require("./src/server/componentData");
const { updateShipWeapons } = require("./src/server/combat");
const { snapshotRoom } = require("./src/server/snapshots");

const ARTIFACT = "test-artifacts/performance/wiring-runtime-performance.json";
const mod = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
function wire(design, paths) { let wiring = WiringRules.emptyWiring(); for (const p of paths) wiring = WiringRules.addPath(wiring, "data", p, design, PARTS); for (const p of paths) wiring = WiringRules.addPath(wiring, "power", p, design, PARTS); return wiring; }
function makeShip(id, ownerId, x, y) {
  const design = [mod("reactor", 6, 6), mod("fireControl", 7, 6), mod("sensorArray", 8, 6), mod("targetingComputer", 6, 7), mod("railgun", 7, 7), mod("blaster", 8, 7), mod("pointDefense", 7, 8), mod("beamEmitter", 8, 8), mod("frame", 6, 8)];
  const paths = [[{x:6,y:6},{x:7,y:6},{x:8,y:6},{x:8,y:7},{x:8,y:8}], [{x:6,y:7},{x:7,y:7},{x:7,y:8}]];
  const ship = { id, ownerId, alive: true, x, y, vx: 0, vy: 0, angle: ownerId === "p1" ? 0 : Math.PI, targetX: x, targetY: y, radius: 36, shield: 0, maxShield: 0, design, wiring: wire(design, paths), stats: computeStats(design), designRevision: 1 };
  initComponentState(ship); initShipHeat(ship); rebuildShipWiringState(ship, "perf-spawn", { skipRuntimeStats: true });
  ship.weaponCooldowns = design.map(() => 0); ship.weaponAngles = design.map(() => 0);
  return ship;
}
function makeRoom() {
  const room = { code: "PERF", phase: "active", players: new Map([["p1", { id:"p1", name:"A", team:"a", color:"#3af", ships:[], design:[] }], ["p2", { id:"p2", name:"B", team:"b", color:"#f66", ships:[], design:[] }]]), ships: new Map(), bullets: [], effects: [], map:{asteroids:[], safeZones:[{x:500,y:750,radius:900,ownerId:"p1"},{x:950,y:750,radius:900,ownerId:"p2"}]}, points:[], rules:{gameMode:"solo"}, world:{width:4000,height:3000}, stateEpoch:1, snapshotSeq:1, staticRevision:1, combatRandom: () => 0.5 };
  for (let i=0;i<20;i++) { const owner = i < 10 ? "p1" : "p2"; const s = makeShip(`s${i}`, owner, owner === "p1" ? 500 : 950, 350 + (i % 10) * 80); room.ships.set(s.id, s); room.players.get(owner).ships.push(s); }
  return room;
}
function resetCounters() { global.__mfaDataSupportPerf = { wiringNormalizationCount:0, wiringAnalysisCount:0, powerAnalysisCount:0, dataTopologyRebuildCount:0, allocationRefreshCount:0, profileBuildCount:0, profileCacheHitCount:0 }; return global.__mfaDataSupportPerf; }
function revisions(ship) { return { topology: ship.runtimeDataSupport.topologyRevision, allocation: ship.runtimeDataSupport.allocationRevision, profile: ship.effectiveWeaponProfileCache?.revision || 0 }; }
function percentile(values, p) { const a=[...values].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.floor((a.length-1)*p))]; }

const room = makeRoom();
for (const s of room.ships.values()) Data.ensureEffectiveWeaponProfileCache(s);
const before = new Map([...room.ships.values()].map(s => [s.id, revisions(s)]));
const counters = resetCounters();
const tickTimes = [];
for (let t=0;t<300;t++) { const start=performance.now(); const ships=[...room.ships.values()]; for (const s of ships) updateShipWeapons(room, s, ships, 1/30, t*33.333); tickTimes.push(performance.now()-start); }
for (const s of room.ships.values()) assert.deepStrictEqual(revisions(s), before.get(s.id), "steady revisions unchanged");
assert.strictEqual(counters.wiringNormalizationCount, 0, "steady combat must not normalize wiring");
assert.strictEqual(counters.wiringAnalysisCount, 0, "steady combat must not analyze wiring");
assert.strictEqual(counters.profileBuildCount, 0, "steady combat must not rebuild profile cache");
assert(counters.profileCacheHitCount > 0, "steady combat must read cached profiles");

const one = room.ships.get("s0");
resetCounters();
one.componentPower.byComponentIndex[1].operationalMultiplier = 0.5; Data.refreshShipDataAllocation(one, "perf-power-change"); Data.ensureEffectiveWeaponProfileCache(one);
assert.strictEqual(global.__mfaDataSupportPerf.dataTopologyRebuildCount, 0, "power change must not rebuild topology");
assert.strictEqual(global.__mfaDataSupportPerf.allocationRefreshCount, 1, "power change refreshes allocation once");
assert.strictEqual(global.__mfaDataSupportPerf.profileBuildCount, 1, "power change rebuilds profiles once");
resetCounters(); Data.refreshShipDataAllocation(one, "same"); Data.ensureEffectiveWeaponProfileCache(one);
assert.strictEqual(global.__mfaDataSupportPerf.dataTopologyRebuildCount + global.__mfaDataSupportPerf.profileBuildCount, 0, "repeating same state causes no topology/profile work");

resetCounters(); one.componentHp[1] = 0; one.componentHp[2] = 0; rebuildShipWiringState(one, "batched-destruction", { skipRuntimeStats: true });
assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount, 1, "destruction batches one normalization");
assert.strictEqual(global.__mfaDataSupportPerf.powerAnalysisCount, 1, "destruction batches one Power analysis");
assert.strictEqual(global.__mfaDataSupportPerf.wiringAnalysisCount, 1, "destruction batches one Data analysis");
resetCounters(); one.componentHp[1] = one.componentMaxHp[1]; one.componentHp[2] = one.componentMaxHp[2]; rebuildShipWiringState(one, "batched-repair", { skipRuntimeStats: true });
assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount, 1, "repair batches one normalization");
assert.strictEqual(global.__mfaDataSupportPerf.powerAnalysisCount, 1, "repair batches one Power analysis");
assert.strictEqual(global.__mfaDataSupportPerf.wiringAnalysisCount, 1, "repair batches one Data analysis");

const full = snapshotRoom(room, 0, null, true, null, { knownShipDesignRevisions:new Map(), knownShipPowerRevisions:new Map() });
let componentPowerTransmissions = 0; const sizes = [];
const client = { knownShipDesignRevisions: new Map(full.ships.map(s => [s.id, s.designRevision || 1])), knownShipPowerRevisions: new Map(full.ships.map(s => [s.id, s.powerRevision || 0])) };
for (let i=0;i<120;i++) { const snap = snapshotRoom(room, i*66.667, null, false, null, client); const json=JSON.stringify(snap); sizes.push(Buffer.byteLength(json)); componentPowerTransmissions += snap.ships.filter(s => s.componentPower).length; }
assert.strictEqual(componentPowerTransmissions, 0, "unchanged compact snapshots omit componentPower repeatedly");
const pixiShips = fs.readFileSync("public/src/game/pixi/pixiShips.js", "utf8");
assert(/pixiStaticSignature\(pixiDesignSignature\(design\), player\.color, ship\.radius/.test(pixiShips), "Pixi static key excludes runtime power/data revisions");
assert(!/componentPower|powerRevision|wiringRevision|topologyRevision|allocationRevision|effectiveWeaponProfile/.test(pixiShips.match(/pixiStaticSignature[\s\S]{0,220}/)?.[0] || ""), "runtime fields do not drive static ship rebuilds");

const report = { ticks: { p50: percentile(tickTimes,.5), p95: percentile(tickTimes,.95), p99: percentile(tickTimes,.99), max: Math.max(...tickTimes), over33_3: tickTimes.filter(v=>v>33.3).length }, counts: counters, snapshotSizes: { min: Math.min(...sizes), max: Math.max(...sizes), p50: percentile(sizes,.5) }, componentPowerTransmissions };
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true }); fs.writeFileSync(ARTIFACT, JSON.stringify(report, null, 2));
console.log(`Data-support performance verification passed: ${ARTIFACT}`);
