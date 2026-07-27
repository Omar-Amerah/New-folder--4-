#!/usr/bin/env node
'use strict';

const { resolveDemolitionContacts, detonateProximityCharge } = require('../src/server/combat');
const { initComponentState, initProximityChargeState } = require('../src/server/componentHealth');

function makePlayers() {
  return new Map([['blue', { id: 'blue', team: 'a' }], ['red', { id: 'red', team: 'b' }]]);
}
function makeShip(id, ownerId, x, y, design, extra = {}) {
  const ship = {
    id, ownerId, alive: true, x, y, vx: 0, vy: 0, angle: extra.angle || 0,
    focusTargetId: null, combatTargetId: null, commandState: 'mainCore',
    targetX: x, targetY: y, arrived: true, isManualMove: false,
    stats: { maxHp: extra.maxHp || 0, unitCost: 100, radius: 20 },
    design, dirtyComponents: new Set(),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    dirtyPower: false, powerRevision: 1, dirtyComponentsVisual: false,
    shield: extra.shield || 0, maxShield: extra.maxShield || 0
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
function makeRoom() { return { players: makePlayers(), ships: new Map(), drones: new Map(), bullets: [], effects: [], points: [], map: { asteroids: [] }, rules: { gameMode: 'teams' }, world: { width: 2000, height: 2000 }, disableSpatialIndex: true }; }
function largeDesign() { const d=[{x:7,y:7,type:'core'}]; for(let i=0;i<12;i++){d.push({x:6-i,y:7,type:'frame'});} return d; }
function chargeDesign() { return [{x:7,y:7,type:'core'},{x:5,y:7,type:'proximityDemolitionCharge'}]; }
const room = makeRoom();
const carrier = makeShip('c','blue',0,0,chargeDesign());
const enemy = makeShip('e','red',0,0,largeDesign(),{shield:2000,maxShield:2000,maxHp:100000});
room.ships.set('c',carrier); room.ships.set('e',enemy);
console.log('before', carrier.x, carrier.y, enemy.x, enemy.y, 'hp', enemy.hp, 'shield', enemy.shield);
resolveDemolitionContacts(room,[carrier,enemy],0);
console.log('after', 'carrier alive', carrier.alive, 'enemy hp', enemy.hp, 'shield', enemy.shield, 'detonated', carrier.proximityChargeDetonated);
