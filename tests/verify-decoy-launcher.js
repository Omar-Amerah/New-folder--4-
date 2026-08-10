#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { PARTS } = require("../src/server/components");
const { addBullet, updateBullets } = require("../src/server/projectiles");
const {
  initializeDecoyLaunchers,
  updateDecoyLaunchers,
  buildDecoySnapshots,
  buildLauncherSnapshots,
  _test
} = require("../src/server/decoys");

function fixture(random = () => 0, launcherCount = 1) {
  const design = Array.from({ length: launcherCount }, (_, index) => ({
    x: 7 + index,
    y: 7,
    type: "decoyLauncher"
  }));
  const ship = {
    id: "ship-blue",
    ownerId: "blue",
    alive: true,
    removed: false,
    x: 500,
    y: 500,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 20,
    shield: 0,
    maxShield: 0,
    hp: 40,
    maxHp: 40,
    design,
    componentHp: design.map(() => PARTS.decoyLauncher.hp),
    componentMaxHp: design.map(() => PARTS.decoyLauncher.hp),
    componentHeatState: design.map(() => 0),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) }
  };
  const room = {
    nextEntityId: 1,
    world: { width: 2000, height: 2000 },
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams" },
    players: new Map([
      ["blue", { id: "blue", team: "blue", money: 0, kills: 0, losses: 0, earned: 0 }],
      ["red", { id: "red", team: "red", money: 0, kills: 0, losses: 0, earned: 0 }]
    ]),
    ships: new Map([[ship.id, ship]]),
    drones: new Map(),
    decoys: new Map(),
    bullets: [],
    projectileById: new Map(),
    effects: [],
    combatRandom: random
  };
  initializeDecoyLaunchers(room, ship, 0);
  return { room, ship, launcher: ship.decoyLaunchers[0] };
}

assert.deepEqual(PARTS.decoyLauncher.footprint, { width: 1, height: 1 }, "Decoy Launcher is a 1x1 component");
assert.equal(PARTS.decoyLauncher.category, "Defence");
assert.ok(PARTS.decoyLauncher.decoyConfig.productionSeconds > 0, "decoys have an authoritative production time");

function addIncomingMissile(room, ship, id, distance = 200) {
  addBullet(room, {
    id,
    type: "missile",
    ownerId: "red",
    targetId: ship.id,
    targetComponentIndex: 0,
    x: ship.x + distance,
    y: ship.y,
    vx: -100,
    vy: 0,
    damage: 30,
    hp: 10,
    interceptable: true,
    tracking: 0.7,
    trackRemaining: 5,
    trackingDelay: 0,
    life: 10,
    bornAt: 0
  });
}

{
  for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const { room, ship, launcher } = fixture(() => 0);
    ship.angle = heading;
    const decoy = _test.launchDecoy(
      room,
      ship,
      launcher,
      PARTS.decoyLauncher.decoyConfig,
      { x: ship.x + Math.cos(heading) * 200, y: ship.y + Math.sin(heading) * 200 },
      0
    );
    const relativeVx = decoy.vx - ship.vx;
    const relativeVy = decoy.vy - ship.vy;
    const forwardSpeed = relativeVx * Math.cos(heading) + relativeVy * Math.sin(heading);
    const lateralSpeed = Math.abs(-relativeVx * Math.sin(heading) + relativeVy * Math.cos(heading));
    assert.ok(forwardSpeed > PARTS.decoyLauncher.decoyConfig.driftSpeed * 0.98, "flare launches into the ship's forward arc");
    assert.ok(lateralSpeed < PARTS.decoyLauncher.decoyConfig.driftSpeed * 0.12, "flare forward spread stays narrow");
  }
}

{
  const { room, ship } = fixture(() => 0.99, 3);
  addIncomingMissile(room, ship, "single-threat");
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(room.decoys.size, 1, "one incoming projectile fires only one of several ready flare launchers");
  assert.deepEqual([...room.decoys.values()].map((decoy) => decoy.launcherComponentIndex), [0], "the first ready launcher fires first");

  room.bullets.length = 0;
  room.projectileById.clear();
  room.decoys.clear();
  addIncomingMissile(room, ship, "next-threat");
  updateDecoyLaunchers(room, [ship], 0, 1300);
  assert.deepEqual([...room.decoys.values()].map((decoy) => decoy.launcherComponentIndex), [1], "the next threat rotates fire to the next launcher");
}

{
  const { room, ship } = fixture(() => 0.99, 2);
  addIncomingMissile(room, ship, "failed-attraction");
  updateDecoyLaunchers(room, [ship], 0, 0);
  updateDecoyLaunchers(room, [ship], 0.05, 50);
  assert.deepEqual(
    [...room.decoys.values()].map((decoy) => decoy.launcherComponentIndex),
    [0, 1],
    "a missile that rejects one flare triggers the next ready launcher"
  );
}

{
  const { room, ship } = fixture(() => 0, 2);
  addIncomingMissile(room, ship, "missed-flare");
  const missile = room.bullets[0];
  updateDecoyLaunchers(room, [ship], 0, 0);
  const firstFlare = [...room.decoys.values()][0];
  assert.equal(missile.targetId, firstFlare.id, "missile initially locks onto the first flare");
  firstFlare.expiresAt = 10;
  updateDecoyLaunchers(room, [ship], 0.02, 20);
  const retryFlare = [...room.decoys.values()][0];
  assert.equal(room.decoys.size, 1, "expired missed flare is replaced while the missile can still track");
  assert.equal(retryFlare.launcherComponentIndex, 1, "the retry uses the next ready launcher");
  assert.equal(missile.targetId, retryFlare.id, "the reacquired missile can lock onto the replacement flare");
}

{
  const { room, ship } = fixture(() => 0, 2);
  addIncomingMissile(room, ship, "no-guidance-time");
  const missile = room.bullets[0];
  updateDecoyLaunchers(room, [ship], 0, 0);
  const flare = [...room.decoys.values()][0];
  flare.expiresAt = 10;
  missile.trackRemaining = 0;
  updateDecoyLaunchers(room, [ship], 0.02, 20);
  assert.equal(room.decoys.size, 0, "no replacement flare launches after missile guidance time is exhausted");
}

{
  const { room, ship } = fixture(() => 0.99, 3);
  addIncomingMissile(room, ship, "near-threat", 150);
  addIncomingMissile(room, ship, "far-threat", 250);
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(room.decoys.size, 2, "two incoming projectiles can trigger two ready flare launchers");
  assert.deepEqual(
    [...room.decoys.values()].map((decoy) => decoy.launcherComponentIndex),
    [0, 1],
    "multiple threats use consecutive launchers in deterministic order"
  );
  assert.equal(ship.decoyLaunchers[2].stock, 1, "unused launchers retain their flare");
}

{
  const { room, ship, launcher } = fixture(() => 0);
  addBullet(room, {
    type: "missile",
    ownerId: "red",
    targetId: ship.id,
    targetComponentIndex: 0,
    x: ship.x + 200,
    y: ship.y,
    vx: -100,
    vy: 0,
    damage: 30,
    hp: 10,
    interceptable: true,
    tracking: 0.7,
    trackRemaining: 5,
    trackingDelay: 0,
    life: 10,
    bornAt: 0
  });
  const missile = room.bullets[0];
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(room.decoys.size, 1, "an incoming guided missile triggers a decoy launch");
  const decoy = [...room.decoys.values()][0];
  assert.equal(launcher.stock, 0, "launching consumes the limited onboard stock");
  assert.equal(missile.targetId, decoy.id, "a successful attraction roll retargets the guided missile");
  assert.equal(missile.targetComponentIndex, -1, "false targets do not expose ship components");
  assert.equal(buildDecoySnapshots(room, 0)[0].id, decoy.id, "the visible false target is present in snapshots");
  assert.deepEqual(buildLauncherSnapshots(ship)[0], {
    componentIndex: 0,
    stock: 0,
    capacity: 3,
    productionProgress: 0,
    nextLaunchAt: 1200
  }, "launcher snapshots expose stock and production state");

  decoy.x = 900;
  decoy.y = 500;
  missile.x = 850;
  missile.y = 500;
  missile.vx = 150;
  missile.vy = 0;
  missile.tracking = 0;
  updateBullets(room, 0.5, 500);
  assert.equal(room.decoys.size, 0, "an attracted missile is consumed when it hits its false target");
  assert.equal(room.bullets.includes(missile), false, "the missile is removed after striking the decoy");
  assert.ok(room.effects.some((effect) => effect.type === "decoyburst"), "decoy interception creates a visible burst");
}

{
  const { room, ship, launcher } = fixture(() => 0);
  launcher.stock = 0;
  launcher.productionProgress = 0;
  const productionSeconds = PARTS.decoyLauncher.decoyConfig.productionSeconds;
  updateDecoyLaunchers(room, [ship], productionSeconds - 0.01, (productionSeconds - 0.01) * 1000);
  assert.equal(launcher.stock, 0, "replacement is unavailable before production completes");
  updateDecoyLaunchers(room, [ship], 0.01, productionSeconds * 1000);
  assert.equal(launcher.stock, 1, "one replacement is produced after the full production time");
  launcher.stock = 0;
  launcher.productionProgress = 0;
  ship.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  updateDecoyLaunchers(room, [ship], productionSeconds, productionSeconds * 2000);
  assert.equal(launcher.stock, 0, "production pauses without component power");
}

{
  const config = PARTS.decoyLauncher.decoyConfig;
  for (const [power, label] of [[1, "100%"], [0.5, "50%"], [0.1, "10%"], [0.01, "1%"]]) {
    const { room, ship, launcher } = fixture(() => 0);
    ship.componentPower.byComponentIndex[0].operationalMultiplier = power;
    launcher.stock = 0;
    launcher.productionProgress = 0;
    updateDecoyLaunchers(room, [ship], config.productionSeconds * 0.5, 0);
    assert.ok(Math.abs(launcher.productionProgress - power * 0.5) < 1e-9,
      `${label} Power advances decoy production at the universal linear rate`);
  }

  const zeroProduction = fixture(() => 0);
  zeroProduction.ship.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  zeroProduction.launcher.stock = 0;
  zeroProduction.launcher.productionProgress = 0;
  updateDecoyLaunchers(zeroProduction.room, [zeroProduction.ship], config.productionSeconds, 0);
  assert.equal(zeroProduction.launcher.productionProgress, 0, "0% Power stops decoy production");

  for (const [power, label] of [[0.5, "50%"], [0.1, "10%"], [0.01, "1%"]]) {
    const { room, ship, launcher } = fixture(() => 0);
    ship.componentPower.byComponentIndex[0].operationalMultiplier = power;
    launcher.stock = 1;
    launcher.productionProgress = 1;
    launcher.nextLaunchAt = 0;
    addIncomingMissile(room, ship, `positive-power-launch-${label}`);
    updateDecoyLaunchers(room, [ship], 0, 1);
    assert.equal(room.decoys.size, 1, `${label} Power permits a decoy launch`);
  }

  const zeroLaunch = fixture(() => 0);
  zeroLaunch.ship.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  zeroLaunch.launcher.stock = 1;
  zeroLaunch.launcher.productionProgress = 1;
  zeroLaunch.launcher.nextLaunchAt = 0;
  addIncomingMissile(zeroLaunch.room, zeroLaunch.ship, "zero-power-launch");
  updateDecoyLaunchers(zeroLaunch.room, [zeroLaunch.ship], 0, 1);
  assert.equal(zeroLaunch.room.decoys.size, 0, "0% Power prevents a decoy launch");
}

{
  const { room, ship } = fixture(() => 0);
  updateDecoyLaunchers(room, [ship], 0, 0);
  const config = PARTS.decoyLauncher.decoyConfig;
  const decoy = {
    id: "x-test",
    ownerId: ship.ownerId,
    parentShipId: ship.id,
    x: 900,
    y: 500,
    vx: 0,
    vy: 0,
    radius: config.collisionRadius,
    spawnedAt: 0,
    expiresAt: 10000,
    attractionRange: config.attractionRange,
    attractionChance: 1
  };
  room.decoys.set(decoy.id, decoy);
  addBullet(room, {
    type: "bolt",
    ownerId: "red",
    targetId: ship.id,
    x: 850,
    y: 500,
    vx: 150,
    vy: 0,
    damage: 10,
    life: 2,
    bornAt: 0
  });
  const bolt = room.bullets[0];
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(bolt.targetId, ship.id, "unguided projectiles never retarget to decoys");
  updateBullets(room, 0.5, 500);
  assert.equal(room.decoys.has(decoy.id), true, "unguided projectiles pass through false targets");
  assert.equal(room.bullets.includes(bolt), true, "the unguided projectile remains in flight");
}

{
  const { room, ship } = fixture(() => 0.99);
  addBullet(room, {
    type: "missile", ownerId: "red", targetId: ship.id,
    x: ship.x + 100, y: ship.y, vx: -100, vy: 0,
    damage: 10, life: 5, tracking: 0.8, trackRemaining: 3
  });
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(room.bullets[0].targetId, ship.id, "a failed attraction roll leaves the guided missile on its original target");
}

{
  const { room, ship } = fixture(() => 0);
  addBullet(room, {
    type: "missile", ownerId: "red", targetId: ship.id,
    x: ship.x + 100, y: ship.y, vx: 0, vy: 100,
    damage: 10, life: 5, tracking: 0, trackRemaining: 3
  });
  updateDecoyLaunchers(room, [ship], 0, 0);
  assert.equal(room.decoys.size, 0, "a missile with zero guidance does not trigger the launcher");
  updateBullets(room, 0.1, 100);
  assert.equal(room.bullets[0].vx, 0, "a zero-guidance missile does not turn toward its target");
}

console.log("Decoy Launcher production, guidance and collision verification passed");
