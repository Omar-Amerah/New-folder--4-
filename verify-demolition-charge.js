#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { resolveDemolitionContacts, detonateProximityCharge, armedProximityChargeRanges, nearestDemolitionTargetPoint } = require('./src/server/combat');
const { updateShipMovement } = require('./src/server/movement');
const { physicalCollisionRadius } = require('./src/server/movementCollision');
const { ARRIVE_DISTANCE } = require('./src/server/movementTuning');
const { initComponentState, initProximityChargeState } = require('./src/server/componentHealth');
const { PARTS } = require('./src/server/components');

function makePlayers() {
  return new Map([
    ['blue', { id: 'blue', team: 'a' }],
    ['red', { id: 'red', team: 'b' }],
    ['ally', { id: 'ally', team: 'a' }]
  ]);
}

function makeShip(id, ownerId, x, y, design, extra = {}) {
  const ship = {
    id, ownerId, alive: true, x, y, vx: 0, vy: 0, angle: extra.angle || 0,
    focusTargetId: null, combatTargetId: null, commandState: 'mainCore',
    targetX: x, targetY: y, arrived: true,
    stats: { maxHp: extra.maxHp || 0, unitCost: 100, radius: 20 },
    design, dirtyComponents: new Set(),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    dirtyPower: false, powerRevision: 1,
    dirtyComponentsVisual: false,
    shield: extra.shield || 0,
    maxShield: extra.maxShield || 0
  };
  initComponentState(ship);
  initProximityChargeState(ship);
  ship.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) };
  ship.radius = 20;
  ship.stats.maxHp = ship.maxHp;
  if (extra.maxHp > 0) {
    const per = Math.max(1, Math.ceil(extra.maxHp / design.length));
    ship.componentMaxHp = design.map(() => per);
    ship.componentHp = design.map(() => per);
    ship.maxHp = per * design.length;
    ship.hp = ship.maxHp;
    ship.stats.maxHp = ship.maxHp;
  }
  if (extra.shield !== undefined) ship.shield = extra.shield;
  if (extra.maxShield !== undefined) ship.maxShield = extra.maxShield;
  return ship;
}

function makeRoom(extra = {}) {
  return {
    players: makePlayers(),
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    points: [],
    map: { asteroids: [] },
    rules: { gameMode: 'teams' },
    world: { width: 2000, height: 2000 },
    disableSpatialIndex: true,
    ...extra
  };
}

function chargeDesign() { return [{ x: 7, y: 7, type: 'core' }, { x: 5, y: 7, type: 'proximityDemolitionCharge' }]; }
function smallChargeDesign() { return [{ x: 7, y: 7, type: 'core' }, { x: 6, y: 7, type: 'demolitionCharge' }]; }
function basicDesign() { return [{ x: 7, y: 7, type: 'core' }, { x: 6, y: 7, type: 'frame' }]; }
function largeDesign() {
  const d = [{ x: 7, y: 7, type: 'core' }];
  let row = 6;
  for (let i = 0; i < 12; i += 1) { d.push({ x: row, y: 7, type: 'frame' }); row -= 1; }
  return d;
}
function multiChargeDesign() {
  return [
    { x: 7, y: 7, type: 'core' },
    { x: 6, y: 7, type: 'frame' },
    { x: 5, y: 7, type: 'proximityDemolitionCharge' },
    { x: 3, y: 7, type: 'proximityDemolitionCharge' }
  ];
}

// 1. Armed status
{
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  assert.equal(armedProximityChargeRanges(carrier).armed, true, 'carrier with intact charge is armed');
  carrier.componentHp[1] = 0;
  assert.equal(armedProximityChargeRanges(carrier).armed, false, 'destroyed charge is not armed');
}

// 2. Overlapping enemy hitboxes trigger immediately
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 1, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 1, basicDesign());
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.proximityChargeDetonated[1], 1, 'overlapping enemy detonates charge');
  assert.equal(carrier.alive, false, 'carrier destroyed on detonation');
  assert.ok(enemy.hp < enemy.maxHp, 'enemy takes damage');
}

// 3. Rotated overlapping hitboxes trigger
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 1, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 1, basicDesign(), { angle: Math.PI / 2 });
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.alive, false, 'rotated overlapping enemy detonates');
}

// 4. Large hull edges trigger when centres remain far apart
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.alive, false, 'large ship edge triggers even with centres far apart');
  assert.ok(enemy.hp < enemy.maxHp, 'large enemy takes damage');
}

// 5. Near misses do not trigger
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const enemy = makeShip('e', 'red', 500, 0, basicDesign());
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.proximityChargeDetonated[1], 0, 'distant enemy does not trigger');
  assert.equal(carrier.alive, true, 'carrier alive after near miss');
}

// 6. Allied contact does not trigger
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const ally = makeShip('a', 'ally', 0, 0, basicDesign());
  room.ships.set('c', carrier);
  room.ships.set('a', ally);
  resolveDemolitionContacts(room, [carrier, ally], 0);
  assert.equal(carrier.proximityChargeDetonated[1], 0, 'allied contact does not trigger');
}

// 7. Destroyed enemy does not trigger
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 0, basicDesign());
  enemy.alive = false;
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.proximityChargeDetonated[1], 0, 'destroyed enemy does not trigger');
}

// 8. One collision produces exactly one explosion (double detonation prevented)
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 0, basicDesign());
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.alive, false, 'carrier destroyed once');
  const before = enemy.hp;
  detonateProximityCharge(room, carrier, 1, 10, true);
  assert.equal(enemy.hp, before, 'second detonation does nothing');
}

// 9. Carrier destruction: all components zero, hp zero, shield zero
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign(), { shield: 200, maxShield: 200 });
  const enemy = makeShip('e', 'red', 0, 0, basicDesign());
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(carrier.hp, 0, 'carrier aggregate hp is zero');
  assert.equal(carrier.shield, 0, 'carrier shield zero');
  assert.ok(carrier.componentHp.every((h) => h === 0), 'all carrier components zero');
  assert.equal(carrier.alive, false, 'carrier marked dead');
  assert.equal(carrier.destroyFinalizedAt !== undefined, true, 'carrier destruction finalized');
}

// 10. Shield bypass: target shield unchanged, hull damaged
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 60, largeDesign(), { shield: 2000, maxShield: 2000, maxHp: 100000 });
  room.ships.set('c', carrier);
  room.ships.set('e', enemy);
  resolveDemolitionContacts(room, [carrier, enemy], 0);
  assert.equal(enemy.shield, 2000, 'enemy shield unchanged by demolition blast');
  assert.ok(enemy.hp < enemy.maxHp, 'enemy hull damaged through shields');
}

// 11. Direct contact target receives larger budget than splash target
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  const direct = makeShip('d', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  const splash = makeShip('s', 'red', 0, 250, largeDesign(), { maxHp: 100000 });
  room.ships.set('c', carrier);
  room.ships.set('d', direct);
  room.ships.set('s', splash);
  resolveDemolitionContacts(room, [carrier, direct, splash], 0);
  const directLoss = direct.maxHp - direct.hp;
  const splashLoss = splash.maxHp - splash.hp;
  assert.ok(directLoss > splashLoss * 2, 'direct target takes much more damage than splash target');
}

// 12. Multi-charge scaling
{
  const room1 = makeRoom();
  const room2 = makeRoom();
  const one = makeShip('one', 'blue', 0, 0, chargeDesign());
  const two = makeShip('two', 'blue', 0, 0, multiChargeDesign());
  const enemy1 = makeShip('e1', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  const enemy2 = makeShip('e2', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  room1.ships.set('one', one);
  room1.ships.set('e1', enemy1);
  room2.ships.set('two', two);
  room2.ships.set('e2', enemy2);
  detonateProximityCharge(room1, one, 1, 0, true, enemy1, { x: 0, y: 8, geometry: 'cell', t: 1 });
  detonateProximityCharge(room2, two, 2, 0, true, enemy2, { x: 0, y: 8, geometry: 'cell', t: 1 });
  const loss1 = enemy1.maxHp - enemy1.hp;
  const loss2 = enemy2.maxHp - enemy2.hp;
  assert.ok(loss2 > loss1 * 1.35, 'two charges deal more than one charge');
  assert.ok(two.proximityChargeDetonated[2] === 1 && two.proximityChargeDetonated[3] === 1, 'both charges consumed');
}

// 13. Movement target aims at nearest enemy hull point
{
  const room = makeRoom();
  const carrier = makeShip('c', 'blue', 10, 20, chargeDesign());
  const enemy = makeShip('e', 'red', 0, 0, largeDesign(), { angle: Math.PI / 2 });
  room.ships.set('e', enemy);
  const nearest = nearestDemolitionTargetPoint(carrier, enemy);
  assert.ok(Number.isFinite(nearest.x) && Number.isFinite(nearest.y), 'nearest point is finite');
  assert.notEqual(nearest.x, enemy.x, 'nearest point is not bare centre when hull cells differ');
}

// 14. Operational charge status disables when charge destroyed
{
  const carrier = makeShip('c', 'blue', 0, 0, chargeDesign());
  assert.equal(armedProximityChargeRanges(carrier).armed, true, 'armed by default');
  carrier.componentHp[1] = 0;
  assert.equal(armedProximityChargeRanges(carrier).armed, false, 'charge disabled after component destroyed');
}

// 15. Heavy charge has no component cap; small charge retains its 12-component cap
{
  const room1 = makeRoom();
  const room2 = makeRoom();
  const heavy = makeShip('heavy', 'blue', 0, 0, chargeDesign());
  const small = makeShip('small', 'blue', 0, 0, smallChargeDesign());
  const heavyTarget = makeShip('heavy-target', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  const smallTarget = makeShip('small-target', 'red', 0, 60, largeDesign(), { maxHp: 100000 });
  room1.ships.set(heavy.id, heavy);
  room1.ships.set(heavyTarget.id, heavyTarget);
  room2.ships.set(small.id, small);
  room2.ships.set(smallTarget.id, smallTarget);
  const heavyBefore = heavyTarget.componentHp.slice();
  const smallBefore = smallTarget.componentHp.slice();
  detonateProximityCharge(room1, heavy, 1, 0, true, heavyTarget, { x: 0, y: 8, geometry: 'cell', t: 1 });
  detonateProximityCharge(room2, small, 1, 0, true, smallTarget, { x: 0, y: 8, geometry: 'cell', t: 1 });
  assert.equal(heavyTarget.componentHp.filter((hp, index) => hp < heavyBefore[index]).length, heavyTarget.design.length, 'heavy charge damages every component without a cap');
  assert.equal(smallTarget.componentHp.filter((hp, index) => hp < smallBefore[index]).length, 12, 'small charge remains capped at 12 components');
}

// 16. Small charge protects friendly ships; heavy charge retains friendly fire
{
  const smallRoom = makeRoom();
  const small = makeShip('small', 'blue', 0, 0, smallChargeDesign());
  const smallEnemy = makeShip('small-enemy', 'red', 0, 0, basicDesign());
  const smallAlly = makeShip('small-ally', 'ally', 40, 0, basicDesign());
  smallRoom.ships.set(small.id, small);
  smallRoom.ships.set(smallEnemy.id, smallEnemy);
  smallRoom.ships.set(smallAlly.id, smallAlly);
  const smallAllyHp = smallAlly.hp;
  resolveDemolitionContacts(smallRoom, [small, smallEnemy, smallAlly], 0);
  assert.equal(smallAlly.hp, smallAllyHp, 'small charge does not damage friendly ships');

  const heavyRoom = makeRoom();
  const heavy = makeShip('heavy', 'blue', 0, 0, chargeDesign());
  const heavyEnemy = makeShip('heavy-enemy', 'red', 0, 0, basicDesign());
  const heavyAlly = makeShip('heavy-ally', 'ally', 40, 0, basicDesign());
  heavyRoom.ships.set(heavy.id, heavy);
  heavyRoom.ships.set(heavyEnemy.id, heavyEnemy);
  heavyRoom.ships.set(heavyAlly.id, heavyAlly);
  const heavyAllyHp = heavyAlly.hp;
  resolveDemolitionContacts(heavyRoom, [heavy, heavyEnemy, heavyAlly], 0);
  assert.ok(heavyAlly.hp < heavyAllyHp, 'heavy charge still damages friendly ships');
}

// 17. Balance values are authoritative
{
  const balance = require('./public/component-balance.generated.json');
  const heavy = balance.components.find((c) => c.id === 'proximityDemolitionCharge');
  const small = balance.components.find((c) => c.id === 'demolitionCharge');
  assert.ok(heavy && small, 'both demolition charges exist in balance');
  assert.equal(heavy.proximityCharge.centreDamage, 8000, 'heavy centre damage');
  assert.equal(heavy.proximityCharge.maxAffectedComponents, null, 'heavy has no affected-component cap');
  assert.equal(heavy.proximityCharge.blastRadius, 420, 'heavy blast radius');
  assert.equal(heavy.proximityCharge.damagesFriendlyShips, true, 'heavy retains friendly fire');
  assert.equal(small.proximityCharge.maxAffectedComponents, 12, 'small retains 12-component cap');
  assert.equal(small.proximityCharge.damagesFriendlyShips, false, 'small protects friendly ships');
}

// 18. Charge always closes to contact; the payload controls impact speed.
//
// A demolition ship IS the weapon, so it drives until the hulls touch and lets
// the trigger radius do the rest. Take the charge away and the same stance still
// closes -- it is the stance the player picked, not a consequence of the
// loadout -- but without a payload it uses the ordinary arrival controller
// instead of retaining ram speed.
//
// Asserted on the destination the stance produces rather than on a flown
// trajectory: these fixtures carry no engine or turn stats, so the hull cannot
// actually go anywhere.
{
  const room = makeRoom();
  const carrier = makeShip('movement-carrier', 'blue', 300, 500, chargeDesign());
  const enemy = makeShip('movement-enemy', 'red', 900, 500, basicDesign());
  carrier.combatStyle = 'charge';
  carrier.combatTargetId = enemy.id;
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);

  const standoff = () => {
    updateShipMovement(room, carrier, 1 / 30, 1000);
    const destination = carrier.movement.destination;
    assert.ok(destination, 'a charging ship should be given somewhere to be');
    return Math.hypot(destination.x - enemy.x, destination.y - enemy.y);
  };
  const hull = physicalCollisionRadius(carrier) + physicalCollisionRadius(enemy);

  const contactDestination = Math.max(0, hull - ARRIVE_DISTANCE);
  assert.ok(armedProximityChargeRanges(carrier).armed, 'the carrier starts armed');
  const armedDestination = standoff();
  assert.ok(Math.abs(armedDestination - contactDestination) < 1e-6,
    `an armed demolition ship commands through the arrival radius (${armedDestination.toFixed(1)} px vs ${contactDestination.toFixed(1)})`);
  assert.equal(carrier.movement.ramming, true, 'the armed final leg retains ram speed');

  carrier.componentHp[1] = 0;
  assert.ok(!armedProximityChargeRanges(carrier).armed, 'the charge is gone once destroyed');
  const ordinaryDestination = standoff();
  assert.ok(Math.abs(ordinaryDestination - contactDestination) < 1e-6,
    `a ship whose charge is gone still closes to contact (${ordinaryDestination.toFixed(1)} px vs ${contactDestination.toFixed(1)})`);
  assert.equal(carrier.movement.ramming, false, 'without a payload the final leg uses normal braking');
}

// 19. Demolition charges acquire, contact, and damage station hulls.
{
  const room = makeRoom();
  const carrier = makeShip('station-carrier', 'blue', 25, 0, chargeDesign());
  const station = {
    id: 'enemy-station',
    entityType: 'station',
    stationType: 'relay',
    team: 'b',
    ownerId: 'red',
    alive: true,
    state: 'operational',
    x: 100,
    y: 0,
    angle: 0,
    radius: 100,
    collisionPieces: [{
      x: 100,
      y: 0,
      angle: 0,
      halfWidth: 20,
      halfHeight: 80,
      radius: 83
    }],
    design: [{ x: 7, y: 7, type: 'frame' }],
    componentHp: [100000],
    componentMaxHp: [100000],
    hp: 100000,
    maxHp: 100000,
    shield: 5000,
    maxShield: 5000,
    dirtyComponents: new Set(),
    healthRevision: 1,
    stateRevision: 1
  };
  room.ships.set(carrier.id, carrier);
  room.stations = [station];
  const aim = nearestDemolitionTargetPoint(carrier, station);
  assert.equal(aim.x, 80, 'demolition movement aims at the nearest solid station surface');
  resolveDemolitionContacts(room, [carrier], 0);
  assert.equal(carrier.alive, false, 'enemy station proximity detonates the carrier');
  assert.ok(station.hp < station.maxHp, 'station hull takes demolition damage');
  assert.equal(station.shield, station.maxShield, 'demolition blast bypasses station shields like ship shields');
}

console.log('Demolition charge verification passed');
