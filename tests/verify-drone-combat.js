#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  damageBeamTargets,
  findPointDefenseTarget,
  findTarget,
  pickWeaponFireTarget,
  updateShipWeapons
} = require("./src/server/combat");
const { updateBullets } = require("./src/server/projectiles");
const { initComponentState } = require("./src/server/componentHealth");
const { PARTS } = require("./src/server/components");
const {
  CONFIG,
  damageDrone,
  setDroneDestroyed,
  _test: { chooseTarget, chooseFallbackTarget, fighterProjectileEvasion, steerFighterDrone, updateDroneEntity }
} = require("./src/server/drones");

function makeRoom() {
  const parent = {
    id: "carrier", ownerId: "blue", alive: true, x: 0, y: 0, angle: 0,
    hp: 50, maxHp: 100, focusTargetId: "enemy-ship",
    componentHp: [100], componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    design: [{ x: 5, y: 6, type: "droneBay", droneType: "fighter" }],
    droneBays: [{
      componentIndex: 0, componentId: "drone-bay:5,6", droneType: "fighter",
      mode: "deployed", launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
      slots: [{ slot: 0, state: "active", droneId: "fighter", productionProgress: 1 }]
    }]
  };
  const enemyShip = { id: "enemy-ship", ownerId: "red", alive: true, x: 220, y: 0, hp: 100, maxHp: 100 };
  const ally = { id: "ally", ownerId: "ally", alive: true, x: 80, y: 0, hp: 20, maxHp: 100 };
  const hostileDrone = {
    id: "hostile", ownerId: "red", parentShipId: "enemy-ship", type: "fighter",
    x: 35, y: 0, hull: 20, maxHull: 20, targetId: parent.id
  };
  const room = {
    players: new Map([
      ["blue", { id: "blue", team: "a" }], ["ally", { id: "ally", team: "a" }], ["red", { id: "red", team: "b" }]
    ]),
    ships: new Map([[parent.id, parent], [enemyShip.id, enemyShip], [ally.id, ally]]),
    drones: new Map([[hostileDrone.id, hostileDrone]]),
    bullets: [], effects: [], map: { asteroids: [] }, rules: { gameMode: "teams" },
    world: { width: 2000, height: 2000 }
  };
  return { room, parent, enemyShip, ally, hostileDrone };
}

function drone(type, id = type) {
  return {
    id, ownerId: "blue", parentShipId: "carrier", bayComponentId: "drone-bay:5,6",
    slot: 0, type, x: 0, y: 0, vx: 0, vy: 0, angle: 0,
    hull: CONFIG.types[type].hull, maxHull: CONFIG.types[type].hull,
    state: "active", nextThinkAt: 0, nextActionAt: Infinity, targetId: null
  };
}

{
  const { room, parent } = makeRoom();
  const fighter = drone("fighter");
  room.drones.set(fighter.id, fighter);
  assert.equal(chooseTarget(room, fighter, parent, CONFIG.types.fighter).id, "hostile", "Fighter protects its parent from a nearby hostile drone first");
  room.drones.delete("hostile");
  assert.equal(chooseTarget(room, fighter, parent, CONFIG.types.fighter).id, "enemy-ship", "Fighter follows the parent's designated target");
  fighter.x = CONFIG.types.fighter.commandRange + 50;
  updateDroneEntity(room, fighter, 0.1, 1000);
  assert.equal(fighter.targetId, null, "Fighter drops a target beyond command range and returns toward its parent");
}

{
  const { room } = makeRoom();
  const fighter = drone("fighter", "evasive-fighter");
  const incoming = {
    id: "incoming-bolt", type: "bolt", ownerId: "red", targetId: fighter.id,
    x: 180, y: 0, vx: -500, vy: 0, damage: 12, life: 2
  };
  room.bullets = [incoming];
  const evasion = fighterProjectileEvasion(room, fighter, CONFIG.types.fighter);
  assert.ok(evasion, "Fighter predicts a hostile projectile crossing its path");
  assert.equal(evasion.projectileId, incoming.id);
  assert.ok(Math.abs(evasion.y) > 0.9, "head-on fire produces a strong perpendicular dodge");
  assert.ok(evasion.closestTime > 0 && evasion.closestTime < CONFIG.types.fighter.evasionLookaheadSeconds);

  room.bullets = [{ ...incoming, id: "friendly", ownerId: "blue" }];
  assert.equal(fighterProjectileEvasion(room, fighter, CONFIG.types.fighter), null, "Fighter ignores friendly projectiles");
  room.bullets = [{ ...incoming, id: "receding", x: 120, vx: 500, targetId: null }];
  assert.equal(fighterProjectileEvasion(room, fighter, CONFIG.types.fighter), null, "Fighter ignores a safely receding projectile");
  assert.equal(fighterProjectileEvasion(room, drone("repair"), CONFIG.types.repair), null, "Repair Drone pathing is not given Fighter evasion");
}

{
  // Defence Drones now share the predictive evasion envelope; Repair Drones,
  // which define none, still do not.
  const { room } = makeRoom();
  room.bullets = [{ id: "defence-threat", type: "bolt", ownerId: "red", targetId: null, x: 150, y: 0, vx: -500, vy: 0, damage: 10, life: 2 }];
  assert.ok(fighterProjectileEvasion(room, drone("defence"), CONFIG.types.defence), "Defence Drones share predictive projectile evasion");
  assert.equal(fighterProjectileEvasion(room, drone("repair"), CONFIG.types.repair), null, "Repair Drones still have no evasion envelope");
}

{
  // A projectile already inside the clearance bubble adds a direct break-away
  // push (a component pointing away from the projectile), not just a slip.
  const { room } = makeRoom();
  room.bullets = [{ id: "point-blank", type: "bolt", ownerId: "red", targetId: "fighter", x: 20, y: 6, vx: -400, vy: 0, damage: 10, life: 2 }];
  const evasion = fighterProjectileEvasion(room, drone("fighter"), CONFIG.types.fighter);
  assert.ok(evasion, "a point-blank projectile inside the clearance bubble triggers evasion");
  assert.ok(evasion.x < 0, "break-away pushes the Fighter away from a projectile bearing down from ahead");
}

{
  const evasiveSetup = makeRoom();
  const controlSetup = makeRoom();
  evasiveSetup.room.drones.clear();
  controlSetup.room.drones.clear();
  const evasive = drone("fighter", "fighter-path");
  const control = drone("fighter", "fighter-path");
  evasive.targetId = evasiveSetup.enemyShip.id;
  control.targetId = controlSetup.enemyShip.id;
  evasive.nextThinkAt = Infinity;
  control.nextThinkAt = Infinity;
  evasiveSetup.room.drones.set(evasive.id, evasive);
  controlSetup.room.drones.set(control.id, control);
  evasiveSetup.room.bullets = [{
    id: "path-threat", type: "missile", ownerId: "red", targetId: evasive.id,
    x: 180, y: 0, vx: -500, vy: 0, damage: 20, life: 2
  }];
  updateDroneEntity(evasiveSetup.room, evasive, 0.1, 1000);
  updateDroneEntity(controlSetup.room, control, 0.1, 1000);
  assert.equal(evasive.evasionProjectileId, "path-threat", "authoritative Fighter movement records the projectile it is dodging");
  assert.equal(evasive.lastEvasionAt, 1000, "evasion timing uses simulation time");
  assert.notEqual(evasive.angle, control.angle, "evasion changes the Fighter path relative to normal pursuit");
  assert.ok(Math.abs(evasive.y - control.y) > 0.01, "the integrated Fighter position visibly sidesteps the incoming missile");
}

{
  function closestPass(evasionStrength) {
    const fighter = drone("fighter", "clearance-test");
    const projectile = {
      id: "clearance-bolt", type: "bolt", ownerId: "red", targetId: fighter.id,
      x: 300, y: 0, vx: -500, vy: 0, damage: 12, life: 2
    };
    const room = {
      bullets: [projectile],
      players: new Map([
        ["blue", { id: "blue", team: "a" }],
        ["red", { id: "red", team: "b" }]
      ]),
      rules: { gameMode: "teams" }
    };
    const config = { ...CONFIG.types.fighter, evasionStrength };
    let minimum = Infinity;
    for (let step = 0; step < 14; step += 1) {
      steerFighterDrone(room, fighter, 1000, 0, config, 0.05, step * 50);
      projectile.x += projectile.vx * 0.05;
      projectile.y += projectile.vy * 0.05;
      projectile.life -= 0.05;
      minimum = Math.min(minimum, Math.hypot(projectile.x - fighter.x, projectile.y - fighter.y));
    }
    return minimum;
  }
  const normalPass = closestPass(0);
  const evasivePass = closestPass(CONFIG.types.fighter.evasionStrength);
  assert.ok(
    evasivePass > normalPass + 20,
    `predictive pathing materially increases projectile clearance (${normalPass.toFixed(1)} -> ${evasivePass.toFixed(1)})`
  );
}

{
  const { room, parent } = makeRoom();
  const defence = drone("defence");
  room.bullets.push({
    id: "missile", type: "missile", ownerId: "red", x: 20, y: 0,
    vx: 0, vy: 0, life: 2, hp: 1, interceptable: true
  });
  assert.equal(chooseTarget(room, defence, parent, CONFIG.types.defence).id, "missile", "Defence prioritises a hostile missile");
  defence.nextActionAt = 0;
  room.drones.set(defence.id, defence);
  updateDroneEntity(room, defence, 0.1, 1000);
  assert.equal(room.bullets[0].life, 0, "Defence Drone can authoritatively intercept the targeted missile");
  room.bullets = [];
  assert.equal(chooseTarget(room, defence, parent, CONFIG.types.defence).id, "hostile", "Defence prioritises a hostile drone");
}

{
  const { room, parent } = makeRoom();
  const repair = drone("repair");
  assert.equal(chooseTarget(room, repair, parent, CONFIG.types.repair).id, "carrier", "Repair prioritises its damaged parent");
  parent.hp = parent.maxHp;
  assert.equal(chooseTarget(room, repair, parent, CONFIG.types.repair).id, "ally", "Repair assists a damaged nearby ally");
  assert.notEqual(chooseTarget(room, repair, parent, CONFIG.types.repair).id, repair.id, "Repair never selects itself");
  assert.equal(chooseFallbackTarget(room, repair, parent, CONFIG.types.repair), parent, "destroyed/unpowered bay fallback repairs only the parent");
}

{
  const { room, parent, hostileDrone } = makeRoom();
  const fighter = drone("fighter");
  parent.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  room.drones.set(fighter.id, fighter);
  updateDroneEntity(room, fighter, 0.1, 1000);
  assert.equal(fighter.commandState, "fallback", "unpowered bay removes advanced command behavior");
  assert.equal(fighter.targetId, hostileDrone.id, "fallback Fighter defends locally");
}

{
  const { room, parent } = makeRoom();
  const victim = drone("fighter", "victim");
  room.drones.set(victim.id, victim);
  parent.droneBays[0].slots[0].droneId = victim.id;
  const applied = damageDrone(room, victim, victim.hull + 50, "red", 10);
  assert.equal(applied, CONFIG.types.fighter.hull);
  assert.equal(room.drones.has(victim.id), false, "destroyed drones leave the transient entity map");
  assert.equal(parent.droneBays[0].slots[0].state, "destroyed", "destruction opens the owning bay slot");
  assert.equal(parent.droneBays[0].slots[0].productionProgress, 0);
  assert.equal(setDroneDestroyed(room, victim, 11), false, "duplicate destruction cannot create duplicate replacement work");
}

{
  const { room, hostileDrone } = makeRoom();
  room.bullets.push({
    id: "incoming-missile", type: "missile", ownerId: "red", targetId: "carrier",
    x: 20, y: 0, vx: -20, vy: 0, life: 2, hp: 10, interceptable: true
  });
  const incoming = findPointDefenseTarget(room, 0, 0, "blue", { range: 200 }, [...room.ships.values()], "carrier");
  assert.equal(incoming.type, "projectile");
  assert.equal(incoming.entity.id, "incoming-missile", "Point Defence intercepts an incoming missile before engaging a drone");
  room.bullets = [];
  const target = findPointDefenseTarget(room, 0, 0, "blue", { range: 200 }, [...room.ships.values()], "carrier");
  assert.equal(target.type, "drone");
  assert.equal(target.entity, hostileDrone, "Point Defence can target hostile drones");
}

{
  const { room, parent, enemyShip, hostileDrone } = makeRoom();
  assert.equal(findTarget(room, parent, [...room.ships.values()]), enemyShip, "the ship-level combat target remains an enemy ship while one is valid");
  const forwardModule = { type: "autocannon", x: 7, y: 7, rotation: 0 };
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 400, {
      weapon: PARTS.autocannon.weapon,
      module: forwardModule
    }),
    hostileDrone,
    "a fast defensive Autocannon diverts to a nearby Fighter attacking its ship"
  );
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 600, {
      weapon: PARTS.blaster.weapon,
      module: { ...forwardModule, type: "blaster" }
    }),
    enemyShip,
    "a general-purpose Blaster stays on the enemy ship"
  );
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 1200, {
      weapon: PARTS.railgun.weapon,
      module: { ...forwardModule, type: "railgun" }
    }),
    enemyShip,
    "a heavy Railgun never wastes a shot on a drone while a ship target is available"
  );
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 900, {
      weapon: PARTS.missile.weapon,
      module: { ...forwardModule, type: "missile" }
    }),
    enemyShip,
    "a guided Missile remains committed to an available enemy ship"
  );
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 100, {
      weapon: PARTS.railgun.weapon,
      module: { ...forwardModule, type: "railgun" }
    }),
    hostileDrone,
    "a heavy weapon may use a drone only when no ship target is available to that weapon"
  );

  enemyShip.alive = false;
  assert.equal(findTarget(room, parent, [...room.ships.values()]), hostileDrone, "normal ship targeting acquires a hostile drone when no enemy ship is valid");
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, hostileDrone, 200),
    hostileDrone,
    "an ordinary weapon can select the acquired drone as its firing target"
  );
}

{
  const { room, parent, enemyShip } = makeRoom();
  parent.focusTargetId = null;
  enemyShip.x = 100;
  enemyShip.stats = { weaponDps: 0 };
  const dangerousShip = {
    ...enemyShip,
    id: "dangerous-ship",
    x: 300,
    stats: { weaponDps: 144 }
  };
  room.ships.set(dangerousShip.id, dangerousShip);
  assert.equal(
    findTarget(room, parent, [...room.ships.values()]),
    dangerousShip,
    "ship-level acquisition chooses the highest-threat valid enemy ship rather than universally choosing the nearest"
  );
}

{
  const { room, parent, enemyShip, hostileDrone } = makeRoom();
  hostileDrone.type = "repair";
  hostileDrone.targetId = null;
  hostileDrone.x = 100;
  assert.equal(
    pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 400, {
      weapon: PARTS.autocannon.weapon,
      module: { type: "autocannon", x: 7, y: 7, rotation: 0 }
    }),
    enemyShip,
    "an agile weapon does not divert for a low-threat nearby Repair Drone"
  );
}

{
  const { room, parent, enemyShip, hostileDrone } = makeRoom();
  hostileDrone.type = "defence";
  hostileDrone.targetId = null;
  hostileDrone.x = 100;
  room.drones.set("hostile-2", { ...hostileDrone, id: "hostile-2", x: 110 });
  room.drones.set("hostile-3", { ...hostileDrone, id: "hostile-3", x: 120 });
  const selected = pickWeaponFireTarget(room, parent, [...room.ships.values()], parent.x, parent.y, enemyShip, 400, {
    weapon: PARTS.autocannon.weapon,
    module: { type: "autocannon", x: 7, y: 7, rotation: 0 }
  });
  assert.ok(selected && room.drones.has(selected.id), "a nearby armed swarm raises enough threat for an agile weapon to divert");
  assert.equal(findTarget(room, parent, [...room.ships.values()]), enemyShip, "the swarm does not switch the whole ship away from its enemy ship target");
}

{
  const { room, enemyShip, hostileDrone } = makeRoom();
  const shooter = {
    id: "mixed-gunship", ownerId: "blue", alive: true, x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, radius: 24, shield: 0, stats: { maxHp: 1000 },
    design: [
      { type: "autocannon", x: 7, y: 7, rotation: 0 },
      { type: "railgun", x: 7, y: 8, rotation: 0 }
    ]
  };
  initComponentState(shooter);
  hostileDrone.targetId = shooter.id;
  room.ships = new Map([[shooter.id, shooter], [enemyShip.id, enemyShip]]);
  room.nextEntityId = 1;
  room.combatRandom = () => 0.5;
  updateShipWeapons(room, shooter, [shooter, enemyShip], 1 / 30, 0);
  assert.equal(shooter.combatTargetId, enemyShip.id, "an attacking drone does not replace the whole ship's combat target");
  assert.equal(shooter.weaponFireTargetIds[0], hostileDrone.id, "the defensive Autocannon independently diverts to the attacking drone");
  assert.equal(shooter.weaponFireTargetIds[1], enemyShip.id, "the Railgun independently remains on the enemy ship");
}

{
  const { room, hostileDrone } = makeRoom();
  const initialHull = hostileDrone.hull;
  room.bullets.push({
    id: "ordinary-bolt", type: "bolt", ownerId: "blue", targetId: hostileDrone.id,
    x: 0, y: 0, vx: 100, vy: 0, damage: 7, life: 2
  });
  updateBullets(room, 0.4, 1000);
  assert.equal(hostileDrone.hull, initialHull - 7, "ordinary swept projectiles damage drones");
  assert.equal(room.bullets.length, 0, "a projectile is consumed by its drone impact");
}

{
  const { room, hostileDrone } = makeRoom();
  const shooter = {
    id: "gunship", ownerId: "blue", alive: true, x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, radius: 20, shield: 0, stats: { maxHp: 1000 },
    design: [{ type: "autocannon", x: 7, y: 7, rotation: 0 }]
  };
  initComponentState(shooter);
  hostileDrone.x = 100;
  room.ships = new Map([[shooter.id, shooter]]);
  room.nextEntityId = 1;
  room.combatRandom = () => 0.5;
  updateShipWeapons(room, shooter, [shooter], 1 / 30, 0);
  assert.equal(room.bullets.length, 1, "an ordinary production weapon fires when a drone is the only hostile target");
  assert.equal(room.bullets[0].targetId, hostileDrone.id, "the fired projectile retains the drone target");
  const initialHull = hostileDrone.hull;
  updateBullets(room, 0.15, 150);
  assert.ok(hostileDrone.hull < initialHull, "the ordinary production weapon's projectile reaches and damages the drone");
}

{
  const { room, parent, hostileDrone } = makeRoom();
  const initialHull = hostileDrone.hull;
  damageBeamTargets(room, parent, [...room.ships.values()], 0, 0, 80, 0, 3, 5, 1000);
  assert.equal(hostileDrone.hull, initialHull - 5, "ordinary beam weapons damage drones");
}

{
  const { room } = makeRoom();
  const orphan = drone("defence", "orphan");
  orphan.parentShipId = "missing";
  room.drones.set(orphan.id, orphan);
  updateDroneEntity(room, orphan, 0.1, 1000);
  assert.equal(orphan.state, "orphaned");
  updateDroneEntity(room, orphan, 0.1, 1000 + CONFIG.orphanLifetimeSeconds * 1000);
  assert.equal(room.drones.has(orphan.id), false, "orphaned drones deterministically self-destruct rather than becoming ships");
}

console.log("Drone AI and combat verification passed");
