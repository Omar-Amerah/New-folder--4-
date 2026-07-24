// Regression coverage for Beam Emitter nearest-blocker resolution.
//
// A single beam ray must damage only the NEAREST valid blocking entity across a
// unified, ordered candidate list (asteroids, active shield bubbles, living ship
// components, living drones). It must never damage a second ship or drone behind
// the first blocker. Burn-through may still carry excess damage into at most one
// further component INSIDE the single nearest ship.

const assert = require("assert");
const { damageBeamTargets } = require("./src/server/combat");
const { initComponentState } = require("./src/server/componentHealth");

function createRoom() {
  return {
    nextEntityId: 100,
    map: { safeZones: [], asteroids: [] },
    ships: new Map(),
    bullets: [],
    drones: new Map(),
    effects: [],
    // No rules => team mode; blue vs red are enemies.
    players: new Map([
      ["p1", { id: "p1", team: "blue", ships: [] }],
      ["p2", { id: "p2", team: "red", ships: [] }]
    ])
  };
}

function makeShip(id, ownerId, x, y, { shield = 0, design = null } = {}) {
  const d = design || [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }
  ];
  const ship = {
    id, ownerId, x, y, vx: 0, vy: 0, angle: 0,
    alive: true, removed: false,
    hp: 100, maxHp: 100, radius: 40,
    shield, maxShield: shield,
    design: d,
    stats: { maxHp: 100, radius: 40, unitCost: 100, weaponDps: 20 },
    componentPower: { byComponentIndex: d.map(() => ({ operationalMultiplier: 1 })) }
  };
  initComponentState(ship);
  return ship;
}

function makeDrone(id, ownerId, x, y) {
  return { id, ownerId, x, y, radius: 10, hull: 40, maxHull: 40, destroyed: false };
}

const shooter = () => makeShip("shooter", "p1", 0, 0);

// A ship is "damaged" if its hull hp dropped or any component lost HP (core hits
// only reduce the core component's HP, not ship.hp).
function isDamaged(ship) {
  return ship.hp < 100 || ship.componentHp.some((hp, i) => hp < ship.componentMaxHp[i]);
}
function isIntact(ship) {
  return ship.hp === 100 && ship.componentHp.every((hp, i) => hp === ship.componentMaxHp[i]);
}

// 1. Beam -> Ship A -> Ship B: only the nearer ship is damaged.
(function beamShipShip() {
  const room = createRoom();
  const s = shooter();
  const a = makeShip("A", "p2", 200, 0);
  const b = makeShip("B", "p2", 400, 0);
  room.ships = new Map([["shooter", s], ["A", a], ["B", b]]);
  const result = damageBeamTargets(room, s, [a, b], 0, 0, 1000, 0, 0, 30, 1000, {});
  assert.ok(isDamaged(a), "nearer ship A should take beam damage");
  assert.ok(isIntact(b), "farther ship B must be shielded by A and take no damage");
  assert.ok(result && result.firstHitIndex >= 0, "beam should report a component contact on A");
  console.log("PASS: beam damages only the nearest ship (A), not the ship behind it (B)");
})();

// 2. Beam -> Drone -> Ship: only the drone is damaged.
(function beamDroneShip() {
  const room = createRoom();
  const s = shooter();
  const ship = makeShip("A", "p2", 300, 0);
  const drone = makeDrone("d1", "p2", 150, 0);
  room.ships = new Map([["shooter", s], ["A", ship]]);
  room.drones = new Map([["d1", drone]]);
  damageBeamTargets(room, s, [ship], 0, 0, 1000, 0, 0, 30, 1000, {});
  assert.ok(drone.hull < 40, "drone in front should absorb the beam");
  assert.ok(isIntact(ship), "ship behind the drone must be protected");
  console.log("PASS: a drone in front of a ship absorbs the beam and protects the ship");
})();

// 3. Beam -> Asteroid -> Ship: nothing behind the asteroid is damaged.
(function beamAsteroidShip() {
  const room = createRoom();
  const s = shooter();
  const ship = makeShip("A", "p2", 300, 0);
  room.ships = new Map([["shooter", s], ["A", ship]]);
  room.map.asteroids = [{ id: "rock", x: 150, y: 0, radius: 30 }];
  const result = damageBeamTargets(room, s, [ship], 0, 0, 1000, 0, 0, 30, 1000, {});
  assert.ok(isIntact(ship), "asteroid must block damage to the ship behind it");
  assert.ok(result && result.firstHitIndex === -1, "asteroid contact reports no component index");
  assert.ok(result.hitX <= 150 + 30 + 1, "visible beam stops at the asteroid");
  console.log("PASS: an asteroid blocks both damage and the visible beam");
})();

// 4. Beam -> Shielded ship -> unshielded ship: only the first shield is damaged.
(function beamShieldedThenUnshielded() {
  const room = createRoom();
  const s = shooter();
  const a = makeShip("A", "p2", 200, 0, { shield: 200 });
  const b = makeShip("B", "p2", 400, 0);
  room.ships = new Map([["shooter", s], ["A", a], ["B", b]]);
  damageBeamTargets(room, s, [a, b], 0, 0, 1000, 0, 0, 30, 1000, {});
  assert.ok(a.shield < 200, "the nearer shielded ship's shield takes the hit");
  assert.ok(isIntact(b), "the unshielded ship behind must take no damage");
  console.log("PASS: only the first shielded ship's shield is damaged; the ship behind is untouched");
})();

// A design whose core sits off the +x beam line (grid x=8 => local +y), so the
// first two cells the ray at y=shipY crosses are the two frames at grid x=7.
// index1 = frame(7,6) (nearer), index2 = frame(7,5) (farther).
const BURN_DESIGN = [
  { type: "core", x: 8, y: 7, rotation: 0 },
  { type: "frame", x: 7, y: 6, rotation: 0 },
  { type: "frame", x: 7, y: 5, rotation: 0 }
];

// 5. Beam -> component A -> component B inside one ship: burn-through works.
(function beamBurnThroughInsideShip() {
  const room = createRoom();
  const s = shooter();
  const target = makeShip("A", "p2", 200, 0, { design: BURN_DESIGN.map((m) => ({ ...m })) });
  // Weaken the two front frames so a single strong tick destroys the first and
  // burns into the second.
  target.componentHp[1] = 5;
  target.componentHp[2] = 5;
  room.ships = new Map([["shooter", s], ["A", target]]);
  const before2 = target.componentHp[2];
  damageBeamTargets(room, s, [target], 0, 0, 1000, 0, 0, 60, 1000, { burnThroughCarryMultiplier: 1 });
  assert.strictEqual(target.componentHp[1], 0, "first frame hit is destroyed");
  assert.ok(target.componentHp[2] < before2, "burn-through carries into the second component inside the same ship");
  console.log("PASS: beam burn-through carries into one further component inside the same ship");
})();

// 6. Beam -> component A -> component B -> another ship: damage stops after the
//    permitted internal penetration (never reaches the ship behind).
(function beamBurnThroughNeverReachesSecondShip() {
  const room = createRoom();
  const s = shooter();
  const front = makeShip("A", "p2", 200, 0, { design: BURN_DESIGN.map((m) => ({ ...m })) });
  front.componentHp[1] = 1;
  front.componentHp[2] = 1;
  const behind = makeShip("B", "p2", 400, 0);
  room.ships = new Map([["shooter", s], ["A", front], ["B", behind]]);
  damageBeamTargets(room, s, [front, behind], 0, 0, 1000, 0, 0, 500, 1000, { burnThroughCarryMultiplier: 1 });
  assert.ok(isIntact(behind), "burn-through must never continue into a second ship");
  console.log("PASS: burn-through never continues into another ship behind the target");
})();

// 7. Equal-distance candidates use a deterministic tie-break.
(function beamTieBreakDeterministic() {
  function run() {
    const room = createRoom();
    const s = shooter();
    // Two drones at the same ray parameter (same projected x), symmetric in y.
    const d1 = makeDrone("dA", "p2", 200, 6);
    const d2 = makeDrone("dB", "p2", 200, -6);
    room.ships = new Map([["shooter", s]]);
    room.drones = new Map([["dA", d1], ["dB", d2]]);
    damageBeamTargets(room, s, [], 0, 0, 1000, 0, 0, 30, 1000, {});
    return { d1: d1.hull, d2: d2.hull };
  }
  const first = run();
  const second = run();
  assert.deepStrictEqual(first, second, "equal-distance tie-break must be deterministic across runs");
  assert.ok(first.d1 !== first.d2, "exactly one of the tied candidates is resolved");
  console.log("PASS: equal-distance collision candidates use a deterministic tie-break");
})();

console.log("\nBEAM NEAREST-ENTITY REGRESSION TESTS PASSED");
