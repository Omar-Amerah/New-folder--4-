"use strict";

// Per-ship movement toggles.
//
// Standing instructions the player can switch off. Each defaults to true, and
// true is exactly how the controller behaved before they existed, so the first
// thing checked here is that a ship which has never been told anything flies
// the same as it always did.
//
//   autoEngage           go after targets nobody ordered you to
//   pursue               go after a target that opens the range again
//
// There was a third, autoTurn, gating whether a stopped ship faced what it was
// engaging. It is gone: which way a parked hull points is now settled by the
// order and the stance rather than by a switch.

const assert = require("assert");
const { movementTestTick } = require("../tools/movementTestTick");
const { computeStats } = require("../src/server/shipStats");
const {
  applyMovementToggles,
  commandShips,
  updateShipMovement,
  updateShipSeparation
} = require("../src/server/movement");
const {
  MOVEMENT_TOGGLE_DEFAULTS,
  MOVEMENT_TOGGLE_KEYS,
  sanitizeMovementToggles
} = require("../src/server/validation");
const { validateClientMessage } = require("../src/server/clientSchemas");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower, effectiveShieldStats } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { createGeneratedPowerWiring } = require("../src/server/shipDesign");
const { computeDesignCollisionRadius } = require("../src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");
const { getMaxEffectiveWeaponRange } = require("../src/server/componentData");

const DT = 1 / 30;

const GUNSHIP = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];
// A heavier hull, so a mixed group has a slowest member worth pacing to.
const HEAVY = (() => {
  const modules = [
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "reactor" },
    { x: 7, y: 8, type: "engine" },
    { x: 6, y: 7, type: "blaster" }
  ];
  // Bulk, not plate. Armour carries a turn penalty per cell and enough of it
  // takes the hull's turn rate to exactly zero, which leaves a ship that cannot
  // steer at all rather than one that is merely slow.
  for (let x = 4; x <= 10; x += 1) {
    for (const y of [5, 6]) modules.push({ x, y, type: "frame" });
  }
  return modules;
})();
const UNARMED = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let shipSeq = 0;

function makeShip(x, y, angle = 0, design = GUNSHIP, ownerId = "p1", toggles = null) {
  const stats = computeStats(design);
  const ship = {
    id: `s${String(++shipSeq).padStart(3, "0")}`,
    ownerId,
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
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold",
    weaponAngles: [],
    weaponCooldowns: [],
    desiredAngles: [],
    aimTargetIds: [],
    componentTargetIds: [],
    beamContacts: []
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  const shield = effectiveShieldStats(ship);
  ship.maxShield = Math.max(0, shield.capacity);
  ship.shield = ship.maxShield;
  initShipHeat(ship);
  if (toggles) applyMovementToggles(ship, toggles);
  return ship;
}

function makeScenario(groups) {
  const players = new Map();
  const ships = [];
  for (const [id, list] of Object.entries(groups)) {
    players.set(id, { id, team: id === "p1" ? "A" : "B", ships: list });
    ships.push(...list);
  }
  const room = {
    world: { width: 14000, height: 10000 },
    map: { asteroids: [] },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    effects: []
  };
  buildRoomSpatialIndex(room, ships, 0);
  return { room, ships, players };
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = tick * DT * 1000;
    movementTestTick(room, ships, DT, now);
    if (onTick) onTick(tick, now);
  }
}

const speedOf = (ship) => Math.hypot(ship.vx, ship.vy);
const rangeTo = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function facingError(ship, target) {
  let delta = ship.angle - Math.atan2(target.y - ship.y, target.x - ship.x);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

function run() {
  // --- Defaults and sanitizing ---------------------------------------------
  {
    for (const key of MOVEMENT_TOGGLE_KEYS) {
      assert.strictEqual(MOVEMENT_TOGGLE_DEFAULTS[key], true,
        `${key} must default to on, so adding toggles changes nothing on its own`);
    }
    // A partial request keeps everything it did not mention.
    const merged = sanitizeMovementToggles({ pursue: false }, MOVEMENT_TOGGLE_DEFAULTS);
    assert.strictEqual(merged.pursue, false, "the named toggle changes");
    assert.strictEqual(merged.autoEngage, true, "...and the rest are left alone");
    // Junk in, defaults out.
    assert.deepStrictEqual(sanitizeMovementToggles(null), { ...MOVEMENT_TOGGLE_DEFAULTS });
    assert.deepStrictEqual(sanitizeMovementToggles("nonsense"), { ...MOVEMENT_TOGGLE_DEFAULTS });
    assert.strictEqual(sanitizeMovementToggles({ autoEngage: "yes" }).autoEngage, true,
      "values are coerced to booleans rather than stored raw");

    // applyMovementToggles merges onto what the ship already had.
    const ship = makeShip(0, 0);
    applyMovementToggles(ship, { autoEngage: false });
    applyMovementToggles(ship, { pursue: false });
    assert.strictEqual(ship.movementToggles.autoEngage, false, "an earlier toggle survives a later one");
    assert.strictEqual(ship.movementToggles.pursue, false);
  }

  // --- The wire schema rejects nonsense -------------------------------------
  {
    const check = (message) => validateClientMessage(message);
    assert.strictEqual(check({ type: "setMovementToggles", toggles: { autoEngage: false }, shipIds: ["a"] }).ok, true);
    assert.strictEqual(check({ type: "setMovementToggles", toggles: { madeUp: false }, shipIds: ["a"] }).code,
      "invalid-toggles", "an unknown toggle name is refused");
    assert.strictEqual(check({ type: "setMovementToggles", toggles: { autoEngage: 1 }, shipIds: ["a"] }).code,
      "invalid-toggles", "a non-boolean value is refused");
    assert.strictEqual(check({ type: "setMovementToggles", toggles: { autoEngage: false } }).code,
      "invalid-selection", "a request naming no ships is refused");
  }

  // --- The message actually reaches the ship --------------------------------
  {
    // Driven through the real router rather than by calling the setter, so the
    // wire name, the selection rules and the acknowledgement are all covered.
    const { handleMessage } = require("../src/server/messageRouter");
    const mine = makeShip(1000, 2000);
    const other = makeShip(1400, 2000);
    // The static half of a snapshot serializes the player's own design, so the
    // fixture needs a real one.
    const player = {
      id: "p1",
      team: "A",
      ships: [mine, other],
      combatStyle: "hold",
      design: GUNSHIP.map((part) => ({ ...part })),
      stats: computeStats(GUNSHIP)
    };
    const room = {
      phase: "active",
      world: { width: 8000, height: 6000 },
      map: { asteroids: [] },
      ships: new Map([[mine.id, mine], [other.id, other]]),
      players: new Map([["p1", player]]),
      stations: [],
      stationsById: new Map(),
      drones: new Map(),
      effects: [],
      // The handler broadcasts a snapshot on success, so the room has to be
      // complete enough to serialize.
      bullets: [],
      points: [],
      rules: { gameMode: "teams" },
      clients: new Set()
    };
    // The outbound path writes MessagePack frames to a socket, so the stub just
    // records that something went back rather than decoding it.
    const writes = [];
    const client = {
      player,
      room,
      isClosed: false,
      // The router refuses anything from a connection that is not the player's
      // current attachment, so the fixture has to be one.
      attachmentId: 1,
      socket: { readyState: 1, destroyed: false, write: (frame) => { writes.push(frame); return true; }, once() {} }
    };
    player.client = client;
    player.attachmentId = 1;
    room.clients.add(client);

    handleMessage(client, {
      type: "setMovementToggles",
      requestId: "r1",
      toggles: { autoEngage: false },
      shipIds: [mine.id]
    });

    assert(writes.length > 0, "the router should answer the request");
    assert(!client.isClosed, "...without tearing the connection down");
    assert.strictEqual(mine.movementToggles.autoEngage, false, "the named ship is changed");
    assert.strictEqual(mine.movementToggles.pursue, true, "...and its other toggles are left alone");
    assert.notStrictEqual(other.movementToggles?.autoEngage, false,
      "a ship that was not named must not be changed");
  }

  // --- there is no autoTurn toggle ------------------------------------------
  {
    // Facing what you are engaging is not optional any more. It is decided by
    // the order and the stance -- see verify-movement-arrival-heading -- and a
    // switch that could only ever turn the default off had nothing left to do.
    assert(!MOVEMENT_TOGGLE_KEYS.includes("autoTurn"), "autoTurn is not a toggle");
    assert.strictEqual(MOVEMENT_TOGGLE_DEFAULTS.autoTurn, undefined,
      "...and carries no default");
    assert.strictEqual(sanitizeMovementToggles({ autoTurn: false }).autoTurn, undefined,
      "a client that still sends it gets it dropped rather than stored");
    assert.strictEqual(
      validateClientMessage({ type: "setMovementToggles", toggles: { autoTurn: false }, shipIds: ["a"] }).code,
      "invalid-toggles", "...and the wire schema refuses the name outright");

    // The behaviour it used to gate is still there, unconditionally.
    const holder = makeShip(1000, 2000, 0, GUNSHIP, "p1");
    const enemy = makeShip(1000, 2400, Math.PI, UNARMED, "p2");
    const { room, ships } = makeScenario({ p1: [holder], p2: [enemy] });
    holder.combatTargetId = enemy.id;
    simulate(room, ships, 30);
    assert(facingError(holder, enemy) < 0.1,
      `a stopped ship still faces what it is engaging (${facingError(holder, enemy).toFixed(3)} rad off)`);
  }

  // --- autoEngage -----------------------------------------------------------
  {
    // A target combat picked out on its own, with no order of any kind.
    const run = (toggles) => {
      const hunter = makeShip(1000, 2000, 0, GUNSHIP, "p1", toggles);
      const enemy = makeShip(2600, 2000, Math.PI, UNARMED, "p2");
      const { room, ships } = makeScenario({ p1: [hunter], p2: [enemy] });
      hunter.combatTargetId = enemy.id;
      const start = { x: hunter.x, y: hunter.y };
      simulate(room, ships, 40);
      return { hunter, enemy, moved: Math.hypot(hunter.x - start.x, hunter.y - start.y) };
    };

    const chasing = run(null);
    assert(chasing.moved > 100,
      `by default a ship closes on a target it acquired itself (moved ${chasing.moved.toFixed(0)} px)`);

    const holding = run({ autoEngage: false });
    assert(holding.moved < 1,
      `with autoEngage off it must not go anywhere (moved ${holding.moved.toFixed(1)} px)`);
    assert(facingError(holding.hunter, holding.enemy) < 0.1,
      "...but it still turns its guns onto what it can see");
  }

  // --- ...and an explicit order still overrides autoEngage ------------------
  {
    const attacker = makeShip(1000, 2000, 0, GUNSHIP, "p1", { autoEngage: false });
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 45);
    assert(rangeTo(attacker, enemy) <= getMaxEffectiveWeaponRange(attacker),
      `an attack the player ordered is an order, not an automatic target (${rangeTo(attacker, enemy).toFixed(0)} px)`);
  }

  // --- pursue ---------------------------------------------------------------
  {
    const run = (toggles) => {
      const attacker = makeShip(1000, 2000, 0, GUNSHIP, "p1", toggles);
      const enemy = makeShip(4000, 2000, 0, UNARMED, "p2");
      const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
      commandShips(room, players.get("p1"), enemy.x, enemy.y, {
        shipIds: [attacker.id],
        targetId: enemy.id
      });
      simulate(room, ships, 45);
      assert(speedOf(attacker) < 3, "sanity: established before the target runs");
      const parked = { x: attacker.x, y: attacker.y };

      // The target runs well clear, under its own orders.
      commandShips(room, players.get("p2"), enemy.x + 3000, enemy.y, { shipIds: [enemy.id] });
      simulate(room, ships, 60);
      return { attacker, enemy, followed: Math.hypot(attacker.x - parked.x, attacker.y - parked.y) };
    };

    const chasing = run(null);
    assert(chasing.followed > 500,
      `by default the ship follows a target that has run out of range (${chasing.followed.toFixed(0)} px)`);

    const standing = run({ pursue: false });
    assert(standing.followed < 20,
      `with pursue off it should let the target go (${standing.followed.toFixed(0)} px)`);
  }

  // --- independent formation speed -----------------------------------------
  {
    // One fast hull and one slow one, sent to the same place together.
    const run = (toggles) => {
      const fast = makeShip(1000, 2000, 0, GUNSHIP, "p1", toggles);
      const slow = makeShip(1000, 2200, 0, HEAVY, "p1", toggles);
      assert(fast.stats.maxSpeed > slow.stats.maxSpeed * 1.1,
        `the fixtures should differ in pace (${fast.stats.maxSpeed.toFixed(0)} vs ${slow.stats.maxSpeed.toFixed(0)})`);
      const { room, ships, players } = makeScenario({ p1: [fast, slow] });
      commandShips(room, players.get("p1"), 8000, 2100, { shipIds: [fast.id, slow.id] });
      let peak = 0;
      simulate(room, ships, 30, () => {
        peak = Math.max(peak, speedOf(fast));
      });
      return { peak, pace: slow.stats.maxSpeed, own: fast.stats.maxSpeed };
    };

    // Formation slots do not impose a shared throttle. The fast hull keeps its
    // own speed envelope even when the same order also contains a heavy hull.
    const defaultRun = run(null);
    assert(defaultRun.peak > defaultRun.pace + 20,
      `the fast hull should retain its own pace (${defaultRun.peak.toFixed(0)} px/s against a slow hull at ${defaultRun.pace.toFixed(0)})`);

    // Bounded generously against the *design* figure, because the runtime one
    // is the design figure after power allocation and command auras have had
    // their say and runs a little above it.
    assert(defaultRun.peak <= defaultRun.own * 1.2,
      `...and no faster than its own hull allows (${defaultRun.peak.toFixed(0)} px/s against a rated ${defaultRun.own.toFixed(0)})`);
  }

  console.log("verify-movement-toggles: OK");
}

run();
