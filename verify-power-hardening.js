"use strict";

const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const { calculateDirectionalTurnInputs, calculateMovementStats } = require("./public/src/shared/movementStats.js");
const { PARTS } = require("./src/server/components");
const { updateShipMovement } = require("./src/server/movement");

// Powered speed is not a momentum eraser: an engine-less ship keeps drifting,
// while the ordinary damping remains authoritative and prevents perpetual motion.
const room = { world: { width: 2000, height: 1200 }, map: { asteroids: [] }, ships: new Map(), players: new Map() };
const drift = { id: "drift", alive: true, x: 400, y: 400, vx: 120, vy: 0, angle: 0,
  targetX: 1200, targetY: 400, radius: 30, stats: { mass: 20, accel: 0, maxSpeed: 0, turnRate: 0 }, design: [], componentHp: [] };
updateShipMovement(room, drift, 1 / 30);
assert(drift.vx > 0 && drift.vx < 120, "Power loss must preserve damped momentum");
assert(drift.x > 400, "unpowered ship must continue drifting");
assert.equal(drift.targetX, 1200, "Power loss must preserve movement target");

// Contributions are weighted before diminishing returns. A disconnected engine
// is omitted, while an underpowered engine contributes only its own output.
const one = calculateMovementStats({ mass: 40, thrust: 100, powerGeneration: 0, powerUse: 0,
  engineThrustValues: [100], engineMassValues: [10], movementPowerMultiplier: 1 });
const disconnected = calculateMovementStats({ mass: 50, thrust: 200, powerGeneration: 0, powerUse: 0,
  engineThrustValues: [100], engineMassValues: [10], movementPowerMultiplier: 1 });
const half = calculateMovementStats({ mass: 50, thrust: 200, powerGeneration: 0, powerUse: 0,
  engineThrustValues: [100, 50], engineMassValues: [10, 10], movementPowerMultiplier: 1 });
assert.equal(disconnected.effectiveThrust, one.effectiveThrust, "disconnected engine occupied a diminishing-return position");
assert(half.effectiveThrust > disconnected.effectiveThrust && half.effectiveThrust < 190, "underpowered engine was not weighted individually");

const directional = calculateDirectionalTurnInputs([
  { type: "engine", x: 7, y: 8 }, { type: "gyroscope", x: 7, y: 7 },
  { type: "maneuverThruster", x: 7, y: 4, rotation: 90 }, { type: "maneuverThruster", x: 7, y: 10, rotation: 90 }
], PARTS, { componentMultiplier: (i) => i === 1 || i === 3 ? 0 : 1 });
assert.equal(directional.gyroscopeTurn, 0, "disconnected gyroscope contributed turn");
assert.notEqual(directional.clockwiseManeuverTurn, directional.anticlockwiseManeuverTurn, "directional thrusters did not scale independently");

// Data grouping follows physical conductor cells; legacy route ordering does
// not participate in canonical derived identities.
const design = [{ type: "fireControl", x: 0, y: 0 }, { type: "frame", x: 1, y: 0 }, { type: "blaster", x: 2, y: 0 },
  { type: "frame", x: 0, y: 1 }, { type: "blaster", x: 0, y: 2 },
  { type: "sensorArray", x: 5, y: 5 }, { type: "frame", x: 6, y: 5 }, { type: "beamEmitter", x: 7, y: 5 }];
let wiring = WiringRules.emptyWiring();
wiring = WiringRules.addConnection(wiring, "data", 0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], design, PARTS);
wiring = WiringRules.addConnection(wiring, "data", 0, 4, [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }], design, PARTS);
wiring = WiringRules.addConnection(wiring, "data", 5, 7, [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }], design, PARTS);
const a = WiringRules.analyzeWiring(design, wiring, PARTS).data.networks;
const reversed = { ...wiring, data: { ...wiring.data, connections: wiring.data.connections.slice().reverse() } };
const b = WiringRules.analyzeWiring(design, reversed, PARTS).data.networks;
assert.equal(a.length, 2, "separate Data conductors were merged");
assert.deepStrictEqual(a[0].weaponIndices, [2, 4], "all compatible targets touched by the conductor join once");
assert.deepStrictEqual(a.map(n => [n.id, n.label, n.componentIndices]), b.map(n => [n.id, n.label, n.componentIndices]), "Data identities were not deterministic");

console.log("Power runtime hardening verification passed");
