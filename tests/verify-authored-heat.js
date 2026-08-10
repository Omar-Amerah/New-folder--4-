"use strict";

const assert = require("assert");
const generatedBalance = require("../public/component-balance.generated.json");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { validateComponentBalance } = require("../src/server/componentSchema");
const { loadBalance } = require("../src/server/balanceConfig");
const heat = require("../src/server/heat");
const health = require("../src/server/componentHealth");
const combat = require("../src/server/combat");
const { applyEngineHeat } = require("../src/server/movementCapability");
const { updateRuntimeShield } = require("../src/server/runtimeShield");
const { computeStats } = require("../src/server/shipStats");

function close(actual, expected, message, tolerance = 1e-9) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function designFor(types) {
  return types.map((type, index) => ({ type, x: 7 + index, y: 7, rotation: 0 }));
}

function makeShip(id, types, ownerId = "a") {
  const design = designFor(types);
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId,
    design,
    x: 500,
    y: 500,
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
    maxShield: stats.maxShield || 0
  };
  health.initComponentState(ship);
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
  return {
    phase: "active",
    rules: { gameMode: "teams" },
    players: new Map([
      ["a", { id: "a", team: "a", ships: ships.filter((ship) => ship.ownerId === "a") }],
      ["b", { id: "b", team: "b", ships: ships.filter((ship) => ship.ownerId === "b") }]
    ]),
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    effects: [],
    bullets: [],
    missiles: [],
    map: { asteroids: [], safeZones: [], relays: [] },
    world: { width: 2000, height: 2000 },
    rngState: 1
  };
}

function authoredCatalogueChecks() {
  const balance = loadBalance("component-balance.json");
  const validation = validateComponentBalance(balance);
  assert(validation.ok, validation.errors.join("\n"));

  const expectedActivity = {
    core: 3.7,
    auxGenerator: 4.1,
    reactor: 6.8,
    nuclearReactor: 18.8,
    engine: 6.1,
    compactEngine: 3.7,
    heavyEngine: 16.8,
    gyroscope: 3.1,
    maneuverThruster: 4.9,
    aegisProjector: 17.5,
    shield: 2.1,
    repair: 4.3,
    overclockedRepair: 9.9,
    droneBay: 1.2,
    repairBeam: 7.1,
    beamEmitter: 5,
    thermalInductionLance: 3,
    spinalAccelerator: 14
  };
  const expectedShot = {
    autocannon: 5,
    blaster: 5.2,
    missile: 10.7,
    railgun: 19.7,
    plasmaCannon: 8.7,
    fragmentationCannon: 6.4,
    scatterCannon: 5,
    swarmMissile: 5.3,
    torpedo: 15,
    pointDefense: 4,
    flakCannon: 4,
    interceptorPod: 4,
    spinalAccelerator: 180
  };

  for (const [type, value] of Object.entries(expectedActivity)) {
    assert.strictEqual(PARTS[type].activityHeat, value, `${type} server activityHeat is authored`);
    assert.strictEqual(HeatRules.activityHeat(type, { ...PARTS[type], powerGeneration: 999, thrust: 999, turn: 999, repairRate: 999 }), value,
      `${type} activityHeat ignores unrelated stats`);
    assert.strictEqual(generatedBalance.components.find((component) => component.id === type)?.activityHeat, value,
      `${type} generated balance carries activityHeat`);
  }
  for (const [type, value] of Object.entries(expectedShot)) {
    assert.strictEqual(PARTS[type].heatPerShot, value, `${type} server heatPerShot is authored`);
    assert.strictEqual(HeatRules.heatPerShot(type, { ...PARTS[type], heatPerShot: value, weapon: { ...PARTS[type].weapon, damage: 99999, fireRate: 99999 } }), value,
      `${type} heatPerShot ignores damage and fireRate`);
  }

  const spinalCharge = PARTS.spinalAccelerator.weapon.spinalCharge;
  assert.strictEqual(spinalCharge.chargeHeatPerSecond, undefined, "Spinal no longer stores chargeHeatPerSecond");
  assert.strictEqual(spinalCharge.fireHeat, undefined, "Spinal no longer stores fireHeat");
  assert.strictEqual(PARTS.thermalInductionLance.weapon.inductionSelfHeatMaxMultiplier, undefined,
    "Induction no longer stores a special self-Heat multiplier");
}

function generatorHeatChecks() {
  function generatedAt(generationUsedMw, damageFraction = 0) {
    const ship = makeShip(`generator-${generationUsedMw}`, ["core", "reactor"]);
    if (damageFraction > 0) ship.componentHp[1] = ship.componentMaxHp[1] * (1 - damageFraction);
    ship.powerAnalysis = {
      byComponentIndex: [
        { generationUsedMw: 0 },
        { generationUsedMw }
      ]
    };
    heat.updateShipHeat(ship, 0.2);
    return ship.componentHeatGenerated[1];
  }
  close(generatedAt(0), 0, "zero allocated generator output produces no Heat");
  close(generatedAt(5.75), PARTS.reactor.activityHeat * 0.5 * 0.2, "half allocated generator output scales authored Heat");
  close(generatedAt(11.5), PARTS.reactor.activityHeat * 0.2, "full allocated generator output uses authored Heat");
  close(generatedAt(5.75, 0.5), PARTS.reactor.activityHeat * 0.5 * 0.2, "damage does not add hidden generator Heat");
}

function movementHeatChecks() {
  function engineHeat(power, activity = 1) {
    const ship = makeShip(`engine-${power}-${activity}`, ["core", "engine"]);
    ship.componentPower.byComponentIndex[1].operationalMultiplier = power;
    ship.validEngineIndices = new Set([1]);
    applyEngineHeat(ship, activity, 1);
    return ship.componentHeatInput[1];
  }
  close(engineHeat(1, 1), PARTS.engine.activityHeat, "full engine activity uses authored Heat");
  close(engineHeat(0.5, 1), PARTS.engine.activityHeat * 0.5, "underpowered engine Heat follows actual output");
  close(engineHeat(1, 0.5), PARTS.engine.activityHeat * 0.5, "partial engine activity scales authored Heat");
}

function weaponHeatChecks() {
  const target = makeShip("weapon-target", ["core", "frame"], "b");
  target.x = 700;

  const blaster = makeShip("blaster-shooter", ["core", "blaster"]);
  combat.updateShipWeapons(roomFor([blaster, target]), blaster, [blaster, target], 1, 1000);
  close(blaster.componentHeatInput[1], PARTS.blaster.heatPerShot, "one projectile firing event adds one authored heatPerShot");

  const scatter = makeShip("scatter-shooter", ["core", "scatterCannon"]);
  combat.updateShipWeapons(roomFor([scatter, target]), scatter, [scatter, target], 1, 1000);
  close(scatter.componentHeatInput[1], PARTS.scatterCannon.heatPerShot, "multi-pellet trigger adds one heatPerShot, not one per pellet");

  const beam = makeShip("beam-shooter", ["core", "beamEmitter"]);
  combat.updateShipWeapons(roomFor([beam, target]), beam, [beam, target], 1, 1000);
  close(beam.componentHeatInput[1], PARTS.beamEmitter.activityHeat, "continuous beam activity adds authored activityHeat while firing");

  const idleBeam = makeShip("idle-beam", ["core", "beamEmitter"]);
  combat.updateShipWeapons(roomFor([idleBeam]), idleBeam, [idleBeam], 1, 1000);
  close(idleBeam.componentHeatInput[1], 0, "continuous beam adds no Heat while not firing");

  const spinal = makeShip("spinal-shooter", ["core", "spinalAccelerator"]);
  for (let tick = 0; tick < 8; tick += 1) {
    combat.updateShipWeapons(roomFor([spinal, target]), spinal, [spinal, target], 1, 1000 + tick * 1000);
  }
  close(spinal.componentHeatInput[1], PARTS.spinalAccelerator.activityHeat * 8 + PARTS.spinalAccelerator.heatPerShot,
    "Spinal charging uses activityHeat and firing adds one heatPerShot");
}

function shieldHeatChecks() {
  const ship = makeShip("shield-ship", ["core", "shield"]);
  ship.shield = ship.maxShield - 0.3;
  updateRuntimeShield(ship, 0.1, 10000, roomFor([ship]));
  const restored = 0.3;
  close(ship.componentHeatInput[1], restored * PARTS.shield.activityHeat / PARTS.shield.shieldRegen,
    "shield Heat follows actual restored shield amount");
}

async function clientParityChecks() {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.HeatRules = HeatRules;
  const { PART_STATS } = await import("../public/src/design/parts.js");
  for (const type of ["reactor", "engine", "shield", "repair", "beamEmitter", "blaster", "spinalAccelerator"]) {
    assert.strictEqual(PART_STATS[type].activityHeat, PARTS[type].activityHeat, `${type} client/server activityHeat parity`);
    assert.strictEqual(PART_STATS[type].heatPerShot, PARTS[type].heatPerShot, `${type} client/server heatPerShot parity`);
  }
}

(async () => {
  authoredCatalogueChecks();
  generatorHeatChecks();
  movementHeatChecks();
  weaponHeatChecks();
  shieldHeatChecks();
  await clientParityChecks();
  console.log("Authored Heat generation verification passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
