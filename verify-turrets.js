"use strict";
// Turret behaviour: turrets rotate toward their target at the shared traverse
// rate (no instant snapping), hold fire until aligned, and projectiles spawn at
// the barrel tip of the (possibly rotated, possibly multi-tile) weapon.
const assert = require("assert");
const TurretRules = require("./public/src/shared/turretRules");
const { PARTS } = require("./src/server/components");
const {
  updateShipWeapons,
  weaponModuleWorldPosition,
  weaponMuzzleDistance,
  moduleRotationToRadians
} = require("./src/server/combat");
const { angleDifference } = require("./src/server/utils");

const SCALE = 13;

function makeRoom() {
  return {
    rules: { gameMode: "solo" },
    map: { asteroids: [], safeZones: [] },
    players: new Map([["me", { id: "me" }], ["foe", { id: "foe" }]]),
    bullets: [],
    effects: [],
    nextEntityId: 1,
    ships: new Map()
  };
}

function makeShip(ownerId, x, y, design) {
  return {
    id: `${ownerId}-ship`, ownerId, x, y, vx: 0, vy: 0, angle: 0, alive: true,
    design,
    stats: { powerUse: 0, powerGeneration: 10, efficiency: 1, accuracyBonus: 1, fireRateBonus: 0 },
    componentHp: design.map(() => 100),
    componentMaxHp: design.map(() => 100),
    shield: 0, maxShield: 0, hp: 500, maxHp: 500
  };
}

function runTicks(room, me, ships, count, dt) {
  const log = [];
  for (let t = 0; t < count; t += 1) {
    updateShipWeapons(room, me, ships, dt, t * dt * 1000);
    log.push({ angle: me.weaponAngles.slice(), bullets: room.bullets.length });
  }
  return log;
}

// 1. Turrets sweep gradually at the shared traverse rate instead of snapping.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "blaster", rotation: 0 }
  ];
  const room = makeRoom();
  const me = makeShip("me", 0, 0, design);
  const foe = makeShip("foe", 300, 180, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  const dt = 1 / 30;
  const log = runTicks(room, me, [me, foe], 60, dt);

  const origin = weaponModuleWorldPosition(me, design[1]);
  const targetRelative = Math.atan2(foe.y - origin.y, foe.x - origin.x) - me.angle;
  const rate = TurretRules.turnRateFor(PARTS.blaster.weapon);
  const ticksNeeded = Math.ceil(Math.abs(targetRelative) / (rate * dt));
  assert(ticksNeeded >= 3, `test premise: traverse must take multiple ticks (needs ${ticksNeeded})`);

  // Not aligned after the first tick, aligned after enough ticks, and each step
  // is bounded by the traverse rate.
  assert(Math.abs(angleDifference(log[0].angle[1], targetRelative)) > 0.05, "turret must not snap to target in one tick");
  assert(Math.abs(angleDifference(log[ticksNeeded + 2].angle[1], targetRelative)) < 0.01, "turret should reach the target angle after sweeping");
  for (let t = 1; t < ticksNeeded; t += 1) {
    const step = Math.abs(angleDifference(log[t].angle[1], log[t - 1].angle[1]));
    assert(step <= rate * dt + 1e-9, `traverse step ${step.toFixed(4)} exceeded rate limit at tick ${t}`);
  }

  // 2. No firing while the barrel is still far off target (> 0.26 rad).
  for (let t = 0; t < log.length; t += 1) {
    if (log[t].bullets > 0) {
      const err = Math.abs(angleDifference(log[t].angle[1], targetRelative));
      assert(err <= 0.26 + rate * dt, `fired while misaligned by ${err.toFixed(3)} rad`);
      break;
    }
  }
  assert(log[log.length - 1].bullets > 0, "turret should fire once aligned");

  // 3. The bullet spawns at the barrel tip, along the turret's aim.
  const bullet = room.bullets[0];
  const spawnOffset = Math.hypot(bullet.x - origin.x, bullet.y - origin.y);
  const expected = weaponMuzzleDistance(design[1], "blaster");
  assert(Math.abs(spawnOffset - expected) < 0.01, `bullet spawned ${spawnOffset.toFixed(2)}px from pivot, expected ${expected.toFixed(2)}`);
  assert(Math.abs(expected / SCALE - TurretRules.MUZZLE_TIP_TILES.blaster) < 1e-9, "blaster muzzle should be at the art barrel tip");
  // The shot may legally fire mid-sweep (within the 0.26 rad alignment gate),
  // so compare the spawn offset direction against the shot's own velocity:
  // the bullet must leave from the barrel it travels along (spread is zero
  // here because accuracy is clamped to 1).
  const spawnDir = Math.atan2(bullet.y - origin.y, bullet.x - origin.x);
  const velocityDir = Math.atan2(bullet.vy, bullet.vx);
  assert(Math.abs(angleDifference(spawnDir, velocityDir)) < 0.01, "bullet must leave along the barrel it was fired from");
}

// 4. Rotated multi-tile weapon: muzzle sits at the forward footprint edge,
// measured from the footprint centre (the turret pivot), not the anchor cell.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "frame", rotation: 0 },
    { x: 9, y: 9, type: "railgun", rotation: 0 }, // occupies (9,9),(9,10),(9,11)
    { x: 8, y: 9, type: "frame", rotation: 0 },
    { x: 8, y: 10, type: "frame", rotation: 0 },
    { x: 8, y: 11, type: "frame", rotation: 0 }
  ];
  const room = makeRoom();
  const me = makeShip("me", 0, 0, design);
  // Dead ahead of the railgun's blueprint facing so its narrow 35-45 degree arc allows fire.
  const foe = makeShip("foe", 600, 26, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  runTicks(room, me, [me, foe], 400, 1 / 30);
  assert(room.bullets.length > 0, "railgun should fire at an in-arc target");
  const bullet = room.bullets[0];
  const pivot = weaponModuleWorldPosition(me, design[2]);
  const spawnOffset = Math.hypot(bullet.x - pivot.x, bullet.y - pivot.y);
  const footprint = PARTS.railgun.footprint;
  const longTiles = Math.max(footprint.width, footprint.height);
  const expected = (longTiles * 0.5 - 0.04) * SCALE;
  assert(Math.abs(spawnOffset - expected) < 0.01, `railgun bullet spawned ${spawnOffset.toFixed(2)}px from pivot, expected ${expected.toFixed(2)} (barrel tip)`);
}

// 5. Client and server share one traverse-rate table.
{
  const rendererSource = require("fs").readFileSync("./public/src/game/renderer.js", "utf8");
  assert(/globalThis\.TurretRules\.turnRateFor/.test(rendererSource), "client renderer must delegate turret turn rates to shared TurretRules");
  const combatSource = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(/TurretRules\.turnRateFor/.test(combatSource), "server combat must delegate turret turn rates to shared TurretRules");
  const html = require("fs").readFileSync("./public/index.html", "utf8");
  assert(/src\/shared\/turretRules\.js/.test(html), "index.html must load the shared turretRules script");
  // Point defense stays the fastest traverse so missile interception still works.
  assert(TurretRules.TURN_RATES.pointDefense > TurretRules.TURN_RATES.blaster, "point defense must traverse faster than main guns");
}

// 6. Pixi visual flow: turret smoothing is per pooled view, ship-relative, and
// not keyed to snapshot object identity or world hull angle.
{
  const fs = require("fs");
  const pixiSource = fs.readFileSync("./public/src/game/pixi/pixiShips.js", "utf8");
  const rendererSource = fs.readFileSync("./public/src/game/renderer.js", "utf8");
  const netlifyBuild = fs.readFileSync("./netlify-build.js", "utf8");
  assert(/visualTurretAngles/.test(pixiSource), "Pixi ship views must own smoothed turret angles so pooled views can reset them");
  assert(!/state\.weaponAnglesMap/.test(pixiSource), "Pixi turret rotation must not use the canvas global weapon angle cache");
  assert(/view\.hullGroup\.rotation\s*=\s*renderShip\.angle/.test(pixiSource), "Pixi hull group should own ship world rotation");
  assert(/sprite\.rotation\s*=\s*visualAngles\[i\]/.test(pixiSource), "Pixi turret sprites must receive ship-relative visual angles");
  assert(!/sprite\.rotation\s*=\s*[^;]*(ship|renderShip)\.angle\s*\+/.test(pixiSource), "Pixi turret sprites must not add hull angle a second time");
  assert(/updatePixiTurrets\(view, ship, design\)/.test(pixiSource), "Pixi turrets must update every rendered ship frame");
  assert(/debugTurrets:\s*false/.test(fs.readFileSync("./public/src/state.js", "utf8")), "turret debug logging must be disabled by default");
  assert(/src[\\/", ]+shared[\\/", ]+turretRules\.js/.test(netlifyBuild) || /turretRules\.js/.test(netlifyBuild), "Netlify build must require the shared turret rules asset");
  for (const type of ["blaster", "autocannon", "railgun", "missile", "torpedo", "swarmMissile", "pointDefense", "flakCannon", "beamEmitter"]) {
    assert(rendererSource.includes(type), `renderer should include ${type} weapon artwork`);
  }
}

console.log("Turret verification passed");
