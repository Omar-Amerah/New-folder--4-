"use strict";
const assert = require("assert");
function close(actual, expected, label) { assert(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`); }
const { snapshotRoom } = require("./src/server/snapshots");

(async () => {
  const { mergeCachedShipFields } = await import("./public/src/snapshotMerge.js");
  const design = [{ type: "core" }, { type: "engine" }];
  const ship = {
    id: "s", ownerId: "p", designRevision: 1, x: 0, y: 0, vx: 0, vy: 0, angle: 0, targetX: 0, targetY: 0,
    hp: 100, maxHp: 100, shield: 0, maxShield: 0, radius: 10, cost: 1, weaponAngles: [], alive: true,
    stats: { unitCost: 1 }, design, componentHp: [100, 80], componentHeat: [5, 10], componentHeatState: [0, 1],
    componentThermals: [{ capacity: 100 }, { capacity: 50 }], dirtyComponents: new Set(), dirtyHeat: new Set([0, 1]),
    componentPower: { byComponentIndex: [
      { state: "source", networkId: 0, operationalMultiplier: 1, requestedMw: 0, allocatedMw: 0 },
      { state: "powered", networkId: 0, operationalMultiplier: 1, requestedMw: 3, allocatedMw: 3 }
    ] },
    powerStatus: { ok: true }, powerRevision: 7, wiringRevision: 2,
    powerFlow: { summary: { availableGenerationMw: 8, demandMw: 3, allocatedMw: 3, spareGenerationMw: 5, unmetMw: 0, aboveSustainedSections: 0, atPeakSections: 0, preset: "balanced" } },
    powerCableThermalAnalysis: { summary: { hottestSectionId: "0,0:1,0" }, components: [{ componentIndex: 1, hostedActiveSectionIds: ["0,0:1,0"] }] },
    componentHeatGenerated: [0.2, 0.4], componentPowerCableHeatRate: [0, 0.1], componentPowerCableHeatGenerated: [0, 0.05],
    componentHeatCooled: [0.1, 0.2], componentHeatRadiated: [0, 0.1], powerCableHeatRate: 0.1
  };
  const player = { id: "p", name: "P", color: "#fff", team: "blue", ships: [ship], selectedShipIds: new Set(), stats: {}, money: 0, rallyPoint: { x: 0, y: 0 } };
  const room = { code: "R", phase: "active", adminId: "p", stateEpoch: 1, snapshotSeq: 1, staticRevision: 1, mapSizeLabel: "tiny", world: { width: 100, height: 100 }, map: { asteroids: [] }, rules: { gameMode: "control" }, players: new Map([["p", player]]), ships: new Map([["s", ship]]), bullets: [], points: [], effects: [], winner: null, matchStartedAt: 1, maxScore: 100, controlVictory: null };
  const client = { player, knownShipPowerRevisions: new Map() };

  const full = snapshotRoom(room, 0, player, true, null, client);
  const fullShip = full.ships[0];
  assert(fullShip.powerThermal, "initial full snapshot includes powerThermal");
  close(fullShip.powerThermal.componentHeatRate, 0.6, "initial component Heat rate");

  client.knownShipDesignRevisions = new Map([["s", 1]]);
  client.knownShipPowerRevisions.set("s", ship.powerRevision);
  ship.componentHeat[1] = 25;
  ship.componentHeatGenerated = [1, 2];
  ship.componentPowerCableHeatGenerated = [0, 0.2];
  ship.componentHeatCooled = [0.5, 0.25];
  ship.componentHeatRadiated = [0, 0.25];
  ship.dirtyHeat = new Set([1]);
  ship.dirtyPower = false;
  const beforePowerRevision = ship.powerRevision;
  const heatOnly = snapshotRoom(room, 16, player, false, null, client).ships[0];
  assert(!heatOnly.componentPower, "Heat-only compact update does not resend componentPower");
  assert(heatOnly.componentHeatD, "Heat-only compact update includes component heat delta");
  assert(heatOnly.powerThermal, "Heat-only compact update includes refreshed powerThermal");
  assert.equal(heatOnly.powerThermal.componentHeatRate, 3);
  close(heatOnly.powerThermal.netHeatRate, 2.2, "Heat-only net Heat rate");
  assert.equal(ship.powerRevision, beforePowerRevision, "no Power reallocation/revision was required");

  const merged = mergeCachedShipFields([fullShip], [heatOnly])[0];
  assert.equal(merged.powerThermal.componentHeatRate, 3, "client merge receives newest powerThermal");
  close(merged.powerThermal.netHeatRate, 2.2, "client merge receives refreshed net Heat");

  ship.dirtyHeat = new Set();
  ship.x = 9;
  const unrelated = snapshotRoom(room, 32, player, false, null, client).ships[0];
  assert.equal(unrelated.powerThermal, undefined, "unrelated compact update may omit powerThermal");
  const retained = mergeCachedShipFields([merged], [unrelated])[0];
  assert.equal(retained.powerThermal.componentHeatRate, 3, "omitted powerThermal retains cached value");
  console.log("Runtime Power-thermal snapshot freshness verification passed.");
})().catch((error) => { console.error(error); process.exit(1); });
