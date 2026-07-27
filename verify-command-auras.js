const assert = require("assert");
const { PARTS } = require("./src/server/components");
const {
  getCommandAuraRange,
  commandAuraSelfAllowed,
  updateCommandAuras,
  getCommandAuraMultiplier,
  collectAuraSources,
  isAuraComponentOperational
} = require("./src/server/commandAuras");
const HeatRules = require("./public/src/shared/heatRules");

const range = getCommandAuraRange();
assert.strictEqual(typeof range, "number", "command aura range must be a number");
assert(range > 0, "command aura range must be positive");
assert.strictEqual(commandAuraSelfAllowed(), false, "self aura should be disabled by default");

function makeShip(id, ownerId, x, y, design, componentPower = null, componentHp = null, componentHeatState = null) {
  return {
    id,
    ownerId,
    x,
    y,
    alive: true,
    design,
    componentHp: componentHp || design.map(() => 1),
    componentPower: componentPower || { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    componentHeatState: componentHeatState || design.map(() => HeatRules.STATE.NORMAL),
    commandAurasReceived: {},
    commandAuraMultipliers: {}
  };
}

function makeRoom(ships, phase = "active") {
  return {
    phase,
    ships: new Map(ships.map((s) => [s.id, s])),
    players: new Map()
  };
}

// Source and recipient are the same player so they are allied.
const sourceDesign = [{ type: "fireControlCommandCentre" }];
const recipientDesign = [{ type: "frame" }];
const source = makeShip("s1", "p1", 0, 0, sourceDesign);
const inside = makeShip("s2", "p1", range * 0.5, 0, recipientDesign);
const outside = makeShip("s3", "p1", range * 1.5, 0, recipientDesign);
const enemy = makeShip("s4", "p2", range * 0.2, 0, recipientDesign);
const room = makeRoom([source, inside, outside, enemy]);

updateCommandAuras(room, [source, inside, outside, enemy], 0);

assert.strictEqual(getCommandAuraMultiplier(inside, "weaponAccuracyMultiplier"), 1.08, "inside ship should receive weapon accuracy buff");
assert.strictEqual(getCommandAuraMultiplier(inside, "weaponTrackingMultiplier"), 1.10, "inside ship should receive weapon tracking buff");
assert.strictEqual(getCommandAuraMultiplier(outside, "weaponAccuracyMultiplier"), 1, "outside ship should not receive buff");
assert.strictEqual(getCommandAuraMultiplier(enemy, "weaponAccuracyMultiplier"), 1, "enemy ship should not receive buff");
assert.strictEqual(getCommandAuraMultiplier(source, "weaponAccuracyMultiplier"), 1, "source ship should not self-buff by default");
assert.deepStrictEqual(Object.keys(source.commandAurasReceived), [], "source should not receive its own aura");

// Ensure identical aura types do not stack; different categories may combine.
const fcSource = makeShip("s5", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
const cmdSource = makeShip("s6", "p1", 10, 0, [{ type: "backupCore" }]); // backupCore command aura stacks with fireControl
const target = makeShip("s7", "p1", 50, 0, [{ type: "frame" }]);
const room2 = makeRoom([fcSource, cmdSource, target]);
updateCommandAuras(room2, [fcSource, cmdSource, target], 0);
assert.strictEqual(getCommandAuraMultiplier(target, "weaponAccuracyMultiplier"), 1.08 * 1.04, "different aura categories should multiply");
assert.strictEqual(getCommandAuraMultiplier(target, "weaponTrackingMultiplier"), 1.10 * 1.05, "fire-control and command tracking should stack");

// Two identical fire-control auras: only the closest one should apply.
const fcA = makeShip("s5b", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
const fcB = makeShip("s5c", "p1", range * 0.9, 0, [{ type: "fireControlCommandCentre" }]);
const target2 = makeShip("s7b", "p1", 50, 0, [{ type: "frame" }]);
const room2b = makeRoom([fcA, fcB, target2]);
updateCommandAuras(room2b, [fcA, fcB, target2], 0);
assert.strictEqual(getCommandAuraMultiplier(target2, "weaponAccuracyMultiplier"), 1.08, "identical aura type should not stack");

// Test unpowered and destroyed components do not emit auras.
const unpoweredSource = makeShip("s8", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
unpoweredSource.componentPower.byComponentIndex[0].operationalMultiplier = 0;
const nearby = makeShip("s9", "p1", 50, 0, [{ type: "frame" }]);
const room3 = makeRoom([unpoweredSource, nearby]);
updateCommandAuras(room3, [unpoweredSource, nearby], 0);
assert.strictEqual(getCommandAuraMultiplier(nearby, "weaponAccuracyMultiplier"), 1, "unpowered component should not provide aura");

const destroyedSource = makeShip("s10", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
destroyedSource.componentHp[0] = 0;
const nearby2 = makeShip("s11", "p1", 50, 0, [{ type: "frame" }]);
const room4 = makeRoom([destroyedSource, nearby2]);
updateCommandAuras(room4, [destroyedSource, nearby2], 0);
assert.strictEqual(getCommandAuraMultiplier(nearby2, "weaponAccuracyMultiplier"), 1, "destroyed component should not provide aura");

// Test all command components share the same range.
const commandIds = ["backupCore", "fireControlCommandCentre", "fleetDefenceCoordinator", "shieldCommandRelay", "engineeringCommandCentre", "propulsionCommandRelay", "electronicWarfareCommandCentre"];
for (const id of commandIds) {
  const part = PARTS[id];
  assert(part, `${id} should exist in PARTS`);
  if (part.aura) {
    assert.ok(["command", "fireControl", "fleetDefence", "shield", "engineering", "propulsion", "ewar"].includes(part.aura.type), `${id} should have a recognised aura type`);
  }
}

// Test collectAuraSources returns the source with correct type and modifiers.
const sources = collectAuraSources(source);
assert.strictEqual(sources.length, 1, "fireControlCommandCentre should emit one aura source");
assert.strictEqual(sources[0].type, "fireControl", "aura type should be fireControl");
assert.strictEqual(sources[0].multipliers.weaponAccuracyMultiplier, 1.08, "aura multiplier should match balance");

// ---------------------------------------------------------------------------
// Task 1: Operational effectiveness scaling
// ---------------------------------------------------------------------------
const { auraComponentEffectiveness, scaleAuraMultiplier } = require("./src/server/commandAuras");
const { BALANCE } = require("./src/server/balanceConfig");

{
  const s = makeShip("eff1", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  assert.strictEqual(auraComponentEffectiveness(s, 0), 1, "full power normal heat = effectiveness 1");
}
{
  const s = makeShip("eff2", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  s.componentPower.byComponentIndex[0].operationalMultiplier = 0.5;
  assert.strictEqual(auraComponentEffectiveness(s, 0), 0.5, "half power = effectiveness 0.5");
  assert.ok(Math.abs(scaleAuraMultiplier(1.08, 0.5) - 1.04) < 1e-9, "1.08 at 0.5 eff = 1.04");
}
{
  const s = makeShip("eff3", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  s.componentHeatState[0] = HeatRules.STATE.OVERHEATED;
  assert.strictEqual(auraComponentEffectiveness(s, 0), 0, "overheated = effectiveness 0");
  const r = makeShip("eff3r", "p1", 50, 0, [{ type: "frame" }]);
  const rm = makeRoom([s, r]);
  updateCommandAuras(rm, [s, r], 0);
  assert.strictEqual(getCommandAuraMultiplier(r, "weaponAccuracyMultiplier"), 1, "overheated component no aura");
}
{
  assert.strictEqual(scaleAuraMultiplier(0.8, 0.5), 0.9, "reduction 0.8 at 0.5 eff = 0.9");
  assert.strictEqual(scaleAuraMultiplier(1.08, 0), 1, "0 eff = neutral");
}

// ---------------------------------------------------------------------------
// Task 2: Fleet Defence Coordinator
// ---------------------------------------------------------------------------
{
  const s = makeShip("fd1", "p1", 0, 0, [{ type: "fleetDefenceCoordinator" }]);
  const r = makeShip("fd1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "pointDefenceTrackingMultiplier") > 1, "PD tracking buff");
  assert(getCommandAuraMultiplier(r, "flakTrackingMultiplier") > 1, "flak tracking buff");
  assert(getCommandAuraMultiplier(r, "interceptionReactionMultiplier") > 1, "interception reaction buff");
}
{
  assert(BALANCE.fleetDefence, "BALANCE.fleetDefence exists");
  assert(BALANCE.fleetDefence.baseReacquisitionDelayMs > 0, "fleetDefence baseReacquisitionDelayMs positive");
  const cs = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(cs.includes("pdAcquiredTargetIds"), "combat.js has PD acquired target tracking");
  assert(cs.includes("pdPendingTargetIds"), "combat.js has PD pending target tracking");
}

// ---------------------------------------------------------------------------
// Task 3: Fire-Control target acquisition
// ---------------------------------------------------------------------------
{
  const s = makeShip("fc1", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  const r = makeShip("fc1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "targetAcquisitionMultiplier") > 1, "target acquisition buff");
  assert(getCommandAuraMultiplier(r, "turretAimSpeedMultiplier") > 1, "turret aim speed buff");
}
{
  assert(BALANCE.fireControl, "BALANCE.fireControl exists");
  assert(BALANCE.fireControl.baseReacquisitionDelayMs > 0, "fireControl baseReacquisitionDelayMs positive");
  const cs = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(cs.includes("weaponAcquiredTargetIds"), "combat.js has offensive acquired target tracking");
  assert(cs.includes("weaponPendingTargetIds"), "combat.js has offensive pending target tracking");
}
{
  const cd = require("fs").readFileSync("./src/server/componentData.js", "utf8");
  assert(cd.includes("pointDefenceTrackingMultiplier") && cd.includes("aimSpeed"), "PD tracking applies to aimSpeed");
  assert(cd.includes("flakTrackingMultiplier") && cd.includes("aimSpeed"), "flak tracking applies to aimSpeed");
}

// ---------------------------------------------------------------------------
// Task 4: Engineering repair - emitter's aura
// ---------------------------------------------------------------------------
{
  const s = makeShip("eng1", "p1", 0, 0, [{ type: "engineeringCommandCentre" }]);
  const r = makeShip("eng1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "repairRateMultiplier") > 1, "repair rate buff");
  assert(getCommandAuraMultiplier(r, "heatDissipationMultiplier") > 1, "heat dissipation buff");
  assert(getCommandAuraMultiplier(r, "overheatRecoveryMultiplier") > 1, "overheat recovery buff");
}
{
  const ch = require("fs").readFileSync("./src/server/componentHealth.js", "utf8");
  assert(ch.includes("emitterShip"), "componentHealth.js accepts emitterShip");
  const cs = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(cs.includes("repairShipComponents(room, target, beamRepairRate * dt, now, ship)"), "combat.js passes emitter to repair");
}

// ---------------------------------------------------------------------------
// Task 5: Engineering heat dissipation - radiators
// ---------------------------------------------------------------------------
{
  const hs = require("fs").readFileSync("./src/server/heat.js", "utf8");
  assert(hs.includes("exposure * thermal.retention * heatDissipationMult"), "radiator cooling includes heatDissipationMult");
}

// ---------------------------------------------------------------------------
// Task 6: Overheat recovery - general
// ---------------------------------------------------------------------------
{
  const hs = require("fs").readFileSync("./src/server/heat.js", "utf8");
  assert(hs.includes("STATE.CRITICAL") && hs.includes("overheatRecoveryMult"), "heat.js boosts cooling for CRITICAL/OVERHEATED with overheatRecoveryMult");
}

// ---------------------------------------------------------------------------
// Task 7: Shield Command Relay - simulation time
// ---------------------------------------------------------------------------
{
  const s = makeShip("sh1", "p1", 0, 0, [{ type: "shieldCommandRelay" }]);
  const r = makeShip("sh1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "shieldRegenMultiplier") > 1, "shield regen buff");
  assert(getCommandAuraMultiplier(r, "shieldRestartDelayMultiplier") < 1, "shield restart delay reduction");
}
{
  const ms = require("fs").readFileSync("./src/server/movement.js", "utf8");
  assert(ms.includes("_shieldDepletedAt"), "movement.js uses _shieldDepletedAt (sim time)");
  assert(!ms.includes("_shieldRestartAt"), "movement.js no longer uses _shieldRestartAt (wall-clock)");
}

// ---------------------------------------------------------------------------
// Task 8: Propulsion Command Relay
// ---------------------------------------------------------------------------
{
  const s = makeShip("pr1", "p1", 0, 0, [{ type: "propulsionCommandRelay" }]);
  const r = makeShip("pr1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "accelerationMultiplier") > 1, "acceleration buff");
  assert(getCommandAuraMultiplier(r, "turnRateMultiplier") > 1, "turn rate buff");
}

// ---------------------------------------------------------------------------
// Task 9: Electronic Warfare - componentAimRetentionMultiplier
// ---------------------------------------------------------------------------
{
  const s = makeShip("ew1", "p1", 0, 0, [{ type: "electronicWarfareCommandCentre" }]);
  const r = makeShip("ew1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "sensorRangeMultiplier") > 1, "sensor range buff");
  assert(getCommandAuraMultiplier(r, "missileTrackingResistanceMultiplier") > 1, "missile tracking resistance buff");
  assert(getCommandAuraMultiplier(r, "componentAimRetentionMultiplier") > 1, "componentAimRetention buff");
  assert.strictEqual(getCommandAuraMultiplier(r, "targetRetentionMultiplier"), 1, "old key neutral");
}
{
  const cs = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(cs.includes("componentAimRetentionMultiplier"), "combat.js uses renamed key");
  assert(!cs.includes("targetRetentionMultiplier"), "combat.js no old key");
}

// ---------------------------------------------------------------------------
// Task 10: Backup Command Core
// ---------------------------------------------------------------------------
{
  const s = makeShip("bc1", "p1", 0, 0, [{ type: "backupCore" }]);
  const r = makeShip("bc1r", "p1", 50, 0, [{ type: "frame" }]);
  updateCommandAuras(makeRoom([s, r]), [s, r], 0);
  assert(getCommandAuraMultiplier(r, "weaponAccuracyMultiplier") > 1, "backup core accuracy buff");
  assert(getCommandAuraMultiplier(r, "weaponTrackingMultiplier") > 1, "backup core tracking buff");
  assert(getCommandAuraMultiplier(r, "targetAcquisitionMultiplier") > 1, "backup core acquisition buff");
  assert.strictEqual(PARTS["backupCore"].aura.type, "command", "backupCore aura type is command");
}

console.log(`verify-command-auras passed (range=${range}, components=${commandIds.length})`);
