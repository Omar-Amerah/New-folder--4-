"use strict";

// Focused Phase 5 behavioural verifier.  It exercises the production snapshot
// delivery path and the browser merge transaction; the benchmark below covers
// the wider workload matrix.

const assert = require("assert");
const { EventEmitter } = require("events");
const { decode } = require("@msgpack/msgpack");
const flags = require("./src/server/performanceFlags");
const delivery = require("./src/server/snapshotDelivery");
const outbound = require("./src/server/outbound");
const { protocolInfo, negotiate } = require("./src/server/protocol");

class Socket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }
}

function player(id, team = "blue") {
  return {
    id, name: id, color: team === "blue" ? "#39f" : "#f66", team, isBot: false,
    connected: true, ready: true, money: 1000, income: 10, earned: 20, spent: 0,
    shipCap: 20, deployedFleetCost: 0, destroyedEnemyCost: 0, lastReward: 0,
    kills: 0, losses: 0, captures: 0, ships: [], design: [{ type: "core" }],
    stats: { unitCost: 1 }, shipsBuilt: 0, lostFleetCost: 0, rallyPoint: null
  };
}

function ship(id, ownerId, team, x = 50, y = 50) {
  return {
    id, ownerId, team, designRevision: 1, componentAliveRevision: 0,
    componentDamageRevision: 0, proximityChargeRevision: 0, x, y, vx: 0, vy: 0,
    angle: 0, turnActivity: 0, targetX: x, targetY: y, combatStyle: "hold",
    movementToggles: {}, hp: 100, maxHp: 100, shield: 25, maxShield: 25, radius: 12,
    cost: 1, focusTargetId: null, combatTargetId: null, weaponAngles: [0],
    commandState: "mainCore", emergencyReserveUntil: null, alive: true,
    commandAuraActive: false, commandAuraReceived: false, proximityChargeDetonated: [],
    blasterRange: 0, missileRange: 0, railgunRange: 0, beamRange: 0, weaponRanges: [],
    beamRadius: 0, sensorRange: 0, sensorCones: [], respawnIn: 0, removeIn: 0,
    heat: 0, heatNow: 0, heatMax: 100, hot: 0, overheated: 0, heatRevision: 0,
    componentHeatRevision: 0, heatStateRevision: 0, heatTelemetryRevision: 0,
    powerRuntimeRevision: 0, stats: { unitCost: 1, radius: 12 },
    design: [{ type: "core" }, { type: "engine" }], componentHp: [100, 100],
    componentMaxHp: [100, 100], componentHeat: [0, 0], componentHeatState: [0, 0],
    componentThermals: [{ capacity: 10 }, { capacity: 10 }], dirtyComponents: new Set(),
    dirtyHeat: new Set(), removed: false, blockedEngineIndices: new Set(),
    weaponProfileCache: null
  };
}

function roomFixture({ visibilityMode = "none", ships = 2, projectiles = 0 } = {}) {
  const blue = player("p1", "blue");
  const red = player("p2", "red");
  const room = {
    code: "P5", phase: "active", adminId: blue.id, stateEpoch: 1, snapshotSeq: 0,
    staticRevision: 1, componentCatalogueRevision: 1, mapSizeLabel: "tiny",
    world: { width: 2000, height: 2000 }, map: { asteroids: [], relays: [] },
    rules: { gameMode: "teams", visibilityMode }, winner: null, matchStartedAt: 1,
    simulationTimeMs: 1000, bullets: [], effects: [], points: [], stations: [],
    stationsById: new Map(), players: new Map([[blue.id, blue], [red.id, red]]),
    ships: new Map(), drones: new Map(), decoys: new Map(), clients: new Set(),
    droneCounts: { byOwner: new Map(), byParent: new Map() }, controlVictory: null
  };
  const blueShips = [];
  for (let index = 0; index < ships; index += 1) {
    const owner = index % 2 === 0 ? blue : red;
    const entity = ship(`s${index + 1}`, owner.id, owner.team, 50 + index * 100, 50);
    owner.ships.push(entity);
    room.ships.set(entity.id, entity);
    blueShips.push(entity);
  }
  for (let index = 0; index < projectiles; index += 1) room.bullets.push({ id: `b${index}`, type: "bolt", subtype: null, ownerId: blue.id, x: 10 + index, y: 20, vx: 1, vy: 0, bornAt: 900 });
  return { room, blue, red, ships: blueShips };
}

function attach(room, playerId = "p1", capabilities = []) {
  const socket = new Socket();
  const client = {
    id: `c-${playerId}-${Math.random().toString(16).slice(2)}`,
    socket, isClosed: false, room, player: room.players.get(playerId),
    protocol: { capabilities }, telemetryFocusShipId: null
  };
  room.clients.add(client);
  return client;
}

function packetList(client) {
  return client.socket.writes;
}

function lastPacket(client) {
  return packetList(client)[packetList(client).length - 1];
}

async function mergePackets(packets) {
  const merge = await import("./public/src/snapshotMerge.js");
  let snapshot = null;
  let networkState = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false };
  for (const packet of packets) {
    const result = merge.mergeSnapshotTransaction(snapshot, networkState, packet);
    assert.equal(result.ok, true, result.reason || "snapshot merge failed");
    snapshot = result.snapshot;
    networkState = result.networkState;
  }
  return { merge, snapshot, networkState };
}

function setupOutboundCapture() {
  outbound.configureOutbound({
    writeFrame(socket, payload) {
      socket.writes.push(decode(payload));
      return true;
    }
  });
}

function modernCapabilities() {
  return ["messagepack", "entityDeltaSnapshotsV1", "projectileEventsV1"];
}

async function run() {
  setupOutboundCapture();
  assert.equal(flags.ENTITY_DELTA_SNAPSHOTS(), false, "ENTITY_DELTA_SNAPSHOTS defaults off");
  assert.ok(protocolInfo().capabilities.includes("entityDeltaSnapshotsV1"));
  assert.equal(negotiate({ protocolVersion: 5, capabilities: ["messagepack"] }).ok, true);
  flags.__setENTITY_DELTA_SNAPSHOTS(true);

  // 1-5: capability and baseline negotiation.
  {
    const { room } = roomFixture({ ships: 1 });
    const legacy = attach(room, "p1", ["messagepack"]);
    delivery.sendFullSnapshot(legacy, 1000, "reconnect");
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    assert.equal(packetList(legacy)[0].snapshotFormatVersion, 1, "legacy full uses v1");
    assert.equal(lastPacket(legacy).snapshotFormatVersion, 1, "legacy compact uses v1");
  }
  {
    const { room, ships } = roomFixture({ ships: 1, projectiles: 1 });
    const modern = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(modern, 1000, "reconnect");
    const full = packetList(modern)[0];
    assert.equal(full.snapshotFormatVersion, 2, "modern full explicitly reports v2");
    assert.ok(Array.isArray(full.ships) && full.ships[0].design, "v2 full is independently usable");
    const baseline = await mergePackets([full]);
    ships[0].x += 4;
    ships[0].y += 2;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    const compact = lastPacket(modern);
    assert.equal(compact.snapshotFormatVersion, 2);
    assert.equal(compact.shipsPatch.upsert.length, 0, "motion does not resend design baseline");
    assert.equal(compact.shipsPatch.motion.length, 1);
    const merged = await mergePackets(packetList(modern));
    assert.equal(merged.snapshot.ships[0].x, ships[0].x);
    assert.strictEqual(merged.snapshot.ships[0].design, baseline.snapshot.ships[0].design, "unchanged design is shared");
  }

  // 6-17: envelope, atomic validation, sequence and epoch safety.
  {
    const { room } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const full = lastPacket(client);
    const { merge, snapshot, networkState } = await mergePackets([full]);
    const compact = {
      type: "state", stateEpoch: 1, snapshotSeq: 2, snapshotKind: "compact", snapshotFormatVersion: 2,
      baseSnapshotSeq: 1, staticRevision: 1, simulationTimeMs: 1050, roomPatch: {},
      playersPatch: { upsert: [], remove: [] },
      shipsPatch: { motion: [], state: [], private: [], upsert: [], remove: [], clearPrivate: [] },
      dronesPatch: { motion: [], state: [], upsert: [], remove: [] }, decoysPatch: { motion: [], state: [], upsert: [], remove: [] },
      stationsPatch: { dynamic: [], state: [], upsert: [], remove: [] }, pointsPatch: { upsert: [], remove: [] }, effectsPatch: { motion: [], state: [], upsert: [], remove: [] }, contacts: []
    };
    assert.equal(merge.inspectSnapshotEnvelope(networkState, { ...compact, baseSnapshotSeq: 99 }).reason, "wrong-base");
    assert.equal(merge.inspectSnapshotEnvelope(networkState, { ...compact, snapshotSeq: 3 }).reason, "sequence-gap");
    assert.equal(merge.inspectSnapshotEnvelope({ ...networkState, snapshotSeq: 2 }, { ...compact, snapshotSeq: 1 }).reason, "stale-sequence");
    assert.equal(merge.inspectSnapshotEnvelope({ ...networkState, stateEpoch: 2 }, { ...compact, stateEpoch: 1 }).reason, "stale-epoch");
    assert.equal(merge.mergeSnapshotTransaction(snapshot, networkState, compact).ok, true);
    assert.equal(merge.mergeSnapshotTransaction(snapshot, { ...networkState, snapshotSeq: 2 }, compact).reason, "duplicate-sequence");
    for (const bad of [
      { ...compact, shipsPatch: { ...compact.shipsPatch, motion: [["s1", 1]] } },
      { ...compact, shipsPatch: { ...compact.shipsPatch, motion: [["s1", 1, 2, 3, 4, 5, 6, 7, 8, NaN]] } },
      { ...compact, shipsPatch: { ...compact.shipsPatch, motion: [["unknown", 1, 2, 3, 4, 5, 6, 7, 8]] } },
      { ...compact, shipsPatch: { ...compact.shipsPatch, motion: [["s1", 1, 2, 3, 4, 5, 6, 7, 8], ["s1", 1, 2, 3, 4, 5, 6, 7, 8]] } },
      { ...compact, shipsPatch: { ...compact.shipsPatch, upsert: [{ id: "s1", detail: "full" }], state: [["s1", { hp: 99 }]] } },
      { ...compact, shipsPatch: { ...compact.shipsPatch, remove: ["s1"], motion: [["s1", 1, 2, 3, 4, 5, 6, 7, 8]] } }
    ]) {
      const result = merge.mergeSnapshotTransaction(snapshot, networkState, bad);
      assert.equal(result.ok, false);
      assert.strictEqual(snapshot.ships[0].x, full.ships[0].x, "failed patch leaves prior snapshot untouched");
    }
    const validCombined = {
      ...compact,
      shipsPatch: {
        ...compact.shipsPatch,
        motion: [["s1", 1, 2, 0, 0, 0, 0, 1, 1]],
        state: [["s1", { hp: 99 }]],
        private: [["s1", { powerRevision: 1 }]]
      }
    };
    assert.equal(merge.mergeSnapshotTransaction(snapshot, networkState, validCombined).ok, true, "motion/state/private may share a full-detail ship");
  }

  // 18-28: entity lifecycle, visibility, permission transitions and cleanup.
  {
    const { room, ships, red } = roomFixture({ ships: 2 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const full = lastPacket(client);
    ships[1].removed = true;
    room.ships.delete(ships[1].id);
    red.ships.length = 0;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    const removal = lastPacket(client);
    assert.ok(removal.shipsPatch.remove.includes(ships[1].id), "destroyed ship has an explicit removal");
    const merged = await mergePackets(packetList(client));
    assert.equal(merged.snapshot.ships.some((entry) => entry.id === ships[1].id), false);
    assert.ok(client.snapshotEntityState.ships.size <= 1, "removed ship is pruned from server delta state");
    assert.ok(full.ships.some((entry) => entry.id === "s1"));
  }
  {
    const { room, ships } = roomFixture({ ships: 2, visibilityMode: "sensors" });
    const client = attach(room, "p1", modernCapabilities());
    ships[0].design = [{ type: "core" }, { type: "largeSensor" }];
    ships[0].componentHp = [100, 100];
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    // Make the enemy unavailable to the viewer's sensor generation.
    ships[1].x = 1900; ships[1].y = 1900;
    room._visibilityGeneration = (room._visibilityGeneration || 1) + 1;
    room.simulationTimeMs += 1200;
    delivery.broadcastSnapshot(room, 2200);
    room.simulationTimeMs += 400;
    delivery.broadcastSnapshot(room, 2600);
    const hide = lastPacket(client);
    assert.ok(hide.shipsPatch.remove.includes(ships[1].id), "hidden ship has an explicit removal");
    ships[1].x = ships[0].x + 1; ships[1].y = ships[0].y;
    room._visibilityGeneration += 1;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 2250);
    const reacquire = lastPacket(client);
    assert.ok(reacquire.shipsPatch.upsert.some((entry) => entry.id === ships[1].id), "reacquisition sends a fresh baseline");
  }
  {
    const { room, ships } = roomFixture({ ships: 2 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const enemy = ships[1];
    enemy.componentPower = { byComponentIndex: [{ state: "on", networkId: "n", operationalMultiplier: 1 }] };
    enemy.powerRevision = 1;
    enemy.powerStatus = { state: "ok" };
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    // In solo/team policy this fixture keeps both ships allied only when the
    // viewer is changed; exercise the merge authority directly as well.
    const merge = await import("./public/src/snapshotMerge.js");
    const fullState = packetList(client)[0];
    const publicUpsert = { id: "s1", detail: "public", x: 1, y: 1 };
    const base = merge.mergeSnapshotTransaction(null, { stateEpoch: 0, snapshotSeq: 0, hasFullBaseline: false }, { ...fullState, ships: [{ ...fullState.ships[0], componentPower: { secret: true }, chp: [1], detail: "full" }] });
    assert.equal(base.ok, true);
    const transition = {
      type: "state", stateEpoch: 1, snapshotSeq: 2, snapshotKind: "compact", snapshotFormatVersion: 2, baseSnapshotSeq: 1, staticRevision: 1,
      roomPatch: {}, playersPatch: { upsert: [], remove: [] }, shipsPatch: { motion: [], state: [], private: [], upsert: [publicUpsert], remove: [], clearPrivate: ["s1"] },
      dronesPatch: { motion: [], state: [], upsert: [], remove: [] }, decoysPatch: { motion: [], state: [], upsert: [], remove: [] }, stationsPatch: { dynamic: [], state: [], upsert: [], remove: [] }, pointsPatch: { upsert: [], remove: [] }, effectsPatch: { motion: [], state: [], upsert: [], remove: [] }, contacts: []
    };
    const redacted = merge.mergeSnapshotTransaction(base.snapshot, base.networkState, transition);
    assert.equal(redacted.ok, true);
    assert.equal(redacted.snapshot.ships[0].componentPower, undefined, "detail downgrade clears private fields");
  }
  {
    const { room } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const firstState = client.snapshotEntityState;
    room.stateEpoch = 2;
    room.simulationTimeMs = 1;
    delivery.broadcastSnapshot(room, 1, true);
    assert.equal(client.snapshotBaseline.lastWrittenSeq, room.snapshotSeq);
    assert.notStrictEqual(client.snapshotEntityState, firstState, "epoch reset clears entity knowledge");
    assert.equal(client.snapshotEntityState.stateEpoch, 2);
  }

  // 29-40: sparse fields, stations/points/effects and viewer-specific state.
  {
    const { room, ships } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    ships[0].x += 1;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    const motion = lastPacket(client);
    assert.equal(motion.shipsPatch.private.length, 0, "motion does not resend private state");
    ships[0].componentHp[0] = 50;
    ships[0].componentDamageRevision = 1;
    ships[0].dirtyComponents.add(0);
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1100);
    const damage = lastPacket(client);
    assert.ok(damage.shipsPatch.private.some(([id, value]) => id === ships[0].id && value.chpD), "HP change uses compact private delta");
    ships[0].dirtyComponents.clear();
    ships[0].componentHeat[1] = 8;
    ships[0].componentHeatRevision = 1;
    ships[0].dirtyHeat.add(1);
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1150);
    const heat = lastPacket(client);
    assert.ok(heat.shipsPatch.private.some(([id, value]) => id === ships[0].id && value.componentHeatD), "Heat change uses compact private delta");
    assert.equal(lastPacket(client).shipsPatch.upsert.length, 0, "unchanged design is not resent");
  }
  {
    const { room, ships } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    const target = ships[0];
    delivery.sendFullSnapshot(client, 1000, "reconnect");

    target.selfDestructStart = 1000;
    target.selfDestructAt = 2000;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    assert.ok(lastPacket(client).shipsPatch.state.some(([id, value]) => id === target.id && value.destructProgress !== undefined), "self-destruct progress is recognized state");

    target.selfDestructAt = 0;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1100);
    const cancelled = lastPacket(client);
    assert.ok(cancelled.shipsPatch.clearStateFields.some(([id, fields]) => id === target.id && fields.includes("destructProgress")), "self-destruct cancellation explicitly clears progress");

    target.blockedEngineIndices.add(1);
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1150);
    assert.ok(lastPacket(client).shipsPatch.state.some(([id, value]) => id === target.id && Array.isArray(value.engBlocked)), "engine block is recognized state");
    target.blockedEngineIndices.clear();
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1200);
    assert.ok(lastPacket(client).shipsPatch.clearStateFields.some(([id, fields]) => id === target.id && fields.includes("engBlocked")), "engine unblock explicitly clears state");

    target.droneBays = [{
      componentId: "bay-1", componentIndex: 0, droneType: "fighter", mode: "deployed",
      launchBlockedBySpawn: false, launchEdge: { centerX: 7, centerY: 7, dx: 0, dy: -1 }, slots: []
    }];
    target.decoyLaunchers = [{ componentIndex: 0, stock: 1, capacity: 2, productionProgress: 0, nextLaunchAt: 0 }];
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1250);
    assert.ok(lastPacket(client).shipsPatch.state.some(([id, value]) => id === target.id && value.droneBays && value.decoyLaunchers), "bay state is sent when it appears");
    target.droneBays = [];
    target.decoyLaunchers = [];
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1300);
    const baysCleared = lastPacket(client);
    const bayClear = baysCleared.shipsPatch.clearStateFields.find(([id]) => id === target.id);
    assert.ok(bayClear && bayClear[1].includes("droneBays") && bayClear[1].includes("decoyLaunchers"), "empty bays and launchers explicitly clear prior state");

    target.componentPower = { byComponentIndex: [{ state: "on", networkId: "n", operationalMultiplier: 1 }] };
    target.powerRevision = 1;
    target.powerStatus = { state: "ok" };
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1350);
    assert.ok(lastPacket(client).shipsPatch.private.some(([id, value]) => id === target.id && value.componentPower), "private power state appears");
    target.componentPower = null;
    target.powerRevision = 0;
    delete target.powerStatus;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1400);
    const privateCleared = lastPacket(client);
    assert.ok(privateCleared.shipsPatch.clearPrivateFields.some(([id, fields]) => id === target.id && fields.includes("componentPower")), "removed private power state is explicitly cleared");
    const cleared = await mergePackets(packetList(client));
    assert.equal(cleared.snapshot.ships[0].destructProgress, undefined, "merged cancellation removes self-destruct progress");
    assert.equal(cleared.snapshot.ships[0].engBlocked, undefined, "merged unblock removes engine block");
    assert.equal(cleared.snapshot.ships[0].droneBays, undefined, "merged empty bays remove old bays");
    assert.equal(cleared.snapshot.ships[0].componentPower, undefined, "merged private clear removes old power state");

    target.componentPower = { byComponentIndex: [{ state: "on", networkId: "n2", operationalMultiplier: 0.5 }] };
    target.powerRevision = 2;
    target.powerStatus = { state: "recovered" };
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1450);
    const reappeared = await mergePackets(packetList(client));
    assert.ok(reappeared.snapshot.ships[0].componentPower, "private field reappears after an explicit clear");
    assert.equal(reappeared.snapshot.ships[0].componentPower[0][2], 0.5);
  }
  {
    const { room, ships } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    room.points.push({ id: "point-1", x: 100, y: 100, radius: 20, ownerId: null, ownerTeam: null, contested: false, progress: 0 });
    room.effects.push({ id: "effect-1", type: "spark", x: 10, y: 10, at: 1000 });
    ships[0].x += 2;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    const created = lastPacket(client);
    assert.equal(created.pointsPatch.upsert.length, 1);
    assert.equal(created.effectsPatch.upsert.length, 1);
    room.points.length = 0; room.effects.length = 0;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1100);
    const removed = lastPacket(client);
    assert.ok(removed.pointsPatch.remove.includes("point-1"));
    assert.ok(removed.effectsPatch.remove.includes("effect-1"));
  }
  {
    const { room } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const effect = { id: "effect-mixed", type: "spark", x: 10, y: 10, at: 1000, customTag: "a" };
    room.effects.push(effect);
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    assert.equal(lastPacket(client).effectsPatch.upsert.length, 1);
    effect.x = 25;
    effect.customTag = "b";
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1100);
    const mixed = lastPacket(client);
    assert.ok(mixed.effectsPatch.state.some(([id, value]) => id === effect.id && value.x === 25), "recognized effect state remains sparse");
    assert.ok(mixed.effectsPatch.remaining.some(([id, value]) => id === effect.id && value.customTag === "b"), "unknown effect fields use a supplementary patch");
    assert.equal(mixed.effectsPatch.upsert.length, 0, "simultaneous recognized and unknown changes do not force a conflicting upsert");
    const merged = await mergePackets(packetList(client));
    const mergedEffect = merged.snapshot.effects.find((entry) => entry.id === effect.id);
    assert.equal(mergedEffect.x, 25);
    assert.equal(mergedEffect.customTag, "b");
    delete effect.customTag;
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1150);
    const unknownCleared = lastPacket(client);
    assert.ok(unknownCleared.effectsPatch.clearStateFields.some(([id, fields]) => id === effect.id && fields.includes("customTag")), "unknown field removal uses explicit state clear metadata");
    const afterUnknownClear = await mergePackets(packetList(client));
    assert.equal(afterUnknownClear.snapshot.effects.find((entry) => entry.id === effect.id).customTag, undefined);
  }

  // 41-50: outbound lifecycle and strict grouping.
  {
    const { room } = roomFixture({ ships: 1 });
    const client = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(client, 1000, "reconnect");
    const written = client.snapshotEntityState;
    const meta = { stateEpoch: 1, snapshotSeq: 99, snapshotKind: "compact", snapshotFormatVersion: 2, staticRevision: 1, payloadBytes: 10 };
    delivery.onSnapshotLifecycle(client, "queued", meta);
    assert.strictEqual(client.snapshotEntityState, written, "queued packet does not advance entity knowledge");
    delivery.onSnapshotLifecycle(client, "replaced", meta);
    assert.strictEqual(client.snapshotEntityState, written, "replaced packet does not advance entity knowledge");
    delivery.onSnapshotLifecycle(client, "dropped", meta);
    assert.strictEqual(client.snapshotEntityState, written, "dropped packet does not advance entity knowledge");
    const next = { ...meta, snapshotSeq: 100, entityState: { ...written } };
    delivery.onSnapshotLifecycle(client, "written", next);
    assert.equal(client.snapshotBaseline.lastWrittenSeq, 100);
  }
  {
    const { room } = roomFixture({ ships: 1 });
    const a = attach(room, "p1", modernCapabilities());
    const b = attach(room, "p1", modernCapabilities());
    room.disableSnapshotGrouping = false;
    delivery.broadcastSnapshot(room, 1000, true);
    assert.equal(packetList(a).length, 1);
    assert.equal(packetList(b).length, 1);
    assert.equal(packetList(a)[0].snapshotSeq, packetList(b)[0].snapshotSeq, "equivalent duplicate attachments share a sequence");
    assert.equal(packetList(a)[0].snapshotKind, "full", "control/initial baseline remains full");
  }

  // 51-54: projectile compatibility and capability fallback.
  {
    const { room } = roomFixture({ ships: 1, projectiles: 2 });
    const legacy = attach(room, "p1", ["messagepack"]);
    delivery.sendFullSnapshot(legacy, 1000, "reconnect");
    assert.ok(Array.isArray(lastPacket(legacy).bullets), "legacy bullet fallback remains available");
  }
  {
    const { room } = roomFixture({ ships: 1 });
    const modern = attach(room, "p1", modernCapabilities());
    delivery.sendFullSnapshot(modern, 1000, "reconnect");
    room.simulationTimeMs += 50;
    delivery.broadcastSnapshot(room, 1050);
    assert.equal(lastPacket(modern).snapshotFormatVersion, 2);
    assert.ok(lastPacket(modern).projectileEvents !== undefined || lastPacket(modern).bullets !== undefined, "projectile stream remains explicit");
  }

  flags.__setENTITY_DELTA_SNAPSHOTS(false);
  console.log("Phase 5 snapshot and network scaling verification passed");
}

run().catch((error) => {
  flags.__setENTITY_DELTA_SNAPSHOTS(false);
  console.error(error);
  process.exit(1);
});
