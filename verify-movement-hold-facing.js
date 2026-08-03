"use strict";

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { PARTS } = require("./src/server/components");
const HeatRules = require("./public/src/shared/heatRules");
const {
  chooseHoldWeaponFacing,
  isTargetInWeaponArc,
  updateShipWeapons
} = require("./src/server/combat");
const { commandShips, updateShipMovement } = require("./src/server/movement");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
const BLASTER = { x: 6, y: 7, type: "blaster", rotation: 0 };
const UNARMED = BASE.map((module) => ({ ...module }));
let sequence = 0;

function makeShip(x, y, design, ownerId, angle = 0) {
  const stats = computeStats(design);
  const ship = {
    id: `hold-facing-${++sequence}`,
    ownerId,
    team: ownerId === "p1" ? "A" : "B",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: computeDesignCollisionRadius(design, stats),
    design: design.map((module) => ({ ...module })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold",
    combatStyleRaw: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  if (!ship.componentPowerState) ship.componentPowerState = new Array(design.length).fill(1);
  return ship;
}

function makeRoom(attacker, target) {
  const room = {
    world: { width: 9000, height: 6000 },
    map: { asteroids: [], revision: 1 },
    ships: new Map([[attacker.id, attacker], [target.id, target]]),
    players: new Map([
      ["p1", { id: "p1", team: "A", ships: [attacker] }],
      ["p2", { id: "p2", team: "B", ships: [target] }]
    ]),
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1
  };
  buildRoomSpatialIndex(room, [attacker, target], 0);
  return room;
}

function angleDelta(a, b) {
  let delta = (a || 0) - (b || 0);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function weaponAt(ship, index) {
  const module = ship.design[index];
  const weapon = PARTS[module.type].weapon;
  return { module, arcRadians: (weapon.arc || 360) * Math.PI / 180 };
}

function assertUsableFacing(result, ship, target, index, message) {
  assert(result.score > 0, message);
  const weapon = weaponAt(ship, index);
  assert(isTargetInWeaponArc(ship, weapon.module, target, weapon.arcRadians, result.heading),
    `${message}: selected hull heading must leave the weapon in its fixed arc`);
}

function simulate(room, ships, seconds) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const ship of ships) movementTestTick(room, [ship], DT, tick * DT * 1000);
  }
}

function run() {
  // Forward, rear and broadside fixed weapons all choose a usable hull heading.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2400, 2000, UNARMED, "p2");
    const room = makeRoom(ship, target);
    const forward = chooseHoldWeaponFacing(room, ship, target, 0);
    assertUsableFacing(forward, ship, target, 3, "forward target should be fireable");
    assert(Math.abs(angleDelta(forward.heading, 0)) < 0.2,
      "a forward fixed weapon should preserve the current forward heading");

    target.x = 1600;
    const rear = chooseHoldWeaponFacing(room, ship, target, 0);
    assertUsableFacing(rear, ship, target, 3, "rear target should be fireable");
    assert(Math.abs(angleDelta(rear.heading, 0)) > 0.5,
      "a rear target should cause a stable hull turn");

    const broadsideDesign = [...BASE, { ...BLASTER, rotation: 90 }];
    const broadsideShip = makeShip(2000, 2000, broadsideDesign, "p1");
    const broadsideTarget = makeShip(2400, 2000, UNARMED, "p2");
    const broadsideRoom = makeRoom(broadsideShip, broadsideTarget);
    const broadside = chooseHoldWeaponFacing(broadsideRoom, broadsideShip, broadsideTarget, 0);
    assertUsableFacing(broadside, broadsideShip, broadsideTarget, 3, "broadside target should be fireable");
    assert(Math.abs(angleDelta(broadside.heading, 0)) > 0.2,
      "a side-mounted weapon should not force the hull to keep its unusable heading");
  }

  // Coverage is scored across the whole weapon group, while wide-arc weapons
  // do not pull a hull away from its existing heading unnecessarily.
  {
    const mixedDesign = [
      ...BASE,
      { x: 6, y: 7, type: "blaster", rotation: 0 },
      { x: 7, y: 6, type: "missile", rotation: 0 }
    ];
    const ship = makeShip(2000, 2000, mixedDesign, "p1");
    const target = makeShip(2400, 2000, UNARMED, "p2");
    const room = makeRoom(ship, target);
    const mixed = chooseHoldWeaponFacing(room, ship, target, 0);
    assert.strictEqual(mixed.weaponCount, 2, "Hold should maximize coverage across both offensive weapons");
    assert(mixed.score > 30, "the facing score should include the expected DPS of both weapons");

    const wideDesign = [...BASE, { x: 6, y: 7, type: "missile", rotation: 0 }];
    const wideShip = makeShip(2000, 2000, wideDesign, "p1");
    const wideTarget = makeShip(2000, 2400, UNARMED, "p2");
    const wideRoom = makeRoom(wideShip, wideTarget);
    const wide = chooseHoldWeaponFacing(wideRoom, wideShip, wideTarget, 0);
    assertUsableFacing(wide, wideShip, wideTarget, 3, "a wide-arc offensive weapon should cover a side target");
    assert(Math.abs(wide.heading) < 0.2,
      "a wide-arc weapon should not turn the hull when the current heading already covers the target");

    const defensiveDesign = [
      ...BASE,
      { x: 6, y: 7, type: "blaster", rotation: 0 },
      { x: 7, y: 6, type: "interceptorPod", rotation: 0 }
    ];
    const defensiveShip = makeShip(2000, 2000, defensiveDesign, "p1");
    const defensiveTarget = makeShip(2400, 2000, UNARMED, "p2");
    const defensiveRoom = makeRoom(defensiveShip, defensiveTarget);
    const defensive = chooseHoldWeaponFacing(defensiveRoom, defensiveShip, defensiveTarget, 0);
    assert.strictEqual(defensive.weaponCount, 1,
      "point-defence weapons must not be counted as offensive Hold coverage");
  }

  // Destroyed, unpowered and overheated weapons are removed from the facing
  // score, just as they are removed from the firing path.
  {
    const design = [
      ...BASE,
      { x: 6, y: 7, type: "blaster", rotation: 0 },
      { x: 7, y: 6, type: "missile", rotation: 0 }
    ];
    const ship = makeShip(2000, 2000, design, "p1");
    const target = makeShip(2400, 2000, UNARMED, "p2");
    const room = makeRoom(ship, target);
    assert.strictEqual(chooseHoldWeaponFacing(room, ship, target, 0).weaponCount, 2);

    ship.componentHp[3] = 0;
    ship.componentAliveRevision = (ship.componentAliveRevision || 1) + 1;
    assert.strictEqual(chooseHoldWeaponFacing(room, ship, target, 0).weaponCount, 1,
      "destroyed weapons must not influence Hold facing");

    ship.componentPowerState[4] = 0;
    ship.powerRevision = (ship.powerRevision || 1) + 1;
    assert.strictEqual(chooseHoldWeaponFacing(room, ship, target, 0).weaponCount, 0,
      "unpowered weapons must not influence Hold facing");

    const hotShip = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const hotTarget = makeShip(2400, 2000, UNARMED, "p2");
    const hotRoom = makeRoom(hotShip, hotTarget);
    hotShip.componentHeatState[3] = HeatRules.STATE.OVERHEATED;
    hotShip.heatStateRevision = (hotShip.heatStateRevision || 1) + 1;
    assert.strictEqual(chooseHoldWeaponFacing(hotRoom, hotShip, hotTarget, 0).weaponCount, 0,
      "overheated weapons must not influence Hold facing");
  }

  // A Hold ship latches its world position. Closer or sideways target motion,
  // and a cooldown transition, must not make it reacquire a translation slot or
  // change the cached hull decision.
  {
    const attacker = makeShip(1000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(1400, 2000, UNARMED, "p2");
    const room = makeRoom(attacker, target);
    const command = commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [attacker.id],
      targetId: target.id
    });
    assert.strictEqual(command.code, "attack");
    simulate(room, [attacker], 1);
    const parked = { x: attacker.x, y: attacker.y };
    const facing = attacker.movement.holdFacing?.heading;
    assert(attacker.movement.holdEngaged, "the close target should latch Hold immediately");
    assert(Number.isFinite(facing), "a parked Hold ship should publish a facing decision");

    target.y += 80;
    simulate(room, [attacker], 1);
    assert(Math.hypot(attacker.x - parked.x, attacker.y - parked.y) < 12,
      "sideways target motion inside the hysteresis band must not move Hold");
    attacker.weaponCooldowns = new Array(attacker.design.length).fill(9000);
    simulate(room, [attacker], 1);
    assert(Math.abs(angleDelta(attacker.movement.holdFacing.heading, facing)) < 1e-6,
      "cooldown must not cause a new Hold hull orientation");

    target.x = attacker.x + 220;
    target.y = attacker.y;
    simulate(room, [attacker], 1);
    assert(Math.hypot(attacker.x - parked.x, attacker.y - parked.y) < 12,
      "a closer target must never make Hold retreat or reacquire a position");
  }

  // Once the stationary Hold decision is made, the normal combat path can fire
  // without waiting for a formation or firing-rank transition.
  {
    const attacker = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2450, 2000, UNARMED, "p2");
    const room = makeRoom(attacker, target);
    attacker.focusTargetId = target.id;
    attacker.combatTargetId = target.id;
    attacker.weaponCooldowns = new Array(attacker.design.length).fill(0);
    attacker.weaponAngles = new Array(attacker.design.length).fill(0);
    attacker.weaponAcquiredTargetIds = new Array(attacker.design.length).fill(null);
    attacker.weaponAcquiredTargetIds[3] = target.id;
    updateShipMovement(room, attacker, DT, 0);
    assert(attacker.movement.holdEngaged, "the firing test should begin in Hold position");
    updateShipWeapons(room, attacker, [attacker, target], 1 / 30, 1000);
    assert(room.bullets.length > 0, "a valid Hold orientation should reach the ordinary firing path");
  }

  console.log("verify-movement-hold-facing: OK");
}

run();
