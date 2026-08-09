"use strict";
const assert = require('assert/strict');
const EventEmitter = require('events');
const { decode } = require('@msgpack/msgpack');
const outbound = require('../src/server/outbound');
const delivery = require('../src/server/snapshotDelivery');
const { createRuntimeShip, destroyComponent } = require('./fixtures/dataSupportRuntimeHarness');
const { updateRuntimeShield } = require('../src/server/runtimeShield');
const { computeStats } = require('../src/server/shipStats');
const { PARTS } = require('../src/server/components');

class Socket extends EventEmitter {
  constructor(pattern) {
    super();
    this.pattern = pattern.slice();
    this.destroyed = false;
    this.writes = [];
  }
  write() {
    return this.pattern.length ? this.pattern.shift() : true;
  }
}

function makePlayer(id) {
  return { id, name: id, color: '#39f', team: 'blue', isBot: false, connected: true, ready: false, money: 0, income: 0, earned: 0, spent: 0, shipCap: 5, deployedFleetCost: 0, destroyedEnemyCost: 0, lastReward: 0, kills: 0, losses: 0, captures: 0, ships: [], design: [{ type: 'core' }], stats: { unitCost: 1 }, shipsBuilt: 0, lostFleetCost: 0, rallyPoint: { x: 0, y: 0 } };
}

function attach(r, id, pattern) {
  const socket = new Socket(pattern);
  const client = { id, socket, isClosed: false, room: r, player: r.players.get(id) };
  r.clients.add(client);
  return client;
}

async function mergeWritten(writes) {
  const m = await import('../public/src/snapshotMerge.js');
  let snap = null;
  let net = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false };
  let prev = 0;
  for (const packet of writes) {
    if (packet.snapshotKind === 'compact') {
      assert.equal(packet.snapshotSeq, prev + 1, `${packet.snapshotSeq} not contiguous from ${prev}`);
      assert.equal(packet.baseSnapshotSeq, prev, 'compact base must equal previous accepted');
    }
    const res = m.mergeSnapshotTransaction(snap, net, packet);
    assert.equal(res.ok, true, `${res.reason} ${JSON.stringify(packet)}`);
    snap = res.snapshot;
    net = res.networkState;
    prev = net.snapshotSeq;
  }
  return snap;
}

function makeRoomWithShieldShip() {
  const design = [{ type: 'core', x: 0, y: 0 }, { type: 'reactor', x: 1, y: 0 }, { type: 'shield', x: 2, y: 0 }];
  const fixture = { key: 'shield-live', name: 'Shield live test', design, dataLinks: [], stats: { maxHp: 1000 } };
  const ship = createRuntimeShip(fixture);
  ship.id = 's1';
  ship.ownerId = 'pa';
  ship.x = 50;
  ship.y = 50;
  ship.vx = 0;
  ship.vy = 0;
  ship.angle = 0;
  ship.alive = true;
  ship.maxHp = ship.stats?.maxHp || 1000;
  ship.hp = ship.maxHp;
  ship.shield = 50;
  ship.weaponAngles = [0];
  ship.weaponCooldowns = [];
  ship.weaponEnabled = [];
  ship.commandState = 'mainCore';
  ship.rallyPoint = { x: 0, y: 0 };
  const pa = makePlayer('pa');
  const pb = makePlayer('pb');
  pa.ships.push(ship);
  ship.stats = computeStats(design);
  return {
    code: 'R', phase: 'active', adminId: 'pa', stateEpoch: 1, snapshotSeq: 0, staticRevision: 1, componentCatalogueRevision: 1,
    mapSizeLabel: 'tiny', world: { width: 100, height: 100 }, map: { seed: 1, asteroids: [] }, rules: { gameMode: 'solo' },
    winner: null, matchStartedAt: 1, bullets: [], effects: [], points: [], controlVictory: null,
    players: new Map([[pa.id, pa], [pb.id, pb]]), ships: new Map([[ship.id, ship]]), clients: new Set(), _effectSpare: []
  };
}

outbound.configureOutbound({
  writeFrame(socket, payload) {
    const packet = decode(payload);
    socket.writes.push(packet);
    return socket.pattern.length ? socket.pattern.shift() : true;
  }
});

(async () => {
  const r = makeRoomWithShieldShip();
  const a = attach(r, 'pa', [true, true, true, true]);
  const b = attach(r, 'pb', [true, true, true, true]);

  // Establish a full baseline for both clients.
  delivery.broadcastSnapshot(r, 1, true);
  const baselineA = await mergeWritten(a.socket.writes);
  const baselineB = await mergeWritten(b.socket.writes);
  const baseShipA = baselineA.ships.find((s) => s.id === 's1');
  const baseShipB = baselineB.ships.find((s) => s.id === 's1');
  assert.ok(baseShipA, 'owner sees ship in baseline');
  assert.ok(baseShipB, 'non-owner sees ship in baseline');
  assert.equal(baseShipA.maxShield, baseShipB.maxShield, 'baseline maxShield visible to both clients');

  // Apply a real gameplay change: destroy the shield module. The cache must miss
  // and the new maxShield must be sent in the next compact snapshots.
  const ship = r.ships.get('s1');
  destroyComponent(ship, 2);
  updateRuntimeShield(ship, 1 / 30, 1000, r);
  const maxAfter = ship.maxShield;

  delivery.broadcastSnapshot(r, 2);
  const compactA = await mergeWritten(a.socket.writes);
  const compactB = await mergeWritten(b.socket.writes);
  const compactShipA = compactA.ships.find((s) => s.id === 's1');
  const compactShipB = compactB.ships.find((s) => s.id === 's1');
  assert.equal(compactShipA.maxShield, maxAfter, 'compact snapshot sends new maxShield to owner');
  assert.equal(compactShipB.maxShield, maxAfter, 'compact snapshot sends new maxShield to observer');
  assert.equal(compactShipA.shield, ship.shield, 'shield value also updated live');

  // Reconnect client b with a full snapshot and confirm it matches the continuing client.
  delivery.sendFullSnapshot(b, 3, 'reconnect');
  const fullB = await mergeWritten(b.socket.writes);
  const fullShipB = fullB.ships.find((s) => s.id === 's1');
  assert.equal(fullShipB.maxShield, maxAfter, 'reconnect full snapshot has new maxShield');
  assert.equal(fullShipB.shield, ship.shield, 'reconnect full snapshot has current shield');

  console.log('verify-shield-cache-live: OK');
})().catch((e) => { console.error(e); process.exit(1); });
