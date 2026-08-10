"use strict";

// Repair preview, server stats, and live support must share one diminishing-
// returns stack. Power, Heat, destruction, target need, and command auras then
// scale the work that the runtime can actually deliver.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const EngineExhaustRules = require("../public/src/shared/engineExhaust.js");
const HeatRules = require("../public/src/shared/heatRules.js");
const RepairRules = require("../public/src/shared/repairRules.js");
const { PARTS } = require("../src/server/components");
const { BALANCE } = require("../src/server/balanceConfig");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState, recalcEffectiveStats } = require("../src/server/componentHealth");
const { markShipRepairCacheDirty } = require("../src/server/repairCache");
const { initShipHeat } = require("../src/server/heat");
const { updateShipSupport } = require("../src/server/combat");
const { updateCommandAuras, getCommandAuraMultiplier } = require("../src/server/commandAuras");

globalThis.EngineExhaustRules = EngineExhaustRules;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    getContext: () => null
  })
};
globalThis.window = { devicePixelRatio: 1 };

function close(actual, expected, message, tolerance = 1e-9) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function designFor(types) {
  return types.map((type, index) => ({
    x: 7 + index,
    y: 7,
    type,
    rotation: 0
  }));
}

function makeShip(id, types, x = 0, ownerId = "p1") {
  const design = designFor(types);
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId,
    x,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 30,
    physicalRadius: 30,
    alive: true,
    removed: false,
    design,
    stats,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: 0,
    maxShield: 0,
    repairTargetId: null,
    commandAurasReceived: {},
    commandAuraMultipliers: {},
    effects: []
  };
  initComponentState(ship);
  initShipHeat(ship);
  ship.componentPower = {
    byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" }))
  };
  return ship;
}

function roomFor(ships) {
  const players = new Map();
  for (const ship of ships) {
    if (!players.has(ship.ownerId)) {
      players.set(ship.ownerId, { id: ship.ownerId, team: "blue", ships: [] });
    }
    players.get(ship.ownerId).ships.push(ship);
  }
  return {
    phase: "active",
    rules: { gameMode: "teams" },
    players,
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    effects: [],
    bullets: [],
    map: { asteroids: [], safeZones: [], relays: [] },
    world: { width: 2000, height: 2000 }
  };
}

function damageComponent(ship, index, amount) {
  const damage = Math.min(Math.max(0, Number(amount) || 0), ship.componentHp[index]);
  ship.componentHp[index] -= damage;
  ship.hp = Math.max(0, ship.hp - damage);
  markShipRepairCacheDirty(ship);
  return damage;
}

function repairIndexes(ship) {
  return ship.design
    .map((module, index) => (PARTS[module.type]?.repairRate > 0 ? index : -1))
    .filter((index) => index >= 0);
}

function deliverLocalRepair(types, configure = () => {}) {
  const ship = makeShip(`local-${types.join("-")}`, ["core", "frame", ...types]);
  damageComponent(ship, 1, 40);
  const indexes = repairIndexes(ship);
  configure(ship, indexes);
  const beforeHp = ship.hp;
  const beforeHeat = indexes.map((index) => ship.componentHeatInput[index]);
  const room = roomFor([ship]);
  updateShipSupport(room, [ship], 1, 1000);
  return {
    ship,
    indexes,
    delivered: ship.hp - beforeHp,
    heatAdded: indexes.map((index, offset) => ship.componentHeatInput[index] - beforeHeat[offset])
  };
}

function setPower(ship, indexes, multiplier) {
  for (const index of indexes) {
    ship.componentPower.byComponentIndex[index] = {
      operationalMultiplier: multiplier,
      state: multiplier > 0 && multiplier < 1 ? "underpowered" : multiplier > 0 ? "powered" : "offline"
    };
  }
}

async function run() {
  const { computeStats: clientComputeStats } = await import("../public/src/design/componentStats.js");

  assert.strictEqual(PARTS.repair.repairRate, 8, "Repair catalogue rate remains 8 HP/s");
  assert.strictEqual(PARTS.overclockedRepair.repairRate, 24, "Overclocked Repair catalogue rate remains 24 HP/s");
  assert.strictEqual(PARTS.repairBeam.repairRate, 16, "Repair Beam catalogue rate remains 16 HP/s");
  close(RepairRules.sumRepairRates([8, 8, 8]), 24, "shared Repair installed total");
  close(RepairRules.getRepairStackingMultiplier(BALANCE), 0.8, "Repair stack multiplier remains authoritative");
  close(RepairRules.getEffectiveRepairRate([8, 8], BALANCE), 14.4, "shared Repair effective rate for two equal sources");
  close(RepairRules.getEffectiveRepairRate([8, 8, 8], BALANCE), 19.52, "shared Repair effective rate for three equal sources");

  const statCases = [
    ["single Repair", ["core", "frame", "repair"], 8],
    ["two Repairs", ["core", "frame", "repair", "repair"], 14.4],
    ["three Repairs", ["core", "frame", "repair", "repair", "repair"], 19.52],
    ["Repair plus Overclocked Repair", ["core", "frame", "repair", "overclockedRepair"], 30.4],
    ["Repair Beam", ["core", "frame", "repairBeam"], 16]
  ];
  for (const [label, types, expected] of statCases) {
    const design = designFor(types);
    const server = computeStats(design);
    const client = clientComputeStats(design);
    close(server.repairRate, expected, `${label} server effective rate`);
    close(client.repairRate, expected, `${label} designer effective rate`);
    close(client.repairRate, server.repairRate, `${label} designer/server parity`);
  }

  const one = deliverLocalRepair(["repair"]);
  close(one.delivered, 8, "one Repair runtime output");
  close(one.ship.stats.repairRate, 8, "one Repair runtime stats");
  close(one.heatAdded[0], one.delivered * PARTS.repair.activityHeat / PARTS.repair.repairRate, "Repair Heat follows delivered work");

  const two = deliverLocalRepair(["repair", "repair"]);
  close(two.delivered, 14.4, "two Repairs runtime output");
  close(two.ship.stats.repairRate, 14.4, "two Repairs runtime stats");

  const mixed = deliverLocalRepair(["repair", "overclockedRepair"]);
  close(mixed.delivered, 30.4, "mixed Repair runtime output");
  close(mixed.ship.stats.repairRate, 30.4, "mixed Repair runtime stats");

  const underpowered = deliverLocalRepair(["repair"], (ship, indexes) => setPower(ship, indexes, 0.5));
  close(underpowered.delivered, 4, "underpowered Repair scales nominal output");

  const thermallyReduced = deliverLocalRepair(["repair"], (ship, indexes) => {
    ship.componentHeatState[indexes[0]] = HeatRules.STATE.HOT;
  });
  close(thermallyReduced.delivered, 8 * HeatRules.activeOutputForState(HeatRules.STATE.HOT), "thermally reduced Repair scales output");

  const destroyed = makeShip("destroyed-repair", ["core", "frame", "repair", "repair"]);
  damageComponent(destroyed, 1, 40);
  const destroyedIndex = 2;
  destroyed.hp -= destroyed.componentHp[destroyedIndex];
  destroyed.componentHp[destroyedIndex] = 0;
  markShipRepairCacheDirty(destroyed);
  recalcEffectiveStats(destroyed);
  close(destroyed.stats.repairRate, 8, "destroyed Repair is removed from live stats");
  const destroyedBefore = destroyed.hp;
  updateShipSupport(roomFor([destroyed]), [destroyed], 1, 1000);
  close(destroyed.hp - destroyedBefore, 8, "destroyed Repair contributes no runtime output");

  const beam = makeShip("repair-beam", ["core", "frame", "repairBeam"], 0);
  const beamTarget = makeShip("beam-target", ["core", "frame"], 50, "p1");
  damageComponent(beamTarget, 1, 40);
  const beamBeforeSource = beam.hp;
  const beamBeforeTarget = beamTarget.hp;
  const beamRoom = roomFor([beam, beamTarget]);
  updateShipSupport(beamRoom, [beam, beamTarget], 1, 1000);
  close(beamTarget.hp - beamBeforeTarget, 16, "Repair Beam projected runtime output");
  close(beam.hp - beamBeforeSource, 0, "Repair Beam does not self-repair");
  assert(beamRoom.effects.some((effect) => effect.type === "repairbeam"), "Repair Beam keeps its projected role");

  const engineer = makeShip("engineer", ["core", "engineeringCommandCentre"], 0);
  const auraRepair = makeShip("aura-repair", ["core", "frame", "repair"], 50, "p1");
  damageComponent(auraRepair, 1, 40);
  const auraRoom = roomFor([engineer, auraRepair]);
  updateCommandAuras(auraRoom, [engineer, auraRepair], 0);
  const auraMultiplier = getCommandAuraMultiplier(auraRepair, "repairRateMultiplier");
  close(auraMultiplier, PARTS.engineeringCommandCentre.aura.repairRateMultiplier, "Engineering repair aura value");
  const auraBefore = auraRepair.hp;
  updateShipSupport(auraRoom, [engineer, auraRepair], 1, 1000);
  close(auraRepair.hp - auraBefore, 8 * auraMultiplier, "Engineering repair aura applies exactly once");

  const sourcePaths = [
    "public/src/design/componentStats.js",
    "public/src/ui/designerUi.js",
    "public/src/ledger/ledgerContent.js",
    "public/src/ledger/componentMechanics.js"
  ];
  for (const relative of sourcePaths) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert(!source.includes("Linear Sum (each active Repair source contributes its full nominal rate)"), `${relative} does not describe additive Repair stacking`);
    assert(source.includes("repairRules") || relative === "public/src/ui/designerUi.js", `${relative} reads the shared Repair rule`);
  }
  const balance = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "component-balance.json"), "utf8"));
  close(balance.repair.stackingMultiplier, 0.8, "balance keeps the authoritative Repair stackingMultiplier");

  console.log("Repair parity verification passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
