"use strict";

const assert = require("assert");
const { commandShips, createMovementIntent, updateShipMovement } = require("../src/server/movement");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { createGeneratedPowerWiring } = require("../src/server/shipDesign");
const { getVisibilityState } = require("../src/server/visibility");

const DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

function attacker(style) {
  const stats = computeStats(DESIGN);
  const ship = {
    id: `attacker-${style}`,
    ownerId: "p1",
    team: "blue",
    alive: true,
    x: 300,
    y: 500,
    vx: 0,
    vy: 0,
    angle: 0,
    targetX: 300,
    targetY: 500,
    combatStyle: style,
    radius: stats.radius,
    design: DESIGN.map((module) => ({ ...module })),
    wiring: createGeneratedPowerWiring(DESIGN),
    stats
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

for (const style of ["charge", "hold", "orbit", "kite", "static"]) {
  const ship = attacker(style);
  if (style === "static") ship.angle = Math.PI / 2;
  const player = { id: "p1", team: "blue", ships: [ship] };
  const enemy = { id: "p2", team: "red", ships: [] };
  const relay = {
    id: `relay-${style}`,
    entityType: "station",
    stationType: "relay",
    ownerId: null,
    team: enemy.team,
    alive: true,
    state: "operational",
    x: 2100,
    y: 500,
    vx: 0,
    vy: 0,
    radius: 128,
    design: []
  };
  const room = {
    world: { width: 2200, height: 1700 },
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams", visibilityMode: "sensors" },
    ships: new Map([[ship.id, ship]]),
    stations: [relay],
    stationsById: new Map([[relay.id, relay]]),
    players: new Map([[player.id, player], [enemy.id, enemy]])
  };

  assert.strictEqual(
    getVisibilityState(room, player.team, relay.id, 1000),
    "hidden",
    `${style}: relay begins outside live sensor coverage`
  );
  const result = commandShips(room, player, relay.x, relay.y, {
    shipIds: [ship.id],
    targetId: relay.id
  });
  assert.strictEqual(result.code, "attack", `${style}: relay is accepted as an attack target`);
  assert.strictEqual(ship.focusTargetId, relay.id, `${style}: relay remains the focus target`);
  assert.strictEqual(ship.combatTargetId, relay.id, `${style}: relay remains the combat target`);
  assert.strictEqual(ship.movement?.command?.targetId, relay.id, `${style}: relay attack order is retained`);
  const intent = createMovementIntent(room, ship, ship.stats, 1000);
  assert.strictEqual(intent.type, style === "static" ? "station" : style,
    `${style}: relay attack uses the selected movement style`);
  assert.strictEqual(intent.facingTargetId, relay.id, `${style}: movement faces the relay`);
  if (style === "static") {
    const startingAngle = ship.angle;
    for (let tick = 0; tick < 30; tick += 1) {
      updateShipMovement(room, ship, 1 / 30, 1000 + tick * 1000 / 30);
    }
    assert(
      Math.abs(ship.angle) < Math.abs(startingAngle),
      "static ships rotate toward hostile stations without leaving their position"
    );
  }
}

console.log("Relay attack movement-style verification passed");
