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

console.log(`verify-command-auras passed (range=${range}, components=${commandIds.length})`);
