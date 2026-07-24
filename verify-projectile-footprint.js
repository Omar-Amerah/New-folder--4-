// Regression coverage for footprint-aware projectile/component collision.
//
// Projectile collision must test the swept segment against every occupied grid
// cell of each live component (using its authoritative footprint + normalized
// rotation), not just its anchor tile. A multi-cell component is damaged once,
// destroyed cells stop blocking, shields resolve before hull components, and the
// projectile and beam collision paths share the same geometry helper.

const assert = require("assert");
const { getShipComponentCellWorldCoords, COMPONENT_CELL_COLLISION_RADIUS } = require("./src/server/componentGeometry");
const { getOccupiedCells } = require("./src/server/footprint");
const { PARTS } = require("./src/server/components");
const { segmentCircleHit, updateBullets, addBullet, SHIELD_HIT_MIN } = require("./src/server/projectiles");
const { findBeamRayIntersections } = require("./src/server/combat");
const { initComponentState } = require("./src/server/componentHealth");

function createRoom() {
  return {
    nextEntityId: 1,
    world: { width: 4000, height: 4000 },
    map: { safeZones: [], asteroids: [] },
    ships: new Map(),
    bullets: [],
    drones: new Map(),
    effects: [],
    players: new Map([
      ["p1", { id: "p1", team: "blue", ships: [], kills: 0, losses: 0, money: 0, earned: 0, score: 0, destroyedEnemyCost: 0, lostFleetCost: 0 }],
      ["p2", { id: "p2", team: "red", ships: [], kills: 0, losses: 0, money: 0, earned: 0, score: 0, destroyedEnemyCost: 0, lostFleetCost: 0 }]
    ])
  };
}

function makeShip(id, ownerId, x, y, design, { shield = 0, angle = 0 } = {}) {
  const ship = {
    id, ownerId, x, y, vx: 0, vy: 0, angle,
    alive: true, removed: false,
    hp: 500, maxHp: 500, radius: 60,
    shield, maxShield: shield,
    design,
    stats: { maxHp: 500, radius: 60, unitCost: 100 },
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) }
  };
  initComponentState(ship);
  return ship;
}

// World coordinate of a single grid cell, using the same transform as the
// shared helper (7,7 is grid centre, module scale 13).
function cellWorld(ship, cx, cy) {
  const cos = Math.cos(ship.angle || 0);
  const sin = Math.sin(ship.angle || 0);
  const lx = (7 - cy) * 13;
  const ly = (cx - 7) * 13;
  return { x: ship.x + lx * cos - ly * sin, y: ship.y + lx * sin + ly * cos };
}

// Mirror of the projectile per-cell collision loop (uses the shared helper), so
// this test exercises exactly the geometry the real collision path uses.
function projectileComponentHit(ship, x1, y1, x2, y2, hitRadius = 6) {
  const cellCoords = getShipComponentCellWorldCoords(ship);
  const componentHp = ship.componentHp;
  const collisionR = COMPONENT_CELL_COLLISION_RADIUS + hitRadius;
  let hit = null;
  for (let i = 0; i < cellCoords.length; i++) {
    if (componentHp && componentHp[i] <= 0) continue;
    for (const cell of cellCoords[i]) {
      const h = segmentCircleHit(x1, y1, x2, y2, cell.x, cell.y, collisionR);
      if (h && (!hit || h.t < hit.t || (h.t === hit.t && i < hit.index))) hit = { ...h, index: i };
    }
  }
  return hit;
}

// 1. A projectile crossing the far cell of a 2x2 component hits it (an
//    anchor-only model would have missed the non-anchor cells).
(function farCellOfTwoByTwo() {
  assert.deepStrictEqual(PARTS.aegisProjector.footprint, { width: 2, height: 2 }, "aegisProjector is 2x2");
  const design = [{ type: "core", x: 0, y: 0, rotation: 0 }, { type: "aegisProjector", x: 6, y: 6, rotation: 0 }];
  const ship = makeShip("t", "p2", 0, 0, design);
  // Cells occupied by the 2x2 at anchor (6,6): (6,6),(7,6),(6,7),(7,7).
  const anchor = cellWorld(ship, 6, 6);
  const farCell = cellWorld(ship, 7, 7); // diagonally-opposite cell from the anchor
  // A tiny segment centred on the far cell must register a hit on component 1.
  const hit = projectileComponentHit(ship, farCell.x - 1, farCell.y, farCell.x + 1, farCell.y);
  assert.ok(hit && hit.index === 1, "projectile crossing the far cell of the 2x2 hits it");
  // Sanity: the far cell is genuinely far from the anchor cell.
  assert.ok(Math.hypot(farCell.x - anchor.x, farCell.y - anchor.y) > 13, "far cell is distinct from anchor cell");
  console.log("PASS: a projectile crossing the far cell of a 2x2 component hits it");
})();

// 2. A projectile crossing empty space beside the anchor does not falsely hit.
(function emptySpaceBesideAnchor() {
  const design = [{ type: "core", x: 0, y: 0, rotation: 0 }, { type: "reactor", x: 7, y: 7, rotation: 0 }];
  const ship = makeShip("t", "p2", 0, 0, design);
  // reactor is 2x1 => cells (7,7),(8,7). Aim well outside every occupied cell.
  const empty = cellWorld(ship, 4, 7); // three tiles away from the nearest cell
  const hit = projectileComponentHit(ship, empty.x - 1, empty.y, empty.x + 1, empty.y);
  assert.ok(!hit, "projectile through empty space beside the component does not hit it");
  console.log("PASS: a projectile crossing empty space beside the anchor does not falsely hit");
})();

// 3. Rotated 1x2 and 2x1 components collide correctly on their rotated cells.
(function rotatedComponents() {
  for (const { type, rotation } of [
    { type: "engine", rotation: 90 },   // 1x2 rotated
    { type: "reactor", rotation: 90 },  // 2x1 rotated
    { type: "engine", rotation: 270 }
  ]) {
    const anchorX = 7;
    const anchorY = 7;
    const design = [{ type: "core", x: 0, y: 0, rotation: 0 }, { type, x: anchorX, y: anchorY, rotation }];
    const ship = makeShip("t", "p2", 0, 0, design);
    const expectedCells = getOccupiedCells(anchorX, anchorY, PARTS[type].footprint, rotation);
    // Every occupied cell (including the non-anchor one) must be hittable.
    for (const cell of expectedCells) {
      const w = cellWorld(ship, cell.x, cell.y);
      const hit = projectileComponentHit(ship, w.x - 1, w.y, w.x + 1, w.y);
      assert.ok(hit && hit.index === 1, `${type}@${rotation} occupied cell (${cell.x},${cell.y}) collides`);
    }
  }
  console.log("PASS: rotated 1x2 and 2x1 components collide correctly on all occupied cells");
})();

// 4. The earliest of two components along the path is selected (t, then index).
(function earliestSelected() {
  const design = [
    { type: "core", x: 11, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }, // nearer to a +x ray at y=0
    { type: "frame", x: 7, y: 5, rotation: 0 }  // farther
  ];
  const ship = makeShip("t", "p2", 200, 0, design);
  const hit = projectileComponentHit(ship, 0, 0, 1000, 0);
  assert.ok(hit && hit.index === 1, "the earliest component along the ray is chosen");
  console.log("PASS: the earliest of two components is selected");
})();

// 5. A multi-cell component takes exactly one damage event, not one per cell.
//    (End-to-end through updateBullets: one hp decrement + one dirtyComponents entry.)
(function multiCellDamagedOnce() {
  const room = createRoom();
  const design = [{ type: "core", x: 11, y: 7, rotation: 0 }, { type: "aegisProjector", x: 6, y: 5, rotation: 0 }];
  const ship = makeShip("t", "p2", 200, 0, design);
  room.ships.set("t", ship);
  room.players.get("p2").ships.push(ship);
  ship.dirtyComponents.clear();
  const beforeHp = ship.componentHp[1];
  // Fire a bolt straight along +x through the component's cells in one tick.
  addBullet(room, { type: "bolt", ownerId: "p1", targetId: "t", x: 0, y: 0, vx: 1000, vy: 0, damage: 10, life: 5, bornAt: 0 });
  updateBullets(room, 1, 1000);
  const damaged = beforeHp - ship.componentHp[1];
  assert.ok(damaged > 0 && damaged <= 10 + 1e-6, "multi-cell component takes a single 10-damage event, not one per occupied cell");
  assert.deepStrictEqual([...ship.dirtyComponents], [1], "exactly one component marked damaged");
  assert.strictEqual(room.bullets.length, 0, "the bullet is consumed by the single impact");
  console.log("PASS: a multi-cell component receives one damage event, not one per occupied cell");
})();

// 6. A destroyed front component lets a later projectile reach the one behind it.
(function destroyedFrontComponentPassthrough() {
  const room = createRoom();
  const design = [
    { type: "core", x: 11, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }, // front (nearer to +x ray)
    { type: "frame", x: 7, y: 5, rotation: 0 }  // behind
  ];
  const ship = makeShip("t", "p2", 200, 0, design);
  room.ships.set("t", ship);
  room.players.get("p2").ships.push(ship);
  // Destroy the front frame; its cells must no longer block.
  ship.componentHp[1] = 0;
  ship.dirtyComponents.clear();
  const behindBefore = ship.componentHp[2];
  addBullet(room, { type: "bolt", ownerId: "p1", targetId: "t", x: 0, y: 0, vx: 1000, vy: 0, damage: 10, life: 5, bornAt: 0 });
  updateBullets(room, 1, 1000);
  assert.ok(ship.componentHp[2] < behindBefore, "projectile reaches the component behind the destroyed front one");
  assert.deepStrictEqual([...ship.dirtyComponents], [2], "only the rear component is damaged");
  console.log("PASS: a destroyed front component allows a projectile to reach the component behind it");
})();

// 7. Shielded ships resolve the shield before hull-component collision.
(function shieldBeforeComponents() {
  const room = createRoom();
  const design = [{ type: "core", x: 11, y: 7, rotation: 0 }, { type: "frame", x: 7, y: 6, rotation: 0 }];
  const ship = makeShip("t", "p2", 200, 0, design, { shield: Math.max(50, SHIELD_HIT_MIN + 50) });
  room.ships.set("t", ship);
  room.players.get("p2").ships.push(ship);
  ship.dirtyComponents.clear();
  const shieldBefore = ship.shield;
  addBullet(room, { type: "bolt", ownerId: "p1", targetId: "t", x: 0, y: 0, vx: 1000, vy: 0, damage: 10, life: 5, bornAt: 0 });
  updateBullets(room, 1, 1000);
  // The projectile resolves against the outer shield bubble (before any hull
  // footprint collision): the shield absorbs essentially the whole hit and a
  // shieldhit effect is emitted. (Existing shield mechanics still bleed a small
  // fraction to the hull; that is not a component-collision resolution.)
  const shieldAbsorbed = shieldBefore - ship.shield;
  assert.ok(shieldAbsorbed >= 10 - 1e-6, "the shield absorbs the projectile's shield damage");
  assert.ok(room.effects.some((e) => e.type === "shieldhit"), "impact resolves as a shield-ring hit, not a component hit");
  assert.strictEqual(room.bullets.length, 0, "the bullet is consumed at the shield");
  console.log("PASS: shielded ships resolve the shield before component collision");
})();

// 8. Beam and projectile geometry agree for the same component layout.
(function beamProjectileAgree() {
  const design = [
    { type: "core", x: 11, y: 7, rotation: 0 },
    { type: "reactor", x: 7, y: 6, rotation: 90 },
    { type: "engine", x: 7, y: 4, rotation: 0 }
  ];
  const ship = makeShip("t", "p2", 200, 0, design);
  const x1 = 0, y1 = 0, x2 = 1000, y2 = 0;
  const beamIntersections = findBeamRayIntersections(ship, x1, y1, x2, y2, 0);
  const projHit = projectileComponentHit(ship, x1, y1, x2, y2, 0);
  assert.ok(beamIntersections.length > 0 && projHit, "both beam and projectile find a component");
  assert.strictEqual(beamIntersections[0].index, projHit.index, "beam and projectile select the same first component");
  console.log("PASS: beam and projectile geometry agree for the same component layout");
})();

console.log("\nPROJECTILE FOOTPRINT REGRESSION TESTS PASSED");
