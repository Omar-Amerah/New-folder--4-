"use strict";
// Movement rebalance acceptance tests: Propulsion Capacitor, Vector Thruster,
// directional acceleration stats, hull control thrust, diminishing-returns
// speed, new AI movement styles, and transversal-velocity evasion.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { updateShipMovement } = require("./src/server/movement");
const { getShipComponentIndexes } = require("./src/server/componentIndexes");
const { calculateMovementStats, calculateDirectionalTurnInputs, calculateCenterOfMass } = require("./public/src/shared/movementStats.js");

function mod(type, x, y, rotation = 0) { return { type, x, y, rotation }; }

function runtimeShip(design, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id: "test", ownerId: "p1", alive: true, x: 300, y: 300, vx: 0, vy: 0, angle: 0,
    targetX: 300, targetY: 600, arrived: false, isManualMove: true,
    radius: stats.radius || 30, design, wiring: createGeneratedPowerWiring(design),
    stats, ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function emptyRoom() {
  return { world: { width: 2000, height: 1600 }, map: { asteroids: [] }, ships: new Map() };
}

function run() {
  // ── 1. New components exist in PARTS ──────────────────────────────────
  assert(PARTS.propulsionCapacitor, "Propulsion Capacitor must exist in PARTS");
  assert(PARTS.vectorThruster, "Vector Thruster must exist in PARTS");
  assert(PARTS.propulsionCapacitor.propulsionCapacitor, "Propulsion Capacitor must have its config sub-object");
  assert(PARTS.propulsionCapacitor.propulsionCapacitor.capacity > 0, "Capacitor capacity must be positive");
  assert(PARTS.vectorThruster.lateralThrust > 0, "Vector Thruster must have lateralThrust > 0");
  assert(PARTS.vectorThruster.brakingThrust > 0, "Vector Thruster must have brakingThrust > 0");
  assert(PARTS.vectorThruster.reverseThrust > 0, "Vector Thruster must have reverseThrust > 0");
  console.log("  ✓ New components exist in PARTS with correct fields");

  // ── 2. Component indexes track new types ──────────────────────────────
  const capDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("propulsionCapacitor", 6, 7)];
  const capShip = runtimeShip(capDesign);
  const capIndexes = getShipComponentIndexes(capShip);
  assert(capIndexes.propulsionCapacitorIndices.length === 1, "Should find 1 propulsion capacitor index");
  assert(capIndexes.thrustIndices.includes(2), "Engine should be in thrustIndices");

  const vtDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("vectorThruster", 6, 7, 90)];
  const vtShip = runtimeShip(vtDesign);
  const vtIndexes = getShipComponentIndexes(vtShip);
  assert(vtIndexes.vectorThrusterIndices.length === 1, "Should find 1 vector thruster index");
  assert(vtIndexes.thrustIndices.includes(2), "Engine should be in thrustIndices (vector thruster has thrust too but check engine)");
  console.log("  ✓ Component indexes track vectorThruster and propulsionCapacitor");

  // ── 3. Directional acceleration stats are computed ────────────────────
  const vtStats = computeStats(vtDesign);
  assert(typeof vtStats.lateralAccel === "number", "lateralAccel must be a number");
  assert(typeof vtStats.brakingAccel === "number", "brakingAccel must be a number");
  assert(typeof vtStats.reverseAccel === "number", "reverseAccel must be a number");
  assert(vtStats.lateralAccel > 0, "Ship with vector thruster should have lateralAccel > 0");
  assert(vtStats.brakingAccel > 0, "Ship with vector thruster should have brakingAccel > 0");
  assert(vtStats.reverseAccel > 0, "Ship with vector thruster should have reverseAccel > 0");

  // Ship without vector thruster should have zero directional accel (unless hull control provides some)
  const plainDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8)];
  const plainStats = computeStats(plainDesign);
  assert(plainStats.lateralAccel >= 0, "lateralAccel should be >= 0 without vector thruster");
  assert(plainStats.brakingAccel >= 0, "brakingAccel should be >= 0 without vector thruster");
  console.log("  ✓ Directional acceleration stats computed correctly");

  // ── 4. Hull control thrust provides baseline directional stats ────────
  const hullControl = BALANCE.movement?.hullControlThrust;
  assert(hullControl, "hullControlThrust config must exist in balance");
  assert(hullControl.Light && hullControl.Medium && hullControl.Heavy && hullControl.Capital,
    "hullControlThrust must define all mass classes");
  // A light ship (core + reactor + engine) should get some hull control lateral
  assert(plainStats.lateralAccel > 0 || plainStats.brakingAccel > 0,
    "Light ship should have some hull control thrust providing lateral or braking accel");
  console.log("  ✓ Hull control thrust provides baseline directional stats");

  // ── 5. Diminishing returns: more engines never reduces speed ──────────
  const oneEngine = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8)];
  const twoEngines = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("engine", 8, 8)];
  const fourEngines = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("engine", 8, 8), mod("engine", 9, 8), mod("engine", 6, 8)];
  const s1 = computeStats(oneEngine);
  const s2 = computeStats(twoEngines);
  const s4 = computeStats(fourEngines);
  assert(s2.maxSpeed >= s1.maxSpeed, "2 engines should not reduce max speed vs 1");
  assert(s4.maxSpeed >= s2.maxSpeed, "4 engines should not reduce max speed vs 2");
  // Diminishing returns: the speed gain from 2→4 should be less than 1→2
  const gain12 = s2.maxSpeed - s1.maxSpeed;
  const gain24 = s4.maxSpeed - s2.maxSpeed;
  assert(gain24 <= gain12 + 0.01, "Diminishing returns: 2→4 speed gain should be <= 1→2 gain");
  console.log("  ✓ Diminishing returns: more engines never reduces speed, gains diminish");

  // ── 6. Propulsion capacitor boost activates during movement ───────────
  const capDesign2 = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("propulsionCapacitor", 6, 7)];
  const capShip2 = runtimeShip(capDesign2, { targetX: 1000, targetY: 300, arrived: false });
  const initialVx = capShip2.vx;
  updateShipMovement(emptyRoom(), capShip2, 1 / 30, 1000);
  // Ship should have accelerated
  assert(capShip2.vx > initialVx, "Ship with capacitor should accelerate toward target");
  // Propulsion capacitor state should be initialized
  assert(capShip2._propulsionCapacitorState, "Propulsion capacitor state should be initialized");
  console.log("  ✓ Propulsion capacitor state initializes during movement");

  // ── 7. New combat styles are recognized ───────────────────────────────
  const styleDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("blaster", 6, 7)];
  for (const style of ["interceptor", "evasive", "brawler", "heavy"]) {
    const styleShip = runtimeShip(styleDesign, { combatStyle: style, targetX: 600, targetY: 300, arrived: false });
    const enemy = { id: "enemy", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
    styleShip.combatTargetId = "enemy";
    const styleRoom = emptyRoom();
    styleRoom.ships.set("enemy", enemy);
    updateShipMovement(styleRoom, styleShip, 1 / 30, 1000);
    assert(styleShip._simNow > 0, `Style ${style}: ship should have _simNow set after movement`);
  }
  console.log("  ✓ New combat styles (interceptor, evasive, brawler, heavy) process without errors");

  // ── 8. Evasive style sets dodge direction ─────────────────────────────
  const evasiveShip = runtimeShip(styleDesign, { combatStyle: "evasive", targetX: 600, targetY: 300, arrived: false });
  const enemyShip = { id: "enemy", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  evasiveShip.combatTargetId = "enemy";
  const evasiveRoom = emptyRoom();
  evasiveRoom.ships.set("enemy", enemyShip);
  // Simulate multiple ticks to trigger dodge
  for (let i = 0; i < 5; i++) {
    updateShipMovement(evasiveRoom, evasiveShip, 1 / 30, 1000 + i * 100);
  }
  assert(evasiveShip._evasiveDodgeDir !== undefined, "Evasive ship should have a dodge direction set");
  console.log("  ✓ Evasive style sets dodge direction during movement");

  // ── 9. Transversal velocity computation ───────────────────────────────
  // Test the computeTransversalVelocity indirectly via weapon spread
  // A stationary target should have 0 transversal; a fast-moving perpendicular target should have high
  const { computeTransversalVelocity } = require("./src/server/combat");
  const stationary = { x: 100, y: 0, vx: 0, vy: 0 };
  const shooter = { x: 0, y: 0, vx: 0, vy: 0 };
  assert(computeTransversalVelocity(shooter, stationary) === 0, "Stationary target should have 0 transversal");

  const perpendicular = { x: 100, y: 0, vx: 0, vy: 200 };
  const transverse = computeTransversalVelocity(shooter, perpendicular);
  assert(transverse > 190, `Perpendicular moving target should have high transversal (~200), got ${transverse}`);

  const radial = { x: 100, y: 0, vx: 100, vy: 0 };
  const radialTransverse = computeTransversalVelocity(shooter, radial);
  assert(radialTransverse < 10, `Radial moving target should have near-zero transversal, got ${radialTransverse}`);
  console.log("  ✓ Transversal velocity computation correct (stationary, perpendicular, radial)");

  // ── 10. Evasion increases weapon spread ───────────────────────────────
  const { weaponSpreadRadians } = require("./src/server/combat");
  const weapon = { accuracy: 0.9 };
  const baseSpread = weaponSpreadRadians(weapon, "ballistic", 0);
  const evadedSpread = weaponSpreadRadians(weapon, "ballistic", 300);
  assert(evadedSpread > baseSpread, "Evasion factor should increase weapon spread");
  // Missiles should also be affected
  const missileSpread = weaponSpreadRadians(weapon, "missile", 300);
  const missileBase = weaponSpreadRadians(weapon, "missile", 0);
  assert(missileSpread > missileBase, "Evasion should increase missile spread too");
  // PD should not be affected by evasion (passed as 0 at call site, but verify function handles it)
  const pdSpread = weaponSpreadRadians(weapon, "pointDefense", 300);
  const pdBase = weaponSpreadRadians(weapon, "pointDefense", 0);
  // PD has a very small scale so even with evasion it should be small
  assert(pdSpread >= pdBase, "PD spread with evasion should be >= base PD spread");
  console.log("  ✓ Evasion factor increases weapon spread for ballistic and missile");

  // ── 11. Rebalanced engine stats ───────────────────────────────────────
  const enginePart = PARTS.engine;
  assert(enginePart.thrust === 227, `Rebalanced engine thrust should be 227, got ${enginePart.thrust}`);
  assert(enginePart.mass === 4, `Rebalanced engine mass should be 4, got ${enginePart.mass}`);
  assert(Math.abs(enginePart.powerUse - 1.02) < 0.01, `Rebalanced engine powerUse should be ~1.02, got ${enginePart.powerUse}`);
  console.log("  ✓ Rebalanced engine stats correct (thrust=227, mass=4, power=1.02)");

  // ── 12. Rebalanced maneuver thruster stats ────────────────────────────
  const mtPart = PARTS.maneuverThruster;
  assert(mtPart.mass === 2.8, `Rebalanced maneuver thruster mass should be 2.8, got ${mtPart.mass}`);
  assert(Math.abs(mtPart.powerUse - 1.44) < 0.01, `Rebalanced maneuver thruster powerUse should be ~1.44, got ${mtPart.powerUse}`);
  assert(mtPart.turn === 2.25, `Rebalanced maneuver thruster turn should be 2.25, got ${mtPart.turn}`);
  assert(mtPart.lateralThrust === 162, `Rebalanced maneuver thruster lateralThrust should be 162, got ${mtPart.lateralThrust}`);
  console.log("  ✓ Rebalanced maneuver thruster stats correct (mass=2.8, power=1.44, turn=2.25, lateral=162)");

  // ── 13. Rebalanced reactor stats ──────────────────────────────────────
  const reactorPart = PARTS.reactor;
  assert(Math.abs(reactorPart.powerGeneration - 11.5) < 0.01, `Rebalanced reactor power should be ~11.5, got ${reactorPart.powerGeneration}`);
  console.log("  ✓ Rebalanced reactor stats correct (power=11.5)");

  // ── 14. Rebalanced light weapon mass ──────────────────────────────────
  assert(PARTS.autocannon.mass === 5.4, `Rebalanced autocannon mass should be 5.4, got ${PARTS.autocannon.mass}`);
  assert(PARTS.blaster.mass === 5.4, `Rebalanced blaster mass should be 5.4, got ${PARTS.blaster.mass}`);
  console.log("  ✓ Rebalanced light weapon mass correct (autocannon=5.4, blaster=5.4)");

  // ── 15. Rebalanced frame mass ─────────────────────────────────────────
  assert(PARTS.frame.mass === 3.6, `Rebalanced frame mass should be 3.6, got ${PARTS.frame.mass}`);
  console.log("  ✓ Rebalanced frame mass correct (3.6)");

  // ── 16. Movement style config exists ──────────────────────────────────
  const styles = BALANCE.movement?.movementStyles;
  assert(styles, "movementStyles config must exist");
  assert(styles.interceptor, "interceptor style config must exist");
  assert(styles.evasive, "evasive style config must exist");
  assert(styles.brawler, "brawler style config must exist");
  assert(styles.heavy, "heavy style config must exist");
  assert(typeof styles.interceptor.capacitorAggression === "number", "interceptor capacitorAggression must be a number");
  assert(typeof styles.evasive.dodgeIntervalSeconds === "number", "evasive dodgeIntervalSeconds must be a number");
  console.log("  ✓ Movement style configs exist for all new styles");

  // ── 17. Evasion config exists ─────────────────────────────────────────
  const evasion = BALANCE.movement?.evasion;
  assert(evasion, "evasion config must exist");
  assert(typeof evasion.trackingBase === "number", "evasion trackingBase must be a number");
  assert(typeof evasion.evasionExponent === "number", "evasion evasionExponent must be a number");
  assert(typeof evasion.maxAccuracyPenalty === "number", "evasion maxAccuracyPenalty must be a number");
  console.log("  ✓ Evasion config exists with correct fields");

  // ── 18. summarizeStats includes new fields ────────────────────────────
  const { summarizeStats } = require("./src/server/shipStats");
  const summary = summarizeStats(s1);
  assert(typeof summary.lateralAccel === "number", "summarizeStats must include lateralAccel");
  assert(typeof summary.brakingAccel === "number", "summarizeStats must include brakingAccel");
  assert(typeof summary.reverseAccel === "number", "summarizeStats must include reverseAccel");
  console.log("  ✓ summarizeStats includes lateralAccel, brakingAccel, reverseAccel");

  // ── 19. Vector thruster contributes to turn but not forward accel ─────
  const vtOnlyDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("vectorThruster", 7, 6, 90)];
  const vtOnlyStats = computeStats(vtOnlyDesign);
  // Vector thruster has thrust: 25 so it should provide some forward accel
  assert(vtOnlyStats.accel > 0, "Vector thruster has some thrust so should provide forward accel");
  assert(vtOnlyStats.lateralAccel > 0, "Vector thruster should provide lateral accel");
  console.log("  ✓ Vector thruster provides forward and lateral accel");

  // ── 20. Propulsion capacitor does not provide thrust ──────────────────
  const capOnlyDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("propulsionCapacitor", 6, 7)];
  const capOnlyStats = computeStats(capOnlyDesign);
  assert(capOnlyStats.accel === 0, "Propulsion capacitor alone should not provide acceleration");
  assert(capOnlyStats.maxSpeed === 0, "Propulsion capacitor alone should not provide max speed");
  console.log("  ✓ Propulsion capacitor does not provide thrust or speed on its own");

  console.log("\nAll movement rebalance tests passed ✓");
}

try { run(); } catch (err) { console.error(err.message); process.exit(1); }
