"use strict";

const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const EngineExhaustRules = require("../public/src/shared/engineExhaust");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const componentHealth = require("../src/server/componentHealth");
const componentPower = require("../src/server/componentPower");
const heat = require("../src/server/heat");
const combat = require("../src/server/combat");
const { applyEngineHeat, applyTurnHeat } = require("../src/server/movementCapability");
const { updateRuntimeShield } = require("../src/server/runtimeShield");
const { markShipRepairCacheDirty } = require("../src/server/repairCache");

globalThis.HeatRules = HeatRules;
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

const POSITIONS = [
  [1, 1], [7, 7], [7, 1], [1, 7], [12, 7], [12, 1]
];

function close(actual, expected, message, tolerance = 1e-8) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function designFor(types) {
  return types.map((type, index) => ({
    type,
    x: POSITIONS[index][0],
    y: POSITIONS[index][1],
    rotation: type === "maneuverThruster" ? 90 : 0
  }));
}

function makeShip(id, design, ownerId = "a") {
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId,
    design,
    x: ownerId === "a" ? 300 : 520,
    y: 300,
    angle: 0,
    vx: 0,
    vy: 0,
    radius: 30,
    physicalRadius: 30,
    alive: true,
    removed: false,
    stats,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: stats.maxShield || 0,
    maxShield: stats.maxShield || 0,
    repairTargetId: null,
    commandAurasReceived: {},
    commandAuraMultipliers: {},
    effects: []
  };
  componentHealth.initComponentState(ship);
  heat.initShipHeat(ship);
  ship.componentPower = {
    byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" }))
  };
  ship.weaponCooldowns = design.map(() => 0);
  ship.weaponAngles = design.map(() => 0);
  ship.weaponDesiredAngles = design.map(() => 0);
  ship.weaponAimTargetIds = design.map(() => null);
  ship.weaponFireTargetIds = design.map(() => null);
  ship.beamEffectsAt = design.map(() => 0);
  return ship;
}

function roomFor(ships) {
  const players = new Map();
  for (const ship of ships) {
    if (!players.has(ship.ownerId)) {
      players.set(ship.ownerId, { id: ship.ownerId, team: ship.ownerId, ships: [] });
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
    missiles: [],
    drones: new Map(),
    map: { asteroids: [], safeZones: [], relays: [] },
    world: { width: 2000, height: 2000 },
    rngState: 1
  };
}

function setStateAndPower(ship, index, state, power = 1) {
  ship.componentHeatState[index] = state;
  ship.componentPower.byComponentIndex[index] = {
    operationalMultiplier: power,
    state: power <= 0 ? "unpowered" : power < 1 ? "underpowered" : "powered"
  };
}

function damageComponent(ship, index, amount) {
  const damage = Math.min(Math.max(0, Number(amount) || 0), ship.componentHp[index]);
  ship.componentHp[index] -= damage;
  ship.hp = Math.max(0, ship.hp - damage);
  markShipRepairCacheDirty(ship);
}

async function run() {
  const { buildThermalModel, buildThermalLoad, simulateThermalLoad } = await import("../public/src/design/thermalAnalysis.js");

  function designerTick(design, states, index) {
    const model = buildThermalModel(design);
    const load = buildThermalLoad(model, "full", { initialHeatStates: states });
    const simulation = simulateThermalLoad(model, load, { maxSteps: 1 });
    return {
      rate: simulation.generatedHeat[index] / simulation.dt,
      load,
      simulation
    };
  }

  function statesFor(design, index, state) {
    return design.map((_, componentIndex) => componentIndex === index ? state : HeatRules.STATE.NORMAL);
  }

  function runtimeMovementRate(type, state) {
    const design = designFor(["reactor", type]);
    const ship = makeShip(`movement-${type}-${state}`, design);
    setStateAndPower(ship, 1, state);
    if (type === "engine") {
      ship.validEngineIndices = new Set([1]);
      applyEngineHeat(ship, 1, 1);
    } else {
      applyTurnHeat(ship, 1, 1);
      if (ship.componentHeatInput[1] === 0) applyTurnHeat(ship, -1, 1);
    }
    return ship.componentHeatInput[1];
  }

  for (const state of [HeatRules.STATE.NORMAL, HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL]) {
    const design = designFor(["reactor", "engine"]);
    close(
      designerTick(design, statesFor(design, 1, state), 1).rate,
      runtimeMovementRate("engine", state),
      `Designer Engine Heat matches runtime in state ${state}`
    );
  }

  for (const type of ["maneuverThruster", "gyroscope"]) {
    const design = designFor(["reactor", type]);
    close(
      designerTick(design, statesFor(design, 1, HeatRules.STATE.HOT), 1).rate,
      runtimeMovementRate(type, HeatRules.STATE.HOT),
      `Designer ${type} turning Heat matches delivered runtime work`
    );
  }

  function runtimeRepairRate(type, state) {
    const sourceDesign = designFor(["reactor", "frame", type]);
    const source = makeShip(`repair-${type}-${state}`, sourceDesign);
    setStateAndPower(source, 2, state);
    let ships = [source];
    if (type === "repairBeam") {
      const target = makeShip(`repair-target-${state}`, designFor(["frame"]), "a");
      target.x = source.x + 100;
      damageComponent(target, 0, 40);
      ships = [source, target];
    } else {
      damageComponent(source, 1, 40);
    }
    combat.updateShipSupport(roomFor(ships), ships, 1, 1000);
    return source.componentHeatInput[2];
  }

  for (const type of ["repair", "repairBeam"]) {
    const design = designFor(["reactor", "frame", type]);
    close(
      designerTick(design, statesFor(design, 2, HeatRules.STATE.HOT), 2).rate,
      runtimeRepairRate(type, HeatRules.STATE.HOT),
      `Designer ${type} Heat matches actual repair delivered`
    );
  }

  function runtimeShieldRate(state, power = 1) {
    const design = designFor(["reactor", "shield"]);
    const ship = makeShip(`shield-${state}-${power}`, design);
    setStateAndPower(ship, 1, state, power);
    ship.shield = Math.max(1, ship.maxShield - 100);
    updateRuntimeShield(ship, 1, 1000, roomFor([ship]));
    return ship.componentHeatInput[1];
  }

  {
    const design = designFor(["reactor", "shield"]);
    close(
      designerTick(design, statesFor(design, 1, HeatRules.STATE.HOT), 1).rate,
      runtimeShieldRate(HeatRules.STATE.HOT),
      "Designer Shield Heat matches actual shield points restored"
    );
  }

  function runtimeBeamRate(state, power = 1) {
    const source = makeShip(`beam-${state}-${power}`, designFor(["reactor", "beamEmitter"]));
    const target = makeShip(`beam-target-${state}-${power}`, designFor(["frame"]), "b");
    setStateAndPower(source, 1, state, power);
    combat.updateShipWeapons(roomFor([source, target]), source, [source, target], 1, 1000);
    return source.componentHeatInput[1];
  }

  {
    const design = designFor(["reactor", "beamEmitter"]);
    close(
      designerTick(design, statesFor(design, 1, HeatRules.STATE.HOT), 1).rate,
      runtimeBeamRate(HeatRules.STATE.HOT),
      "Designer Beam Heat matches actual firing activity"
    );
  }

  {
    const design = designFor(["reactor", "blaster"]);
    const state = HeatRules.STATE.CRITICAL;
    const performance = HeatRules.activeOutputForState(state);
    const runtimeCadenceHeat = PARTS.blaster.heatPerShot
      / combat.weaponReloadSeconds(PARTS.blaster.weapon, performance);
    close(
      designerTick(design, statesFor(design, 1, state), 1).rate,
      runtimeCadenceHeat,
      "Designer discrete weapon Heat matches actual runtime shot cadence"
    );
  }

  const loadedReactorDesign = designFor(["reactor", "shield", "shield", "shield", "shield"]);
  for (const state of [HeatRules.STATE.NORMAL, HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL]) {
    const ship = makeShip(`reactor-${state}`, loadedReactorDesign);
    ship.componentHeatState[0] = state;
    componentPower.reallocateShipPower(ship, "designer-parity", { skipDataRefresh: true });
    heat.updateShipHeat(ship, HeatRules.TICK_SECONDS);
    const runtimeRate = ship.componentHeatGenerated[0] / HeatRules.TICK_SECONDS;
    close(
      designerTick(loadedReactorDesign, statesFor(loadedReactorDesign, 0, state), 0).rate,
      runtimeRate,
      `Designer Reactor Heat matches current generation used in state ${state}`
    );
  }

  for (const state of [HeatRules.STATE.NORMAL, HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL, HeatRules.STATE.OVERHEATED]) {
    const design = designFor(["reactor", "droneBay"]);
    const expected = state === HeatRules.STATE.OVERHEATED ? 0 : PARTS.droneBay.activityHeat;
    close(
      designerTick(design, statesFor(design, 1, state), 1).rate,
      expected,
      `Designer Drone Bay keeps its discrete active rule in state ${state}`
    );
  }

  function runtimeReallocatedShield(state) {
    const ship = makeShip(`reallocation-${state}`, loadedReactorDesign);
    ship.componentHeatState[0] = state;
    componentPower.reallocateShipPower(ship, "designer-parity", { skipDataRefresh: true });
    const multiplier = ship.componentPower.byComponentIndex[1].operationalMultiplier;
    ship.shield = Math.max(1, ship.maxShield - 100);
    updateRuntimeShield(ship, 1, 1000, roomFor([ship]));
    return { multiplier, rate: ship.componentHeatInput[1] };
  }

  const normalRuntime = runtimeReallocatedShield(HeatRules.STATE.NORMAL);
  const hotRuntime = runtimeReallocatedShield(HeatRules.STATE.HOT);
  const hotDesigner = designerTick(
    loadedReactorDesign,
    statesFor(loadedReactorDesign, 0, HeatRules.STATE.HOT),
    1
  );
  close(hotDesigner.simulation.initialPowerMultiplier[1], hotRuntime.multiplier,
    "Designer immediately reallocates downstream Power from a Hot Reactor");
  close(hotDesigner.rate, hotRuntime.rate,
    "Designer downstream Shield Heat uses the Hot Reactor allocation without Data Support sources");
  assert(hotRuntime.multiplier < normalRuntime.multiplier,
    "Hot Reactor reduces downstream runtime Power");
  assert(hotDesigner.simulation.powerReallocationCount > 0,
    "Designer recorded the initial thermal Power reallocation");

  {
    const model = buildThermalModel(loadedReactorDesign);
    const initialHeatRatios = loadedReactorDesign.map((_, index) => index === 0 ? 0.679 : 0);
    const load = buildThermalLoad(model, "full", { initialHeatRatios });
    const simulation = simulateThermalLoad(model, load, { maxSteps: 20 });
    assert(simulation.states[0] >= HeatRules.STATE.HOT,
      "Reactor crossed into Hot during the Designer simulation");
    assert(simulation.minimumPowerMultiplier[1] < simulation.initialPowerMultiplier[1],
      "mid-simulation Reactor throttling reallocated downstream Power without a Data Support signature");
    close(
      simulation.finalGeneratedRate[1],
      PARTS.shield.activityHeat
        * simulation.finalPowerMultiplier[1]
        * HeatRules.activeOutputForState(simulation.states[1]),
      "downstream Shield Heat followed the mid-simulation Reactor reallocation"
    );
  }

  const underpoweredDesign = designFor(["reactor", "shield", "shield", "shield", "shield"]);
  const underpoweredRuntime = runtimeReallocatedShield(HeatRules.STATE.NORMAL);
  const underpoweredDesigner = designerTick(
    underpoweredDesign,
    statesFor(underpoweredDesign, 1, HeatRules.STATE.HOT),
    1
  );
  close(
    underpoweredDesigner.rate,
    PARTS.shield.activityHeat
      * underpoweredRuntime.multiplier
      * HeatRules.activeOutputForState(HeatRules.STATE.HOT),
    "Designer underpowered component Heat follows Power and thermal work"
  );

  console.log("Designer/runtime Heat generation parity verification passed");
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
