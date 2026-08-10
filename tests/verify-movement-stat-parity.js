"use strict";

// Blueprint, server and live-runtime movement must agree on generic component
// turn modifiers without treating every `turn` field as an active actuator.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const EngineExhaust = require("../public/src/shared/engineExhaust.js");
const movement = require("../public/src/shared/movementStats.js");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState, recalcEffectiveStats, updateEngineExhaustState } = require("../src/server/componentHealth");
const { initShipHeat, updateShipHeat } = require("../src/server/heat");
const { applyTurnHeat, heatAdjustedMovementStats } = require("../src/server/movementCapability");

globalThis.EngineExhaustRules = EngineExhaust;
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

function close(actual, expected, tolerance, message) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function baseDesign(extra = null) {
  const design = [
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "reactor" },
    { x: 7, y: 9, type: "engine" }
  ];
  if (extra) design.push({ ...extra });
  return design;
}

function runtimeShip(design) {
  const ship = {
    design: design.map((module) => ({ ...module })),
    stats: computeStats(design),
    alive: true
  };
  initComponentState(ship);
  initShipHeat(ship);
  return ship;
}

function liveBlocker(design) {
  const exhaust = EngineExhaust.analyze(design, PARTS);
  return (index, module, part) => (part.thrust > 0 || module.type === "maneuverThruster")
    && !exhaust.validEngineIndices.has(index);
}

function movementInputs(design) {
  const centerOfMass = movement.calculateCenterOfMass(design, PARTS);
  const isBlockedEngine = liveBlocker(design);
  const directionalTurnInputs = movement.calculateDirectionalTurnInputs(design, PARTS, {
    centerOfMass,
    leverSettings: movement.MOVEMENT_CONFIG.maneuverThrusterLever,
    isBlockedEngine
  });
  const engineThrustValues = [];
  const engineMassValues = [];
  for (let index = 0; index < design.length; index += 1) {
    const part = PARTS[design[index].type] || {};
    if (part.thrust > 0 && !isBlockedEngine(index, design[index], part)) {
      engineThrustValues.push(part.thrust);
      engineMassValues.push(part.mass || 0);
    }
  }
  return { directionalTurnInputs, engineThrustValues, engineMassValues };
}

function directMovement(design, turnBonus) {
  const stats = computeStats(design);
  const inputs = movementInputs(design);
  return movement.calculateMovementStats({
    mass: stats.mass,
    thrust: stats.thrust,
    turnBonus,
    powerGeneration: stats.availablePower,
    powerUse: stats.powerUse,
    ...inputs,
  });
}

function assertMovementParity(label, design, clientComputeStats) {
  const paper = computeStats(design);
  const client = clientComputeStats(design);
  const ship = runtimeShip(design);
  const live = heatAdjustedMovementStats(ship, ship.stats);

  for (const field of ["maxHp", "turnRate", "turnRateLeft", "turnRateRight", "maxSpeed", "accel", "brakingAcceleration", "effectiveThrust"]) {
    const tolerance = field === "maxHp" ? 1e-9 : field === "accel" ? 1.01 : 0.03;
    close(client[field], paper[field], tolerance, `${label} client/server ${field}`);
    close(live[field], paper[field], tolerance, `${label} paper/live ${field}`);
  }
  assert.strictEqual(client.massClass, movement.massClassForMass(paper.mass), `${label} client mass class uses shared boundaries`);
  assert.strictEqual(live.massClass, movement.massClassForMass(paper.mass), `${label} live mass class uses shared boundaries`);
  close(client.turnCap, movement.turnCapForMass(paper.mass), 1e-9, `${label} client turn cap uses shared authority`);
  close(live.turnCap, movement.turnCapForMass(paper.mass), 1e-9, `${label} live turn cap uses shared authority`);
  return { paper, client, ship, live };
}

async function run() {
  const { computeStats: clientComputeStats } = await import("../public/src/design/componentStats.js");

  // The shared helper is the only generic-turn classifier. Special actuator
  // values are intentionally absent from this sum.
  const genericCases = [
    ["Armor", "armor", -0.06],
    ["Railgun", "railgun", -0.065],
    ["Targeting Computer", "targetingComputer", 0.02],
    ["Stabilizer Node", "stabilizerNode", 0.06]
  ];
  for (const [label, type, expected] of genericCases) {
    const design = baseDesign({ x: 6, y: 7, type });
    const actual = movement.calculateGenericTurnModifier(design, PARTS, { isBlockedEngine: liveBlocker(design) });
    close(actual, expected, 1e-9, `${label} generic turn modifier`);

    const withoutModifier = directMovement(design, 0);
    const withModifier = directMovement(design, actual);
    if (expected < 0) {
      assert(withModifier.turnRate < withoutModifier.turnRate, `${label} penalty must reduce the paper turn rate`);
    } else {
      assert(withModifier.turnRate > withoutModifier.turnRate, `${label} bonus must increase the paper turn rate`);
    }
    assertMovementParity(label, design, clientComputeStats);
  }

  const noAuthority = movement.calculateMovementStats({
    mass: 20,
    thrust: 0,
    turnBonus: 10,
    powerGeneration: 0,
    powerUse: 0,
    engineThrustValues: [],
    engineMassValues: [],
    turnModuleValues: [],
    directionalTurnInputs: { mainEngineVectorTurn: 0, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
  });
  assert.strictEqual(noAuthority.turnRate, 0, "a ship without turn-producing components has no turn rate");
  assert.strictEqual(noAuthority.turnRateLeft, 0, "a ship without turn-producing components has no left turn rate");
  assert.strictEqual(noAuthority.turnRateRight, 0, "a ship without turn-producing components has no right turn rate");
  for (const mass of [20, 80, 160, 260]) {
    const classOnly = movement.calculateMovementStats({
      mass,
      thrust: 0,
      turnBonus: 0,
      powerGeneration: 0,
      powerUse: 0,
      engineThrustValues: [],
      directionalTurnInputs: { mainEngineVectorTurn: 0, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
    });
    assert.strictEqual(classOnly.turnRate, 0, `mass class at ${mass}T must not add free turn`);
  }

  const engineTurn = movement.calculateMovementStats({
    mass: 20,
    thrust: 200,
    turnBonus: 0,
    powerGeneration: 0,
    powerUse: 0,
    engineThrustValues: [200],
    engineMassValues: [4],
    directionalTurnInputs: { mainEngineVectorTurn: 0.2, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
  });
  const expectedEngineTurn = 0.2 * movement.MOVEMENT_CONFIG.turn.genericScale
    / Math.pow(1 + 20 / movement.MOVEMENT_CONFIG.turn.massDivisor, movement.MOVEMENT_CONFIG.turn.massExponent);
  close(engineTurn.turnRate, expectedEngineTurn, 1e-9, "turn rate has no hidden base contribution");
  const heavyEngineTurn = movement.calculateMovementStats({
    mass: 200,
    thrust: 200,
    turnBonus: 0,
    powerGeneration: 0,
    powerUse: 0,
    engineThrustValues: [200],
    engineMassValues: [4],
    directionalTurnInputs: { mainEngineVectorTurn: 0.2, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
  });
  assert(engineTurn.turnRate > heavyEngineTurn.turnRate, "retained ship mass scaling reduces turn rate");

  const sourceText = fs.readFileSync(path.join(__dirname, "..", "public", "src", "shared", "movementStats.js"), "utf8");
  assert(!sourceText.includes("0.216"), "the old free turn base is removed");
  assert(!sourceText.includes("effectiveStackedValue"), "turn source falloff helper is removed");
  assert(!sourceText.includes("0.85"), "engine turn falloff is removed");
  assert(!sourceText.includes("0.92"), "gyro and maneuver turn falloff is removed");

  const weightedParts = {
    light: { mass: 2 },
    heavy: { mass: 6 },
    zero: { mass: 0 }
  };
  const weightedDesign = [
    { x: 0, y: 0, type: "light" },
    { x: 10, y: 0, type: "heavy" }
  ];
  const weightedCenter = movement.calculateCenterOfMass(weightedDesign, weightedParts);
  const reorderedCenter = movement.calculateCenterOfMass([...weightedDesign].reverse(), weightedParts);
  close(weightedCenter.x, 7.5, 1e-12, "centre of mass uses exact component mass");
  close(weightedCenter.y, 0, 1e-12, "centre of mass y is mathematically exact");
  assert.strictEqual(weightedCenter.mass, 8, "centre of mass does not add hidden mass");
  assert.deepStrictEqual(reorderedCenter, weightedCenter, "centre of mass does not depend on component order");
  assert.deepStrictEqual(
    movement.calculateCenterOfMass([{ x: 4, y: 9, type: "zero" }], weightedParts),
    { x: 0, y: 0, mass: 0 },
    "zero-mass components do not divide centre of mass by zero"
  );

  const leverageParts = {
    frame: { mass: 8 },
    maneuverThruster: { mass: 2, turn: 0.2 }
  };
  const leverageDesign = [
    { x: 0, y: 0, type: "frame" },
    { x: 0, y: 4, type: "maneuverThruster", rotation: 90 }
  ];
  const leverageCenter = movement.calculateCenterOfMass(leverageDesign, leverageParts);
  const leverageInput = movement.calculateDirectionalTurnInputs(leverageDesign, leverageParts, { centerOfMass: leverageCenter });
  close(leverageCenter.y, 0.8, 1e-12, "Maneuver Thruster leverage uses exact centre of mass");
  close(leverageInput.maneuverThrusters[0].lever, 1.47, 1e-12, "Maneuver Thruster lever uses corrected centre of mass");

  // A passive turn penalty must not become a powered actuator or create
  // turning Heat just because it is included in the movement formula.
  const armorDesign = baseDesign({ x: 6, y: 7, type: "armor" });
  const armorStats = computeStats(armorDesign);
  const baseStats = computeStats(baseDesign());
  assert.strictEqual(armorStats.powerUse, baseStats.powerUse, "Armor turn penalty must not consume Power");
  const armorShip = runtimeShip(armorDesign);
  const armorHeatBefore = armorShip.componentHeat[3];
  applyTurnHeat(armorShip, 1, 1);
  assert.strictEqual(armorShip.componentHeat[3], armorHeatBefore, "Armor turn penalty must not generate turning Heat");

  // Universal Power is the only movement Power multiplier. An engine at 50%
  // allocation contributes 50% thrust, not 50% followed by a second shortage
  // curve; zero allocation removes it, and surplus supply adds no output.
  close(movement.calculateMovementPowerMultiplier(50, 100), 0.5, 1e-9, "movement Power allocation is linear");
  close(movement.calculateMovementPowerMultiplier(200, 100), 1, 1e-9, "surplus Power does not boost movement");
  close(movement.calculateMovementPowerMultiplier(0, 100), 0, 1e-9, "zero Power produces zero movement allocation");
  const powerDesign = baseDesign();
  const powerShip = runtimeShip(powerDesign);
  const fullPowerMovement = heatAdjustedMovementStats(powerShip, powerShip.stats);
  powerShip.componentPower = { byComponentIndex: { 2: { operationalMultiplier: 0.5 } } };
  const halfPowerMovement = heatAdjustedMovementStats(powerShip, powerShip.stats);
  close(halfPowerMovement.effectiveThrust, fullPowerMovement.effectiveThrust * 0.5, 1e-9, "50% engine Power gives 50% thrust");
  close(halfPowerMovement.accel, fullPowerMovement.accel * 0.5, 1e-9, "50% engine Power gives 50% acceleration");
  powerShip.componentPower = { byComponentIndex: { 2: { operationalMultiplier: 0 } } };
  const zeroPowerMovement = heatAdjustedMovementStats(powerShip, powerShip.stats);
  assert.strictEqual(zeroPowerMovement.effectiveThrust, 0, "zero engine Power gives zero thrust");
  powerShip.componentPower = { byComponentIndex: { 2: { operationalMultiplier: 1 } } };
  powerShip.powerAnalysis = { summary: { availableGenerationMw: 200, demandMw: 100 } };
  const surplusPowerMovement = heatAdjustedMovementStats(powerShip, powerShip.stats);
  close(surplusPowerMovement.effectiveThrust, fullPowerMovement.effectiveThrust, 1e-9, "surplus Power does not increase thrust");

  // Destroying a generic modifier must update the live rate and the cached
  // component-destruction stats in the same way as a paper design without it.
  for (const [label, type, direction] of [
    ["destroyed Stabilizer Node", "stabilizerNode", -1],
    ["destroyed Armor", "armor", 1]
  ]) {
    const design = baseDesign({ x: 6, y: 7, type });
    const ship = runtimeShip(design);
    const before = heatAdjustedMovementStats(ship, ship.stats);
    ship.componentHp[3] = 0;
    updateEngineExhaustState(ship);
    recalcEffectiveStats(ship);
    const after = heatAdjustedMovementStats(ship, ship.stats);
    const expected = computeStats(design.slice(0, 3));
    close(after.turnRate, expected.turnRate, 0.03, `${label} paper/live turn rate`);
    if (direction < 0) assert(after.turnRate < before.turnRate, `${label} must reduce live turn rate`);
    else assert(after.turnRate > before.turnRate, `${label} must remove the live turn penalty`);
  }

  // Gyroscopes and Maneuver Thrusters retain actuator semantics and are not
  // folded into the generic sum. A single maneuver unit must still favour one
  // turn direction according to its lever arm and facing.
  const gyroDesign = baseDesign({ x: 6, y: 7, type: "gyroscope" });
  assert.strictEqual(movement.calculateGenericTurnModifier(gyroDesign, PARTS), 0, "Gyroscope is not a generic turn modifier");
  const gyro = assertMovementParity("Gyroscope", gyroDesign, clientComputeStats);
  assert(gyro.live.directionalTurn.gyroscopeTurn > 0, "Gyroscope actuator output remains active");
  const twoGyroDesign = baseDesign({ x: 6, y: 7, type: "gyroscope" });
  twoGyroDesign.push({ x: 5, y: 7, type: "gyroscope" });
  const oneGyroInput = movement.calculateDirectionalTurnInputs(gyroDesign, PARTS, { isBlockedEngine: liveBlocker(gyroDesign) });
  const twoGyroInput = movement.calculateDirectionalTurnInputs(twoGyroDesign, PARTS, { isBlockedEngine: liveBlocker(twoGyroDesign) });
  close(twoGyroInput.gyroscopeTurn, oneGyroInput.gyroscopeTurn * 2, 1e-9, "Gyroscope turn values stack linearly");
  const threeGyroDesign = [...twoGyroDesign, { x: 4, y: 7, type: "gyroscope" }];
  const threeGyroInput = movement.calculateDirectionalTurnInputs(threeGyroDesign, PARTS, { isBlockedEngine: liveBlocker(threeGyroDesign) });
  close(threeGyroInput.gyroscopeTurn, oneGyroInput.gyroscopeTurn * 3, 1e-9, "three Gyroscope turn values stack linearly");
  const reorderedGyroInput = movement.calculateDirectionalTurnInputs([...threeGyroDesign].reverse(), PARTS);
  close(reorderedGyroInput.gyroscopeTurn, threeGyroInput.gyroscopeTurn, 1e-9, "turn contribution does not depend on component order");

  const engineParts = {
    engineA: { mass: 4, thrust: 100 },
    engineB: { mass: 4, thrust: 200 }
  };
  const engineTurnInputs = movement.calculateDirectionalTurnInputs([
    { x: 0, y: 0, type: "engineA" },
    { x: 1, y: 0, type: "engineB" }
  ], engineParts);
  close(engineTurnInputs.mainEngineVectorTurn, 0.3, 1e-12, "Engine vector turn contributions stack additively");

  const aboveDesign = baseDesign({ x: 6, y: 5, type: "maneuverThruster" });
  const belowDesign = baseDesign({ x: 6, y: 8, type: "maneuverThruster" });
  const above = assertMovementParity("upper Maneuver Thruster", aboveDesign, clientComputeStats);
  const below = assertMovementParity("lower Maneuver Thruster", belowDesign, clientComputeStats);
  assert.strictEqual(movement.calculateGenericTurnModifier(aboveDesign, PARTS), 0, "Maneuver Thruster is not a generic turn modifier");
  assert(above.live.directionalTurn.clockwiseManeuverTurn > 0, "upper Maneuver Thruster keeps clockwise authority");
  assert.strictEqual(above.live.directionalTurn.anticlockwiseManeuverTurn, 0, "upper Maneuver Thruster does not leak to the opposite side");
  assert(above.live.turnRateRight > above.live.turnRateLeft, "upper Maneuver Thruster keeps left/right asymmetry");
  assert(below.live.directionalTurn.anticlockwiseManeuverTurn > 0, "lower Maneuver Thruster keeps anticlockwise authority");
  assert.strictEqual(below.live.directionalTurn.clockwiseManeuverTurn, 0, "lower Maneuver Thruster does not leak to the opposite side");
  assert(below.live.turnRateLeft > below.live.turnRateRight, "lower Maneuver Thruster mirrors left/right asymmetry");
  const twoAboveDesign = [...aboveDesign, { x: 5, y: 5, type: "maneuverThruster" }];
  const fixedCenter = movement.calculateCenterOfMass(aboveDesign, PARTS);
  const oneAboveInput = movement.calculateDirectionalTurnInputs(aboveDesign, PARTS, { centerOfMass: fixedCenter, isBlockedEngine: liveBlocker(aboveDesign) });
  const twoAboveInput = movement.calculateDirectionalTurnInputs(twoAboveDesign, PARTS, { centerOfMass: fixedCenter, isBlockedEngine: liveBlocker(twoAboveDesign) });
  close(twoAboveInput.clockwiseManeuverTurn, oneAboveInput.clockwiseManeuverTurn * 2, 1e-9, "Maneuver Thruster torque values stack linearly after lever calculation");

  // Actual actuator Power/Heat handling remains separate from the generic
  // modifier. Turning a Gyroscope heats it, and removing its Power removes its
  // directional authority.
  const poweredGyro = runtimeShip(gyroDesign);
  const gyroHeatBefore = poweredGyro.componentHeat[3];
  applyTurnHeat(poweredGyro, 1, 1);
  updateShipHeat(poweredGyro, 0.2);
  assert(poweredGyro.componentHeat[3] > gyroHeatBefore, "Gyroscope turning still generates Heat");
  poweredGyro.componentPower = { byComponentIndex: { 3: { operationalMultiplier: 0 } } };
  const unpoweredGyro = heatAdjustedMovementStats(poweredGyro, poweredGyro.stats);
  assert.strictEqual(unpoweredGyro.directionalTurn.gyroscopeTurn, 0, "unpowered Gyroscope loses actuator output");

  // Movement metadata no longer carries a second set of solver constants.
  const sourceBalance = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "component-balance.json"), "utf8"));
  const generatedBalance = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "component-balance.generated.json"), "utf8"));
  assert.strictEqual(sourceBalance.movement.authority, "public/src/shared/movementStats.js", "movement metadata points to shared authority");
  assert.strictEqual(generatedBalance.movement.authority, sourceBalance.movement.authority, "generated movement metadata preserves authority");
  for (const duplicate of ["massClasses", "maneuverThrusterLever"]) {
    assert(!(duplicate in sourceBalance.movement), `movement metadata must not duplicate ${duplicate}`);
  }
  assert.strictEqual(Object.prototype.hasOwnProperty.call(movement.MOVEMENT_CONFIG.speed, "capMinimum"), false, "speed config has no soft-cap minimum");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(movement.MOVEMENT_CONFIG.speed, "capBase"), false, "speed config has no soft-cap base");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(movement.MOVEMENT_CONFIG.speed, "capMassSlope"), false, "speed config has no soft-cap mass slope");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(movement.MOVEMENT_CONFIG.speed, "capSoftness"), false, "speed config has no soft-cap efficiency");
  const designerUiSource = fs.readFileSync(path.join(__dirname, "..", "public", "src", "ui", "designerUi.js"), "utf8");
  assert.doesNotMatch(designerUiSource, /speed soft cap|soft speed cap/i,
    "Designer copy must not describe removed speed-cap mechanics");
  assert.match(designerUiSource, /formatMassClassRange/,
    "Designer class tooltip must format ranges from shared movement rules");
  assert.doesNotMatch(designerUiSource, /Light \(<55 T\)|55-124 T|125-229 T|Capital \(230\+ T\)/,
    "Designer must not carry a manually typed mass-class table");
  const componentMechanics = await import("../public/src/ledger/componentMechanics.js");
  const enginePowerScaling = componentMechanics.getMechanics("engine").specialMechanics
    .find((entry) => entry.label === "Power Scaling");
  assert.ok(enginePowerScaling?.detail?.includes(`${Math.round(movement.MOVEMENT_CONFIG.power.maximumMultiplier * 100)}%`),
    "component Ledger Power scaling must use the shared movement rule");
  const maneuverLever = movement.MOVEMENT_CONFIG.maneuverThrusterLever;
  const leverMechanic = componentMechanics.getMechanics("maneuverThruster").specialMechanics
    .find((entry) => entry.label === "Lever Arm");
  assert.ok(leverMechanic?.value?.includes(`${maneuverLever.minimumLever}`)
    && leverMechanic.value.includes(`${maneuverLever.leverPerCell}`)
    && leverMechanic.value.includes(`${maneuverLever.maximumLever}`),
    "component Ledger Maneuver lever values must use the shared movement rule");
  const highThrustMovement = movement.calculateMovementStats({
    mass: 50,
    thrust: 10000,
    powerGeneration: 100,
    powerUse: 0,
    engineThrustValues: [10000],
    engineMassValues: [10],
    turnModuleValues: [],
    directionalTurnInputs: { mainEngineVectorTurn: 0, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
  });
  const highThrustMassDrag = 1 / Math.pow(1 + 50 / movement.MOVEMENT_CONFIG.speed.massDivisor, movement.MOVEMENT_CONFIG.speed.massExponent);
  const highThrustFormula = (movement.MOVEMENT_CONFIG.speed.base + Math.sqrt(10000) * movement.MOVEMENT_CONFIG.speed.thrustSqrtScale) * highThrustMassDrag;
  close(highThrustMovement.maxSpeed, highThrustFormula, 1e-9, "high thrust speed uses mass drag without a soft cap");
  const lowerThrustMovement = movement.calculateMovementStats({
    mass: 50,
    thrust: 1000,
    powerGeneration: 100,
    powerUse: 0,
    engineThrustValues: [1000],
    engineMassValues: [10],
    turnModuleValues: [],
    directionalTurnInputs: { mainEngineVectorTurn: 0, gyroscopeTurn: 0, clockwiseManeuverTurn: 0, anticlockwiseManeuverTurn: 0 }
  });
  assert(highThrustMovement.maxSpeed > lowerThrustMovement.maxSpeed, "speed remains continuous with thrust after soft-cap removal");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(computeStats(baseDesign()), "speedCap"), false, "server stats no longer expose speedCap");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(computeStats(baseDesign()), "speedCapped"), false, "server stats no longer expose speedCapped");
  for (const definition of movement.MOVEMENT_CONFIG.massClasses) {
    assert.strictEqual(movement.turnCapForMass(definition.minMass), definition.turnCap,
      `${definition.name} turn cap comes from its shared class definition`);
    const expectedRange = !Number.isFinite(definition.maxMass)
      ? `${definition.minMass}+ T`
      : definition.minMass === 0 ? `< ${definition.maxMass} T` : `${definition.minMass}-${definition.maxMass - 1} T`;
    assert.strictEqual(movement.formatMassClassRange(definition), expectedRange,
      `${definition.name} mass range is formatted from numeric boundaries`);
  }

  assert(Number.isFinite(movement.BRAKE_ACCEL_RATIO) && movement.BRAKE_ACCEL_RATIO > 0,
    "shared braking ratio is a positive movement rule");
  const fixtureAcceleration = 20;
  const fixtureSpeed = 200;
  const expectedBrakingAcceleration = movement.calculateBrakingAcceleration(fixtureAcceleration);
  close(expectedBrakingAcceleration, fixtureAcceleration * movement.BRAKE_ACCEL_RATIO, 1e-12,
    "braking acceleration is derived from the shared ratio");
  close(movement.calculateBrakingDistance(fixtureSpeed, fixtureAcceleration),
    (fixtureSpeed * fixtureSpeed) / (2 * expectedBrakingAcceleration), 1e-12,
    "braking distance uses braking deceleration");
  const movementV2 = require("../src/server/movementV2");
  close(movementV2.brakingAcceleration({ accel: fixtureAcceleration }), expectedBrakingAcceleration, 1e-12,
    "runtime braking uses the shared braking rule");
  const movementV2Source = fs.readFileSync(path.join(__dirname, "..", "src", "server", "movementV2.js"), "utf8");
  assert(movementV2Source.includes("calculateBrakingAcceleration"), "runtime imports shared braking authority");
  assert(!movementV2Source.includes("BRAKE_ACCEL_RATIO = 5"), "runtime does not hard-code a second braking ratio");

  const summaryModel = await import("../public/src/design/shipSummaryModel.js");
  const summary = summaryModel.buildShipSummaryModel({
    unitCost: 0,
    mass: 20,
    maxHp: 100,
    maxShield: 0,
    shieldRegen: 0,
    weaponDps: 0,
    weaponDpsLabel: "Weapon DPS",
    maxSpeed: 200,
    effectiveThrust: 100,
    accel: 20,
    thrustRatio: 5,
    engineEfficiency: 1,
    turnRate: 0,
    turnRateLeft: 0,
    turnRateRight: 0,
    turnCap: 1,
    blockedEngines: 0,
    powerGeneration: 0,
    powerUse: 0,
    powerRatio: 0,
    powerEfficiency: 0,
    energyStorage: 0,
    repairRate: 0,
    droneCapacity: 0,
    captureBonus: 0,
    coolingBonus: 0,
    pointDefense: 0,
    sensorComponentCount: 0,
    directedSensorCount: 0,
    weapons: {}
  }, { includePower: false, design: [], overheatingCount: 0 });
  const mobilityRows = summary.sections.find((section) => section.id === "mobility")?.rows || [];
  const brakingRow = mobilityRows.find((row) => row.id === "brakingAcceleration");
  const expectedBrakingText = String(Math.round(expectedBrakingAcceleration));
  const expectedRatioText = `${movement.BRAKE_ACCEL_RATIO}x acceleration`;
  assert(brakingRow && brakingRow.value.includes(expectedBrakingText) && brakingRow.value.includes(expectedRatioText),
    "Blueprint summary displays braking derived from the shared rule");
  const actualClientStats = clientComputeStats(baseDesign());
  const actualSummary = summaryModel.buildShipSummaryModel(actualClientStats, {
    includePower: false,
    design: baseDesign(),
    overheatingCount: 0
  });
  const actualBrakingRow = actualSummary.sections.find((section) => section.id === "mobility")?.rows
    ?.find((row) => row.id === "brakingAcceleration");
  assert(actualBrakingRow?.value?.includes(String(Math.round(actualClientStats.brakingAcceleration))),
    "Blueprint summary uses the shared braking value carried by Designer stats");
  assert(!fs.readFileSync(path.join(__dirname, "..", "public", "src", "design", "shipSummaryModel.js"), "utf8").includes("same acceleration it accelerates with"), "summary does not claim braking equals acceleration");

  console.log("verify-movement-stat-parity: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
