"use strict";

// Combat Power-wiring overlay snapshot verifier. Confirms the new powerWiring
// (static layout) and powerWiringRuntime (live per-section) blocks are complete,
// efficient (layout resent only on wiring-revision change), delta-preserving,
// lifecycle-correct (damage/repair/replacement) and always finite. Reuses only
// authoritative Power-flow / Power-protection records.

const assert = require("assert");
const { snapshotRoom } = require("./src/server/snapshots");
const { createShipBlueprintSnapshot } = require("./src/server/shipDesign");
const { initializeComponentPower, reallocateShipPower, rebuildShipWiringState } = require("./src/server/componentPower");
const { updateShipPowerProtection } = require("./src/server/powerProtection");

let count = 0;
function check(name, fn) { fn(); count += 1; console.log(`  ok  ${count}. ${name}`); }
async function checkAsync(name, fn) { await fn(); count += 1; console.log(`  ok  ${count}. ${name}`); }
function finiteDeep(value, path = "v") {
  if (typeof value === "number") { assert(Number.isFinite(value), `${path} finite`); assert(!Object.is(value, -0), `${path} not -0`); }
  else if (Array.isArray(value)) value.forEach((v, i) => finiteDeep(v, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) finiteDeep(v, `${path}.${k}`);
}

function buildShip(demand = { 2: 3.5, 4: 6 }) {
  const design = [
    { x: 0, y: 0, type: "core" }, { x: 1, y: 0, type: "frame" }, { x: 2, y: 0, type: "shield" }, { x: 3, y: 0, type: "frame" }, { x: 4, y: 0, type: "blaster" },
    { x: 6, y: 0, type: "switchgear", rotation: 0, switchgearMode: "closed", switchgearRatingTier: "light" }
  ];
  const wiring = {
    version: 3,
    power: { sections: [
      { id: "a", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" },
      { id: "b", x1: 1, y1: 0, x2: 2, y2: 0, tier: "standard" },
      { id: "c", x1: 2, y1: 0, x2: 3, y2: 0, tier: "light" },
      { id: "d", x1: 3, y1: 0, x2: 4, y2: 0, tier: "light" }
    ], connections: [] },
    data: { sections: [], connections: [] },
    powerPolicy: { preset: "balanced", customOrder: ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"] }
  };
  const snap = createShipBlueprintSnapshot(design, wiring);
  const ship = {
    id: "s", ownerId: "p", designRevision: 1, x: 0, y: 0, vx: 0, vy: 0, angle: 0, targetX: 0, targetY: 0,
    hp: 100, maxHp: 100, shield: 0, maxShield: 0, radius: 10, cost: 1, weaponAngles: [], alive: true, stats: { unitCost: 1 },
    design: snap.design, wiring: snap.wiring, componentHp: snap.design.map(() => 1), componentMaxHp: snap.design.map(() => 1),
    componentHeat: snap.design.map(() => 0), componentHeatState: snap.design.map(() => 0), componentThermals: snap.design.map(() => ({ capacity: 100 })),
    dirtyComponents: new Set(), dirtyHeat: new Set(), _activityDemandByIndex: demand
  };
  initializeComponentPower(ship);
  updateShipPowerProtection(ship, 0.5);
  return ship;
}
function makeRoomClient(ship) {
  const player = { id: "p", name: "P", color: "#fff", team: "blue", ships: [ship], selectedShipIds: new Set(), stats: {}, money: 0, rallyPoint: { x: 0, y: 0 } };
  const room = { code: "R", phase: "active", adminId: "p", stateEpoch: 1, snapshotSeq: 1, staticRevision: 1, mapSizeLabel: "t", world: { width: 100, height: 100 }, map: { asteroids: [] }, rules: { gameMode: "control" }, players: new Map([["p", player]]), ships: new Map([["s", ship]]), bullets: [], points: [], effects: [], winner: null, matchStartedAt: 1, maxScore: 100, controlVictory: null };
  const client = { player, knownShipDesignRevisions: new Map(), knownShipPowerRevisions: new Map(), knownShipPowerProtectionRevisions: new Map(), knownShipWiringLayoutRevisions: new Map() };
  return { room, player, client };
}
function markWritten(client, ship) {
  client.knownShipDesignRevisions.set("s", 1);
  client.knownShipPowerRevisions.set("s", ship.powerRevision);
  client.knownShipPowerProtectionRevisions.set("s", ship.powerProtectionRevision);
  client.knownShipWiringLayoutRevisions.set("s", ship.wiringRevision);
}

// 26. Full snapshot includes complete Power-layout information.
check("full snapshot includes complete Power-wiring layout and runtime", () => {
  const ship = buildShip();
  const { room, player, client } = makeRoomClient(ship);
  const full = snapshotRoom(room, 0, player, true, null, client).ships[0];
  assert(full.powerWiring, "layout block present");
  assert.strictEqual(full.powerWiring.sections.length, 5, "4 cables + 1 switchgear edge");
  const ids = full.powerWiring.sections.map((s) => s.id).sort();
  assert(ids.includes("switchgear:5:A-B"), "switchgear synthetic edge in layout");
  for (const s of full.powerWiring.sections) {
    assert(Number.isInteger(s.x1) && Number.isInteger(s.y1) && Number.isInteger(s.x2) && Number.isInteger(s.y2), "endpoint coords present");
    assert(["light", "standard", "heavy"].includes(s.tier), "tier present");
    assert(["power-section", "switchgear"].includes(s.kind), "kind present");
    assert(Array.isArray(s.hosts), "host indices present");
    assert(typeof s.operational === "boolean", "operational flag present");
  }
  assert(full.powerWiringRuntime && Array.isArray(full.powerWiringRuntime.sections), "runtime block present");
  const runtime = full.powerWiringRuntime.sections[0];
  for (const key of ["id", "absoluteFlowMw", "sustainedCapacityMw", "peakCapacityMw", "sustainedUtilisation", "peakUtilisation", "stress", "state", "operational"]) {
    assert(key in runtime, `runtime has ${key}`);
  }
  finiteDeep(full.powerWiring); finiteDeep(full.powerWiringRuntime);
});

// 28. Flow-only changes update runtime without resending layout.
check("flow-only change resends runtime but not the unchanged layout", () => {
  const ship = buildShip();
  const { room, player, client } = makeRoomClient(ship);
  snapshotRoom(room, 0, player, true, null, client);
  markWritten(client, ship);
  const wRev = ship.wiringRevision;
  ship._activityDemandByIndex = { 2: 3.5, 4: 2 };
  reallocateShipPower(ship, "test");
  updateShipPowerProtection(ship, 0.5);
  const compact = snapshotRoom(room, 16, player, false, null, client).ships[0];
  assert.strictEqual(ship.wiringRevision, wRev, "wiring revision unchanged by a flow change");
  assert.strictEqual(compact.powerWiring, undefined, "layout NOT resent when unchanged");
  assert(compact.powerWiringRuntime, "runtime resent on flow change");
});

// 29/30/31. Wiring-revision change on damage refreshes layout; repair restores.
check("damage refreshes layout with disabled sections; repair restores them", () => {
  const ship = buildShip();
  const { room, player, client } = makeRoomClient(ship);
  snapshotRoom(room, 0, player, true, null, client);
  markWritten(client, ship);
  ship.componentHp[1] = 0; // destroy the frame hosting cables a and b
  rebuildShipWiringState(ship, "component-lifecycle");
  updateShipPowerProtection(ship, 0.1);
  const damaged = snapshotRoom(room, 32, player, false, null, client).ships[0];
  assert(damaged.powerWiring, "layout resent after damage (wiring revision changed)");
  const disabled = damaged.powerWiring.sections.filter((s) => !s.operational).map((s) => s.id);
  assert(disabled.length >= 1, "at least one section disabled by host destruction");
  const disabledInRuntime = damaged.powerWiringRuntime.sections.filter((s) => disabled.includes(s.id));
  assert.strictEqual(disabledInRuntime.length, 0, "disabled sections carry no runtime flow");
  markWritten(client, ship);
  ship.componentHp[1] = 1;
  rebuildShipWiringState(ship, "component-lifecycle");
  updateShipPowerProtection(ship, 0.1);
  const repaired = snapshotRoom(room, 48, player, false, null, client).ships[0];
  assert(repaired.powerWiring, "layout resent after repair");
  assert(repaired.powerWiring.sections.every((s) => s.operational), "all sections operational after repair — no stale disabled state");
});

// 32. Design replacement clears old layout.
check("design replacement (re-init) produces a fresh consistent layout", () => {
  const ship = buildShip();
  const { room, player, client } = makeRoomClient(ship);
  const before = snapshotRoom(room, 0, player, true, null, client).ships[0];
  assert.strictEqual(before.powerWiring.sections.length, 5);
  // Replace with a smaller design.
  const design = [{ x: 0, y: 0, type: "core" }, { x: 1, y: 0, type: "blaster" }];
  const wiring = { version: 3, power: { sections: [{ id: "z", x1: 0, y1: 0, x2: 1, y2: 0, tier: "light" }], connections: [] }, data: { sections: [], connections: [] }, powerPolicy: ship.wiring.powerPolicy };
  const snap = createShipBlueprintSnapshot(design, wiring);
  ship.design = snap.design; ship.wiring = snap.wiring; ship.componentHp = [1, 1]; ship.componentMaxHp = [1, 1];
  ship.componentHeat = [0, 0]; ship.componentHeatState = [0, 0]; ship.componentThermals = [{ capacity: 100 }, { capacity: 100 }];
  delete ship._infrastructureHostMaps;
  ship._activityDemandByIndex = { 1: 2 };
  initializeComponentPower(ship);
  updateShipPowerProtection(ship, 0.1);
  const after = snapshotRoom(room, 64, player, true, null, client).ships[0];
  assert.strictEqual(after.powerWiring.sections.length, 1, "layout reflects the replaced design");
  const only = after.powerWiring.sections[0];
  assert(only.x1 === 0 && only.y1 === 0 && only.x2 === 1 && only.y2 === 0, "the single replaced section spans (0,0)-(1,0)");
  assert.strictEqual(only.tier, "light");
});

// 33. All output values finite and sanitised, incl. an overloaded ship.
check("overloaded ship layout/runtime remain finite and sanitised", () => {
  // Reactor (10 MW) feeds a shield through a Light cable (sustained 4 / peak 7);
  // 7 MW demand drives the Light section above sustained.
  const design = [{ x: 0, y: 0, type: "reactor" }, { x: 2, y: 0, type: "frame" }, { x: 3, y: 0, type: "shield" }];
  const wiring = { version: 3, power: { sections: [
    { id: "l1", x1: 1, y1: 0, x2: 2, y2: 0, tier: "light" },
    { id: "l2", x1: 2, y1: 0, x2: 3, y2: 0, tier: "light" }
  ], connections: [] }, data: { sections: [], connections: [] }, powerPolicy: { preset: "balanced", customOrder: ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  const ship = {
    id: "s", ownerId: "p", designRevision: 1, x: 0, y: 0, vx: 0, vy: 0, angle: 0, targetX: 0, targetY: 0,
    hp: 100, maxHp: 100, shield: 0, maxShield: 0, radius: 10, cost: 1, weaponAngles: [], alive: true, stats: { unitCost: 1 },
    design: snap.design, wiring: snap.wiring, componentHp: snap.design.map(() => 1), componentMaxHp: snap.design.map(() => 1),
    componentHeat: snap.design.map(() => 0), componentHeatState: snap.design.map(() => 0), componentThermals: snap.design.map(() => ({ capacity: 100 })),
    dirtyComponents: new Set(), dirtyHeat: new Set(), _activityDemandByIndex: { 2: 7 }
  };
  initializeComponentPower(ship);
  for (let i = 0; i < 40; i += 1) updateShipPowerProtection(ship, 0.1);
  const { room, player, client } = makeRoomClient(ship);
  const full = snapshotRoom(room, 0, player, true, null, client).ships[0];
  finiteDeep(full.powerWiring);
  finiteDeep(full.powerWiringRuntime);
  const stressed = full.powerWiringRuntime.sections.filter((s) => s.stress > 0);
  assert(stressed.length >= 1, "overloaded sections accumulate stress in the runtime block");
});

// 35. No Power/Heat/overload formula is duplicated in the snapshot builder.
check("power-wiring snapshot builder duplicates no gameplay formula", () => {
  const fs = require("fs");
  const src = fs.readFileSync("src/server/powerWiringSnapshot.js", "utf8");
  assert(!/Math\.pow\(/.test(src), "no Heat/overload power curve");
  assert(!/baseStressPerSecond|additionalStressPerSecondAtPeak/.test(src), "no overload stress formula");
  assert(!/maxflow|augmenting|residual/i.test(src), "no allocation solver");
});

(async () => {
  // Client-merge preservation needs the ESM snapshot-merge module.
  await checkAsync("client merge preserves omitted Power layout and runtime", async () => {
    const { mergeCachedShipFields } = await import("./public/src/snapshotMerge.js");
    const ship = buildShip();
    const { room, player, client } = makeRoomClient(ship);
    const full = snapshotRoom(room, 0, player, true, null, client).ships[0];
    markWritten(client, ship);
    ship.x = 5; // unrelated change; no power/wiring revision bump
    const compact = snapshotRoom(room, 16, player, false, null, client).ships[0];
    const merged = mergeCachedShipFields([full], [compact])[0];
    assert.strictEqual(merged.powerWiring.sections.length, full.powerWiring.sections.length, "layout preserved when omitted");
    assert(merged.powerWiringRuntime, "runtime preserved when omitted");
  });
  console.log(`\nCombat Power-overlay snapshot verification passed (${count} checks).`);
})().catch((error) => { console.error(error); process.exit(1); });
